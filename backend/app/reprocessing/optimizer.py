from math import ceil, floor

from scipy.optimize import linprog

# Fields the LP itself consumes — stripped from an option before it's echoed back
# as a purchase line, so any extra tags a caller attaches (channel, location, a
# specific market order id, ...) pass through untouched.
_LP_INTERNAL_KEYS = {"portion", "yields", "efficiency", "max_batches"}


def solve_ore_lp(minerals: list[dict], options: list[dict]) -> dict:
    """Minimum-cost combination of supply options that jointly covers every mineral
    target at once.

    This is the key property a naive per-mineral "cheapest source" pick doesn't have:
    one option (e.g. a compressed ore) can yield several needed minerals per batch, so
    buying it credits *all* of them simultaneously instead of being priced out once per
    mineral and double-counted when the picks are later combined.

    minerals: [{"type_id", "name", "qty"}]
    options:  [{"type_id", "name", "unit_price", "portion", "yields": {type_id: qty},
                "efficiency", "max_batches", ...any extra passthrough fields...}]
        - portion: batch size (1 for a directly-buyable mineral, portionSize for ore)
        - yields: mineral type_id -> quantity produced per portion, pre-efficiency
        - max_batches: available quantity of the source item, in portions
    Returns {"items_to_buy": [...], "total_cost": float, "minerals": [...], "unmet_minerals": [...]}.
    Each items_to_buy entry keeps every option field except the LP-internal ones above,
    plus "qty" (units purchased) and "line_cost".
    """
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
        entry = {k: v for k, v in o.items() if k not in _LP_INTERNAL_KEYS}
        entry["qty"] = qty
        entry["line_cost"] = line_cost
        items_to_buy.append(entry)
    items_to_buy.sort(key=lambda r: -r["line_cost"])

    return {
        "items_to_buy": items_to_buy,
        "total_cost": total_cost,
        "minerals": mineral_rows,
        "unmet_minerals": unmet,
    }
