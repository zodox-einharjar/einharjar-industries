import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base

from ..auth.deps import get_current_character
from ..inventory.janice_parser import parse_janice_text
from ..inventory.simple_list_parser import parse_name_qty_text
from ..sde import portion_sizes, reprocessing_materials
from ..settings.router import _load_settings
from .optimizer import solve_ore_lp

router = APIRouter(prefix="/reprocessing", dependencies=[Depends(get_current_character)])


class OptimizeRequest(_Base):
    minerals_text: str
    supply_text: str        # ore and/or raw minerals available to buy, Janice paste format
    price_type: str         # "buy" | "sell" | "split"
    efficiency_pct: float | None = None


@router.post("/optimize")
async def optimize(body: OptimizeRequest):
    minerals, mineral_unresolved = parse_name_qty_text(body.minerals_text)
    mineral_id_set = {m["type_id"] for m in minerals}

    parsed_supply, supply_parse_errors = parse_janice_text(body.supply_text, body.price_type)
    supply_unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed_supply if not i["ok"]]
    supply_unpriced = [
        {"type_id": i["type_id"], "name": i["item_name"], "qty": i["qty"]}
        for i in parsed_supply if i["ok"] and i["unit_price"] <= 0
    ]
    supply_resolved = [i for i in parsed_supply if i["ok"] and i["unit_price"] > 0]

    if body.efficiency_pct is not None:
        efficiency = body.efficiency_pct / 100.0
    else:
        settings_data = await _load_settings()
        efficiency = settings_data.get("reprocessing_efficiency_pct", 90.63) / 100.0

    supply_type_ids = [i["type_id"] for i in supply_resolved]
    try:
        mats_by_type = reprocessing_materials(supply_type_ids)
        sizes_by_type = portion_sizes(supply_type_ids)
    except sqlite3.OperationalError:
        raise HTTPException(
            503,
            "Reprocessing data isn't in the local SDE yet — go to Settings → General "
            "and click \"Update SDE\", then try again.",
        )

    # Each pasted line can contribute up to two independent supply options:
    # reprocessing it (if it's ore/anything with reprocessing yield data), and/or
    # buying it outright (if it's itself one of the requested minerals — no
    # reprocessing loss). Both are modeled the same way for the LP: a "portion"
    # size, a cost per portion, and a mineral yield per portion.
    options: list[dict] = []
    for i in supply_resolved:
        tid = i["type_id"]
        portion = sizes_by_type.get(tid)
        yields = {m["material_type_id"]: m["quantity"] for m in mats_by_type.get(tid, [])}
        if portion and yields:
            max_batches = i["qty"] // portion
            if max_batches > 0:
                options.append({
                    "type_id": tid, "name": i["item_name"], "unit_price": i["unit_price"],
                    "mode": "reprocess", "portion": portion, "yields": yields,
                    "efficiency": efficiency, "max_batches": max_batches,
                })
        if tid in mineral_id_set and i["qty"] > 0:
            options.append({
                "type_id": tid, "name": i["item_name"], "unit_price": i["unit_price"],
                "mode": "direct", "portion": 1, "yields": {tid: 1},
                "efficiency": 1.0, "max_batches": i["qty"],
            })

    result = solve_ore_lp(minerals, options)

    return {
        **result,
        "efficiency_pct": efficiency * 100,
        "unpriced": supply_unpriced,
        "unknown": supply_unknown,
        "parse_errors": supply_parse_errors,
        "mineral_unresolved": mineral_unresolved,
    }
