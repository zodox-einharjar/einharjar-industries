import sqlite3
from math import ceil, floor

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from scipy.optimize import linprog

from ..auth.deps import get_current_character
from ..inventory.janice_parser import parse_janice_text
from ..inventory.simple_list_parser import parse_name_qty_text
from ..sde import portion_sizes, reprocessing_materials
from ..settings.router import _load_settings

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

    mineral_type_ids = [m["type_id"] for m in minerals]
    reachable = []
    unmet: list[dict] = []
    for m in minerals:
        tid = m["type_id"]
        max_supply = sum(o["max_batches"] * o["yields"].get(tid, 0) * o["efficiency"] for o in options)
        if max_supply <= 0:
            unmet.append({
                "type_id": tid, "name": m["name"], "qty_needed": m["qty"],
                "qty_produced": 0, "shortfall": m["qty"],
            })
            continue
        # Cap the LP target at what's physically achievable so the problem is
        # always feasible — "buy every available unit of every contributing
        # option" trivially satisfies every capped constraint at once.
        target = min(m["qty"], floor(max_supply))
        reachable.append({"type_id": tid, "name": m["name"], "qty_needed": m["qty"], "target": target})

    n = len(options)
    batches = [0] * n

    if n and reachable:
        c = [o["portion"] * o["unit_price"] for o in options]
        A_ub = [
            [-(o["yields"].get(r["type_id"], 0) * o["efficiency"]) for o in options]
            for r in reachable
        ]
        b_ub = [-r["target"] for r in reachable]
        bounds = [(0, o["max_batches"]) for o in options]

        res = linprog(c, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")
        if res.success:
            for idx, x in enumerate(res.x):
                batches[idx] = min(options[idx]["max_batches"], max(0, ceil(x - 1e-6)))

    def _recompute_produced() -> dict[int, int]:
        produced = {tid: 0 for tid in mineral_type_ids}
        for idx, o in enumerate(options):
            b = batches[idx]
            if b <= 0:
                continue
            for mtid, qty in o["yields"].items():
                if mtid in produced:
                    produced[mtid] += floor(b * qty * o["efficiency"])
        return produced

    produced = _recompute_produced()

    # Flooring per option can leave a reachable mineral just under target —
    # top it up one unit/batch at a time (cheapest ISK per unit of that
    # mineral among options with remaining capacity) until covered or supply
    # is exhausted.
    for r in reachable:
        tid = r["type_id"]
        while produced.get(tid, 0) < r["qty_needed"]:
            candidates = [
                idx for idx, o in enumerate(options)
                if o["yields"].get(tid, 0) > 0 and batches[idx] < o["max_batches"]
            ]
            if not candidates:
                break
            best = min(
                candidates,
                key=lambda idx: (options[idx]["portion"] * options[idx]["unit_price"])
                / (options[idx]["yields"][tid] * options[idx]["efficiency"]),
            )
            batches[best] += 1
            produced = _recompute_produced()

        if produced.get(tid, 0) < r["qty_needed"]:
            unmet.append({
                "type_id": tid, "name": r["name"], "qty_needed": r["qty_needed"],
                "qty_produced": produced.get(tid, 0),
                "shortfall": r["qty_needed"] - produced.get(tid, 0),
            })

    mineral_rows = [
        {
            "type_id": m["type_id"], "name": m["name"], "qty_needed": m["qty"],
            "qty_produced": produced.get(m["type_id"], 0),
            "surplus": max(0, produced.get(m["type_id"], 0) - m["qty"]),
        }
        for m in minerals
    ]

    items_to_buy = []
    total_cost = 0.0
    for idx, o in enumerate(options):
        b = batches[idx]
        if b <= 0:
            continue
        qty = b * o["portion"]
        line_cost = qty * o["unit_price"]
        total_cost += line_cost
        items_to_buy.append({
            "type_id": o["type_id"], "name": o["name"], "mode": o["mode"], "qty": qty,
            "unit_price": o["unit_price"], "line_cost": line_cost,
        })
    items_to_buy.sort(key=lambda r: -r["line_cost"])

    return {
        "items_to_buy": items_to_buy,
        "total_cost": total_cost,
        "minerals": mineral_rows,
        "unmet_minerals": unmet,
        "efficiency_pct": efficiency * 100,
        "unpriced": supply_unpriced,
        "unknown": supply_unknown,
        "parse_errors": supply_parse_errors,
        "mineral_unresolved": mineral_unresolved,
    }
