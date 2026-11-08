"""Joint buying plan: every need (doctrine shortfall, industry project materials, a
personal want list) against every source (Jita, the local market, a pasted buyback
offer, compressed ore to reprocess), solved together so a shared source is never
spent twice.

Each destination location gets one solve with reprocessing.optimizer.solve_ore_lp.
A directly-bought item is just an option that yields one of itself; a compressed ore
yields several minerals at once, which is why a joint solve beats picking the cheapest
source per item. Jita and buyback stock are shared pools drawn down across locations
(biggest need first), the same approach procurement/sourcing.py takes for projects.
"""

import asyncio
from dataclasses import dataclass, field

from sqlalchemy import func, select

from ..doctrines.shortfall import aggregate_shortfalls
from ..industry.shortfall import aggregate_project_needs
from ..inventory.free_stock import free_qty_by_location
from ..market.velocity import WINDOW_DAYS, daily_velocity
from ..models import FreightRoute, Location, MarketOrder
from ..reprocessing.optimizer import solve_ore_lp
from ..sde import (
    gas_type_ids, portion_sizes, reprocessing_materials, reprocessing_sources,
    resolve_region_id, type_volumes,
)

JITA_EVE_ID = 60003760
_VELOCITY_CONCURRENCY = 8


@dataclass
class PlanInputs:
    include_doctrines: bool = True
    doctrine_fit_ids: set[int] | None = None
    fill_pct: float = 1.0
    doctrine_mode: str = "fill"            # "fill" | "profit"
    window_days: int = 14
    include_projects: bool = True
    project_ids: list[int] | None = None
    wants: list[dict] = field(default_factory=list)   # [{type_id, name, qty}]
    want_location_id: int | None = None
    net_inventory: bool = True
    use_local: bool = True
    use_ore: bool = True
    buyback: list[dict] = field(default_factory=list)  # parsed Janice lines, ok=True only
    buyback_location_id: int | None = None
    flip_location_id: int | None = None
    exclude_type_ids: set[int] = field(default_factory=set)
    qty_overrides: dict[tuple[int, int], int] = field(default_factory=dict)
    efficiency: float = 0.9063
    gas_efficiency: float = 0.90


def _freight(route: FreightRoute | None, vol: float, price: float) -> float:
    if route is None:
        return 0.0
    return vol * float(route.isk_per_m3) + price * float(route.value_pct)


async def _velocities(keys: list[tuple[int, int]], region_by_loc: dict[int, int | None]) -> dict[tuple[int, int], float]:
    """Units/day sold per (location, type), fetched concurrently via the cached ESI client."""
    cache: dict[tuple[int, int], list[dict]] = {}
    sem = asyncio.Semaphore(_VELOCITY_CONCURRENCY)

    async def one(key):
        region = region_by_loc.get(key[0])
        if not region:
            return key, 0.0
        async with sem:
            return key, await daily_velocity(region, key[1], cache)

    return dict(await asyncio.gather(*(one(k) for k in keys)))


async def build_buying_plan(session, inp: PlanInputs) -> dict:
    all_locs = (await session.execute(select(Location))).scalars().all()
    loc_by_id = {l.id: l for l in all_locs}
    jita = next((l for l in all_locs if l.eve_id == JITA_EVE_ID), None)
    jita_id = jita.id if jita else None

    # ── Needs, merged per (location, type) ─────────────────────────────────────
    rows: dict[tuple[int, int], dict] = {}

    def row(loc_id: int, type_id: int, name: str) -> dict:
        return rows.setdefault((loc_id, type_id), {
            "type_id": type_id, "name": name, "location_id": loc_id,
            "doctrine": 0, "project": 0, "want": 0,
            "doctrines": set(), "projects": set(),
            "staging_price": None,
        })

    if inp.include_doctrines:
        shortfalls = await aggregate_shortfalls(session, inp.doctrine_fit_ids, inp.fill_pct)
        free = await free_qty_by_location(session, {t for _, t in shortfalls}) if inp.net_inventory else {}
        for (loc_id, tid), acc in shortfalls.items():
            qty = max(0, acc["qty_shortfall"] - free.get((loc_id, tid), 0))
            if qty <= 0:
                continue
            r = row(loc_id, tid, acc["name"])
            r["doctrine"] = qty
            r["doctrines"] |= acc["doctrines"]
            r["staging_price"] = float(acc["staging_price"]) if acc["staging_price"] is not None else None

    if inp.include_projects:
        needs = await aggregate_project_needs(session, inp.project_ids, ignore_inventory=not inp.net_inventory)
        for (loc_id, tid), acc in needs.items():
            r = row(loc_id, tid, acc["name"])
            r["project"] += acc["qty_shortfall"]
            r["projects"] |= acc["projects"]

    if inp.wants and inp.want_location_id in loc_by_id:
        for w in inp.wants:
            row(inp.want_location_id, w["type_id"], w["name"])["want"] += w["qty"]

    region_by_loc = {lid: resolve_region_id(l.eve_id, l.region_id) for lid, l in loc_by_id.items()}

    # Profit mode only reshapes doctrine-only needs: cap at what sells in the window.
    velocity: dict[tuple[int, int], float] = {}
    if inp.include_doctrines and inp.doctrine_mode == "profit":
        doctrine_keys = [k for k, r in rows.items() if r["doctrine"] > 0]
        velocity = await _velocities(doctrine_keys, region_by_loc)
        for k in doctrine_keys:
            r = rows[k]
            r["velocity_daily"] = round(velocity.get(k, 0.0), 2)
            capped = min(r["doctrine"], round(velocity.get(k, 0.0) * inp.window_days))
            r["no_sales"] = capped == 0
            r["doctrine"] = capped

    for key, r in rows.items():
        r["excluded"] = r["type_id"] in inp.exclude_type_ids
        natural = r["doctrine"] + r["project"] + r["want"]
        r["qty_natural"] = natural
        r["qty"] = 0 if r["excluded"] else inp.qty_overrides.get(key, natural)
        r["edited"] = key in inp.qty_overrides

    active = {k: r for k, r in rows.items() if r["qty"] > 0}
    dest_ids = {loc for loc, _ in active}
    need_type_ids = {t for _, t in active}

    # ── Supply ─────────────────────────────────────────────────────────────────
    compressed_by_material = reprocessing_sources(list(need_type_ids)) if inp.use_ore and need_type_ids else {}
    ore_ids = {c["type_id"] for lst in compressed_by_material.values() for c in lst}
    ore_names = {c["type_id"]: c["name"] for lst in compressed_by_material.values() for c in lst}
    ore_yields = reprocessing_materials(list(ore_ids)) if ore_ids else {}
    ore_portions = portion_sizes(list(ore_ids)) if ore_ids else {}
    gas_ids = gas_type_ids(list(ore_ids)) if ore_ids else set()

    buyback_type_ids = {b["type_id"] for b in inp.buyback}
    source_type_ids = need_type_ids | ore_ids
    vols = type_volumes(list(source_type_ids | buyback_type_ids))

    jita_orders: dict[int, list[MarketOrder]] = {}
    if jita_id and source_type_ids:
        for o in (await session.execute(
            select(MarketOrder).where(
                MarketOrder.location_id == jita_id,
                MarketOrder.type_id.in_(list(source_type_ids)),
                MarketOrder.is_buy.is_(False),
            )
        )).scalars().all():
            jita_orders.setdefault(o.type_id, []).append(o)

    local_orders: dict[tuple[int, int], list[MarketOrder]] = {}
    if inp.use_local and dest_ids and source_type_ids:
        for o in (await session.execute(
            select(MarketOrder).where(
                MarketOrder.location_id.in_(dest_ids),
                MarketOrder.type_id.in_(list(source_type_ids)),
                MarketOrder.is_buy.is_(False),
            )
        )).scalars().all():
            local_orders.setdefault((o.location_id, o.type_id), []).append(o)
        for lst in local_orders.values():
            lst.sort(key=lambda o: float(o.price))

    local_low: dict[tuple[int, int], float] = {}
    if dest_ids and need_type_ids:
        for loc_id, tid, low in (await session.execute(
            select(MarketOrder.location_id, MarketOrder.type_id, func.min(MarketOrder.price))
            .where(
                MarketOrder.location_id.in_(dest_ids),
                MarketOrder.type_id.in_(list(need_type_ids)),
                MarketOrder.is_buy.is_(False),
            )
            .group_by(MarketOrder.location_id, MarketOrder.type_id)
        )).all():
            local_low[(loc_id, tid)] = float(low)

    route_from = {i for i in (jita_id, inp.buyback_location_id) if i}
    routes: dict[tuple[int, int], FreightRoute] = {}
    if route_from and dest_ids:
        for r in (await session.execute(
            select(FreightRoute).where(FreightRoute.from_id.in_(route_from), FreightRoute.to_id.in_(dest_ids))
        )).scalars().all():
            routes[(r.from_id, r.to_id)] = r

    # Shared pools, drawn down as each location's plan consumes them.
    jita_left = {o.order_id: o.volume_remain for lst in jita_orders.values() for o in lst}
    buyback_left: dict[int, list[list[float]]] = {}
    buyback_total: dict[int, int] = {}  # whole offer per item; buyback_left gets drawn down
    for b in inp.buyback:
        buyback_left.setdefault(b["type_id"], []).append([float(b["unit_price"]), b["qty"]])
        buyback_total[b["type_id"]] = buyback_total.get(b["type_id"], 0) + int(b["qty"])

    locations_out = []
    ordered = sorted(dest_ids, key=lambda lid: -sum(r["qty"] for (l, _), r in active.items() if l == lid))
    for loc_id in ordered:
        loc = loc_by_id[loc_id]
        loc_rows = [r for (l, _), r in active.items() if l == loc_id]
        jita_route = None if loc_id == jita_id else routes.get((jita_id, loc_id))
        jita_freight_missing = bool(jita_id) and loc_id != jita_id and jita_route is None
        bb_here = inp.buyback_location_id in (None, loc_id)
        bb_route = None if bb_here else routes.get((inp.buyback_location_id, loc_id))
        bb_freight_missing = bool(inp.buyback) and not bb_here and bb_route is None
        fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0
        needed = {r["type_id"] for r in loc_rows}
        names = {r["type_id"]: r["name"] for r in loc_rows}
        options: list[dict] = []

        def add(type_id, name, channel, raw, landed, qty, portion, yields, eff, ref, contributes):
            batches = qty // portion
            if batches <= 0:
                return
            options.append({
                "type_id": type_id, "name": name, "channel": channel,
                "raw_price": raw, "unit_price": landed,
                "portion": portion, "yields": yields, "efficiency": eff, "max_batches": batches,
                "contributes_to": contributes, "_covers": list(yields), "_ref": ref,
            })

        for r in loc_rows:
            tid, name, vol = r["type_id"], r["name"], float(vols.get(r["type_id"], 0))
            # A doctrine counts as stocked by what's listed on the local market, so buying
            # those listings doesn't help it — only non-doctrine need may use local stock.
            # Keeping just the cheapest such units is exactly what the solver would pick.
            local_cap = r["qty"] - min(r["qty"], r["doctrine"])
            profit_only = inp.doctrine_mode == "profit" and r["doctrine"] > 0 and r["project"] == 0 and r["want"] == 0
            net_proceeds = r["staging_price"] * (1 - fee_frac) if r["staging_price"] is not None else None
            r["profit_only"] = profit_only
            if profit_only:
                r["net_proceeds"] = net_proceeds

            def allowed(landed: float) -> bool:
                return not profit_only or (net_proceeds is not None and landed < net_proceeds)

            for i, (price, left) in enumerate(buyback_left.get(tid, [])):
                landed = price + _freight(bb_route, vol, price)
                if left > 0 and allowed(landed):
                    add(tid, name, "buyback", price, landed, int(left), 1, {tid: 1}, 1.0, ("buyback", tid, i), [name])
            if local_cap > 0:
                for o in local_orders.get((loc_id, tid), []):
                    take = min(o.volume_remain, local_cap)
                    if take <= 0:
                        break
                    local_cap -= take
                    add(tid, name, "local", float(o.price), float(o.price), take, 1, {tid: 1}, 1.0, ("local", o.order_id), [name])
            for o in jita_orders.get(tid, []):
                left = jita_left.get(o.order_id, 0)
                landed = float(o.price) + _freight(jita_route, vol, float(o.price))
                if left > 0 and allowed(landed):
                    add(tid, name, "jita", float(o.price), landed, left, 1, {tid: 1}, 1.0, ("jita", o.order_id), [name])

        # Compressed ore/ice/gas that reprocesses into one or more needed items.
        for ore_id in {c["type_id"] for t in needed for c in compressed_by_material.get(t, [])}:
            portion = ore_portions.get(ore_id)
            yields = {m["material_type_id"]: m["quantity"] for m in ore_yields.get(ore_id, []) if m["material_type_id"] in needed}
            if not portion or not yields:
                continue
            eff = inp.gas_efficiency if ore_id in gas_ids else inp.efficiency
            ore_name = ore_names.get(ore_id, f"[{ore_id}]")
            contributes = [names[t] for t in yields]
            vol = float(vols.get(ore_id, 0))
            for i, (price, left) in enumerate(buyback_left.get(ore_id, [])):
                add(ore_id, ore_name, "buyback", price, price + _freight(bb_route, vol, price), int(left), portion, yields, eff, ("buyback", ore_id, i), contributes)
            for o in local_orders.get((loc_id, ore_id), []):
                add(ore_id, ore_name, "local", float(o.price), float(o.price), o.volume_remain, portion, yields, eff, ("local", o.order_id), contributes)
            for o in jita_orders.get(ore_id, []):
                landed = float(o.price) + _freight(jita_route, vol, float(o.price))
                add(ore_id, ore_name, "jita", float(o.price), landed, jita_left.get(o.order_id, 0), portion, yields, eff, ("jita", o.order_id), contributes)

        result = solve_ore_lp([{"type_id": r["type_id"], "name": r["name"], "qty": r["qty"]} for r in loc_rows], options)

        row_by_type = {r["type_id"]: r for r in loc_rows}
        purchases: dict[tuple[str, int], dict] = {}
        for item in result["items_to_buy"]:
            ref = item.pop("_ref")
            covers = item.pop("_covers")
            if ref[0] == "jita":
                jita_left[ref[1]] = jita_left.get(ref[1], 0) - item["qty"]
            elif ref[0] == "buyback":
                buyback_left[ref[1]][ref[2]][1] -= item["qty"]
            # Merge price levels of the same item from the same source into one line.
            p = purchases.setdefault((item["channel"], item["type_id"]), {
                "type_id": item["type_id"], "name": item["name"], "channel": item["channel"],
                "qty": 0, "cost": 0.0, "raw_cost": 0.0, "m3": 0.0,
                "is_ore": item["type_id"] not in needed, "contributes_to": item["contributes_to"],
                "for": {"doctrine": False, "project": False, "want": False},
                "doctrines": set(), "projects": set(),
            })
            for t in covers:
                r = row_by_type.get(t)
                if r is None:
                    continue
                for cat in ("doctrine", "project", "want"):
                    p["for"][cat] = p["for"][cat] or r[cat] > 0
                p["doctrines"] |= {d for d, _ in r["doctrines"]}
                p["projects"] |= r["projects"]
            p["qty"] += item["qty"]
            p["cost"] += item["line_cost"]
            p["raw_cost"] += item["raw_price"] * item["qty"]
            p["m3"] += float(vols.get(item["type_id"], 0)) * item["qty"]
        purchase_list = sorted(purchases.values(), key=lambda p: (p["channel"], -p["cost"]))
        for p in purchase_list:
            p["unit_cost"] = p["cost"] / p["qty"] if p["qty"] else None
            p["buyback_available"] = buyback_total.get(p["type_id"]) if p["channel"] == "buyback" else None
            # Split of unit_cost: what the seller is paid vs. freight to this location.
            p["unit_price"] = p["raw_cost"] / p["qty"] if p["qty"] else None
            p["freight_per_unit"] = (p["cost"] - p["raw_cost"]) / p["qty"] if p["qty"] else None
            p["doctrines"] = sorted(p["doctrines"])
            p["projects"] = sorted(p["projects"])
            # Resale value at the destination — meaningful for items you'd list there
            # (doctrine seeding); materials and want-list items are used, not sold.
            low = None if p["is_ore"] else local_low.get((loc_id, p["type_id"]))
            p["local_sell"] = low
            p["net_proceeds"] = low * (1 - fee_frac) if low is not None else None
            p["profit_per_unit"] = (
                p["net_proceeds"] - p["unit_cost"]
                if p["net_proceeds"] is not None and p["unit_cost"] is not None else None
            )

        produced = {m["type_id"]: m["qty_produced"] for m in result["minerals"]}
        need_out = []
        for r in sorted(loc_rows, key=lambda r: r["name"]):
            covered = min(r["qty"], produced.get(r["type_id"], 0))
            need_out.append({
                "type_id": r["type_id"], "name": r["name"],
                "qty": r["qty"], "qty_natural": r["qty_natural"], "edited": r["edited"],
                "covered": covered, "unmet": r["qty"] - covered,
                # Why anything is left uncovered: nothing cheap enough to resell at a
                # profit (profit mode), or no supply at all across the enabled sources.
                "unmet_reason": None if covered >= r["qty"] else ("unprofitable" if r.get("profit_only") else "no_supply"),
                "for": {"doctrine": r["doctrine"], "project": r["project"], "want": r["want"]},
                "doctrines": [{"doctrine_name": d, "fit_name": f} for d, f in sorted(r["doctrines"])],
                "projects": sorted(r["projects"]),
                "velocity_daily": r.get("velocity_daily"),
                "net_proceeds": r.get("net_proceeds"),
            })

        locations_out.append({
            "location_id": loc_id, "location_name": loc.name,
            "jita_freight_missing": jita_freight_missing,
            "buyback_freight_missing": bb_freight_missing,
            "needs": need_out,
            "purchases": purchase_list,
            "total_cost": sum(p["cost"] for p in purchase_list),
            "total_m3": sum(p["m3"] for p in purchase_list),
        })

    # Units sold over the last 30 days for every line on the shopping lists. ESI market
    # history is per region, so for a structure this counts the whole region's trades.
    sold_keys = {(lo["location_id"], p["type_id"]) for lo in locations_out for p in lo["purchases"]}
    missing = [k for k in sold_keys if k not in velocity]
    if missing:
        velocity.update(await _velocities(missing, region_by_loc))
    for lo in locations_out:
        for p in lo["purchases"]:
            v = velocity.get((lo["location_id"], p["type_id"]))
            p["sold_30d"] = round(v * WINDOW_DAYS) if v is not None else None

    # Needs the user removed or zeroed, so they can be restored in the UI.
    hidden = [
        {"location_id": r["location_id"], "type_id": r["type_id"], "name": r["name"],
         "qty_natural": r["qty_natural"], "excluded": r["excluded"]}
        for r in rows.values() if r["qty"] <= 0 and (r["excluded"] or r["edited"])
    ]

    # Profit mode: doctrine needs dropped because the item doesn't sell locally.
    no_sales = sorted(
        ({"location_id": r["location_id"], "type_id": r["type_id"], "name": r["name"]}
         for r in rows.values() if r.get("no_sales") and r["project"] == 0 and r["want"] == 0),
        key=lambda x: x["name"],
    )

    flip = await _evaluate_flip(session, inp, buyback_left, loc_by_id, region_by_loc)

    last_poll = (await session.execute(select(func.max(MarketOrder.fetched_at)))).scalar_one_or_none()
    return {
        "generated_at": last_poll.isoformat() if last_poll else None,
        "locations": locations_out,
        "hidden": hidden,
        "no_sales": no_sales,
        "flip": flip,
        "total_cost": sum(l["total_cost"] for l in locations_out),
    }


async def _evaluate_flip(session, inp: PlanInputs, buyback_left, loc_by_id, region_by_loc) -> dict | None:
    """What's left of the buyback offer after needs are covered, judged as a resale at
    the flip location: lowest local sell price net of fees, versus the offer price."""
    loc = loc_by_id.get(inp.flip_location_id) if inp.flip_location_id else None
    if not inp.buyback or loc is None:
        return None

    names = {b["type_id"]: b["item_name"] for b in inp.buyback}
    left = {
        tid: (sum(q for _, q in levels), sum(p * q for p, q in levels))
        for tid, levels in buyback_left.items()
    }
    left = {tid: (q, cost) for tid, (q, cost) in left.items() if q > 0}
    if not left:
        return {"location_id": loc.id, "location_name": loc.name, "recommended": [], "unprofitable": [], "unpriced": []}

    lows = dict((await session.execute(
        select(MarketOrder.type_id, func.min(MarketOrder.price))
        .where(MarketOrder.location_id == loc.id, MarketOrder.type_id.in_(list(left)), MarketOrder.is_buy.is_(False))
        .group_by(MarketOrder.type_id)
    )).all())
    priced = [tid for tid in left if tid in lows]
    velocity = await _velocities([(loc.id, tid) for tid in priced], region_by_loc)
    fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0

    recommended, unprofitable, unpriced = [], [], []
    for tid, (qty, cost) in left.items():
        unit = cost / qty
        base = {"type_id": tid, "name": names.get(tid, f"[{tid}]"), "qty": int(qty), "unit_price": unit}
        if tid not in lows:
            unpriced.append(base)
            continue
        sell = float(lows[tid])
        profit = sell * (1 - fee_frac) - unit
        v = velocity.get((loc.id, tid), 0.0)
        entry = {
            **base, "sell_price": sell, "profit_per_unit": profit,
            "profit_pct": profit / unit * 100 if unit > 0 else None,
            "total_profit": profit * qty,
            "velocity_daily": round(v, 2), "days_to_sell": round(qty / v, 1) if v > 0 else None,
        }
        (recommended if profit > 0 else unprofitable).append(entry)

    recommended.sort(key=lambda e: -e["total_profit"])
    unprofitable.sort(key=lambda e: -e["total_profit"])
    unpriced.sort(key=lambda e: e["name"])
    return {"location_id": loc.id, "location_name": loc.name,
            "recommended": recommended, "unprofitable": unprofitable, "unpriced": unpriced}
