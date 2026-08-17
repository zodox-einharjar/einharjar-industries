from math import ceil, floor

from fastapi import APIRouter, Depends
from pydantic import BaseModel as _Base
from scipy.optimize import linprog

from ..auth.deps import get_current_character
from ..inventory.janice_parser import parse_janice_text
from ..sde import portion_sizes, reprocessing_materials, type_id_by_name
from ..settings.router import _load_settings

router = APIRouter(prefix="/reprocessing", dependencies=[Depends(get_current_character)])


class OptimizeRequest(_Base):
    minerals_text: str
    ore_text: str
    price_type: str  # "buy" | "sell" | "split"
    efficiency_pct: float | None = None


def _parse_minerals(text: str) -> tuple[list[dict], list[str]]:
    """Parse 'Name<tab-or-space>Qty' lines. Returns ([{type_id, name, qty}], [unresolved lines])."""
    resolved = []
    unresolved = []
    for raw in text.strip().splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 2:
            parts = line.rsplit(None, 1)
        if len(parts) < 2:
            unresolved.append(line)
            continue
        name = parts[0].strip()
        try:
            qty = int(parts[1].replace(',', '').strip())
        except ValueError:
            unresolved.append(line)
            continue
        tid = type_id_by_name(name)
        if tid is None:
            unresolved.append(name)
            continue
        resolved.append({"type_id": tid, "name": name, "qty": qty})
    return resolved, unresolved


@router.post("/optimize")
async def optimize(body: OptimizeRequest):
    minerals, mineral_unresolved = _parse_minerals(body.minerals_text)

    parsed_ore, ore_parse_errors = parse_janice_text(body.ore_text, body.price_type)
    ore_unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed_ore if not i["ok"]]
    ore_unpriced = [
        {"type_id": i["type_id"], "name": i["item_name"], "qty": i["qty"]}
        for i in parsed_ore if i["ok"] and i["unit_price"] <= 0
    ]
    ore_resolved = [i for i in parsed_ore if i["ok"] and i["unit_price"] > 0]

    if body.efficiency_pct is not None:
        efficiency = body.efficiency_pct / 100.0
    else:
        settings_data = await _load_settings()
        efficiency = settings_data.get("reprocessing_efficiency_pct", 90.63) / 100.0

    ore_type_ids = [i["type_id"] for i in ore_resolved]
    mats_by_ore = reprocessing_materials(ore_type_ids)
    sizes_by_ore = portion_sizes(ore_type_ids)

    ores = []
    for i in ore_resolved:
        tid = i["type_id"]
        portion = sizes_by_ore.get(tid)
        yields = {m["material_type_id"]: m["quantity"] for m in mats_by_ore.get(tid, [])}
        if not portion or not yields:
            continue  # not reprocessable, or no SDE data for it
        max_batches = i["qty"] // portion
        if max_batches <= 0:
            continue
        ores.append({
            "type_id": tid, "name": i["item_name"], "unit_price": i["unit_price"],
            "portion": portion, "yields": yields, "max_batches": max_batches,
        })

    mineral_type_ids = [m["type_id"] for m in minerals]
    reachable = []
    unmet: list[dict] = []
    for m in minerals:
        tid = m["type_id"]
        max_supply = sum(o["max_batches"] * o["yields"].get(tid, 0) * efficiency for o in ores)
        if max_supply <= 0:
            unmet.append({
                "type_id": tid, "name": m["name"], "qty_needed": m["qty"],
                "qty_produced": 0, "shortfall": m["qty"],
            })
            continue
        # Cap the LP target at what's physically achievable so the problem is
        # always feasible — "buy every available unit of every contributing
        # ore" trivially satisfies every capped constraint at once.
        target = min(m["qty"], floor(max_supply))
        reachable.append({"type_id": tid, "name": m["name"], "qty_needed": m["qty"], "target": target})

    batches: dict[int, int] = {o["type_id"]: 0 for o in ores}

    if ores and reachable:
        c = [o["portion"] * o["unit_price"] for o in ores]
        A_ub = [
            [-(o["yields"].get(r["type_id"], 0) * efficiency) for o in ores]
            for r in reachable
        ]
        b_ub = [-r["target"] for r in reachable]
        bounds = [(0, o["max_batches"]) for o in ores]

        res = linprog(c, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")
        if res.success:
            for o, x in zip(ores, res.x):
                batches[o["type_id"]] = min(o["max_batches"], max(0, ceil(x - 1e-6)))

    def _recompute_produced() -> dict[int, int]:
        produced = {tid: 0 for tid in mineral_type_ids}
        for o in ores:
            b = batches[o["type_id"]]
            if b <= 0:
                continue
            for mtid, qty in o["yields"].items():
                if mtid in produced:
                    produced[mtid] += floor(b * qty * efficiency)
        return produced

    produced = _recompute_produced()

    # Flooring per ore type can leave a reachable mineral just under target —
    # top it up one batch at a time (cheapest ISK per unit of that mineral
    # among ore with remaining capacity) until covered or ore is exhausted.
    for r in reachable:
        tid = r["type_id"]
        while produced.get(tid, 0) < r["qty_needed"]:
            candidates = [
                o for o in ores
                if o["yields"].get(tid, 0) > 0 and batches[o["type_id"]] < o["max_batches"]
            ]
            if not candidates:
                break
            best = min(
                candidates,
                key=lambda o: (o["portion"] * o["unit_price"]) / (o["yields"][tid] * efficiency),
            )
            batches[best["type_id"]] += 1
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

    ore_to_buy = []
    total_cost = 0.0
    for o in ores:
        b = batches[o["type_id"]]
        if b <= 0:
            continue
        qty = b * o["portion"]
        line_cost = qty * o["unit_price"]
        total_cost += line_cost
        ore_to_buy.append({
            "type_id": o["type_id"], "name": o["name"], "qty": qty,
            "unit_price": o["unit_price"], "line_cost": line_cost,
        })
    ore_to_buy.sort(key=lambda r: -r["line_cost"])

    return {
        "ore_to_buy": ore_to_buy,
        "total_cost": total_cost,
        "minerals": mineral_rows,
        "unmet_minerals": unmet,
        "efficiency_pct": efficiency * 100,
        "ore_unpriced": ore_unpriced,
        "ore_unknown": ore_unknown,
        "ore_parse_errors": ore_parse_errors,
        "mineral_unresolved": mineral_unresolved,
    }
