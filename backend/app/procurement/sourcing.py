from sqlalchemy import select

from ..industry.shortfall import aggregate_project_needs
from ..models import FreightRoute, Location, MarketOrder
from ..reprocessing.optimizer import solve_ore_lp
from ..sde import portion_sizes, reprocessing_materials, reprocessing_sources, type_volumes

_JITA_EVE_ID = 60003760


async def compute_project_sourcing(
    session,
    buyback_prices_by_type: dict[int, float],
    buyback_qty_by_type: dict[int, int],
    efficiency: float,
) -> dict:
    """Joint least-cost sourcing plan for every outstanding project-material shortfall.

    Solved with one LP per project output location (so local prices and Jita freight
    stay location-correct), via reprocessing.optimizer.solve_ore_lp — the same solver
    /reprocessing uses to plan a batch ore purchase. That's the fix for the naive
    per-material "cheapest source" pick: a single compressed-ore purchase can yield
    several needed minerals at once, and the LP credits all of them from one buy
    instead of pricing/buying it once per mineral and double-counting when combined.

    Buyback and Jita depth are shared, running pools decremented across locations as
    each one's plan consumes them, since that stock is genuinely finite and contested
    regardless of which project claims it first — locations are solved biggest-shortfall
    first so the largest need gets first claim on the cheapest shared supply. Local
    market depth needs no such sharing; it's already location-specific.

    Returns {"materials": [...], "items_to_buy": [...], "total_cost": float, "unmet": [...]}.
    Every items_to_buy entry carries a "channel" (buyback/local/jita) and, for
    local/jita, "location_id"/"location_name" — a caller can group by channel to get
    a buyback / local / Jita shopping list directly, with no re-merging or attribution
    guesswork needed.
    """
    needs = await aggregate_project_needs(session)
    if not needs:
        return {"materials": [], "items_to_buy": [], "total_cost": 0.0, "unmet": []}

    by_location: dict[int, list[dict]] = {}
    for (loc_id, type_id), acc in needs.items():
        by_location.setdefault(loc_id, []).append({
            "type_id": type_id, "name": acc["name"], "qty": acc["qty_shortfall"],
            "projects": sorted(acc["projects"]),
        })

    all_type_ids = {tid for _, tid in needs.keys()}
    loc_ids = set(by_location.keys())

    locations = (await session.execute(select(Location))).scalars().all()
    loc_by_id = {loc.id: loc for loc in locations}
    jita_loc = next((loc for loc in locations if loc.eve_id == _JITA_EVE_ID), None)

    compressed_by_material = reprocessing_sources(list(all_type_ids))
    candidate_ore_ids = {c["type_id"] for lst in compressed_by_material.values() for c in lst}
    ore_name_by_id = {c["type_id"]: c["name"] for lst in compressed_by_material.values() for c in lst}
    ore_yields = reprocessing_materials(list(candidate_ore_ids)) if candidate_ore_ids else {}
    ore_portions = portion_sizes(list(candidate_ore_ids)) if candidate_ore_ids else {}

    all_source_type_ids = all_type_ids | candidate_ore_ids

    local_orders: dict[tuple[int, int], list[MarketOrder]] = {}
    if loc_ids and all_source_type_ids:
        rows = (await session.execute(
            select(MarketOrder).where(
                MarketOrder.location_id.in_(loc_ids),
                MarketOrder.type_id.in_(list(all_source_type_ids)),
                MarketOrder.is_buy.is_(False),
            )
        )).scalars().all()
        for o in rows:
            local_orders.setdefault((o.location_id, o.type_id), []).append(o)

    jita_orders: dict[int, list[MarketOrder]] = {}
    freight_by_loc: dict[int, FreightRoute] = {}
    if jita_loc and all_source_type_ids:
        rows = (await session.execute(
            select(MarketOrder).where(
                MarketOrder.location_id == jita_loc.id,
                MarketOrder.type_id.in_(list(all_source_type_ids)),
                MarketOrder.is_buy.is_(False),
            )
        )).scalars().all()
        for o in rows:
            jita_orders.setdefault(o.type_id, []).append(o)

        if loc_ids:
            routes = (await session.execute(
                select(FreightRoute).where(
                    FreightRoute.from_id == jita_loc.id,
                    FreightRoute.to_id.in_(loc_ids),
                )
            )).scalars().all()
            for r in routes:
                freight_by_loc[r.to_id] = r

    vols = type_volumes(list(all_source_type_ids))

    # Shared, cross-location pools — decremented by what each location's solve
    # actually consumes so a later location's options reflect what's genuinely left.
    buyback_remaining = dict(buyback_qty_by_type)
    jita_order_remaining = {o.order_id: o.volume_remain for lst in jita_orders.values() for o in lst}

    def _yields_for(ore_id: int, needed_ids: set[int]) -> dict[int, int]:
        return {
            m["material_type_id"]: m["quantity"]
            for m in ore_yields.get(ore_id, [])
            if m["material_type_id"] in needed_ids
        }

    def _build_options(loc_id: int, minerals_L: list[dict]) -> list[dict]:
        needed_ids = {m["type_id"] for m in minerals_L}
        name_by_id = {m["type_id"]: m["name"] for m in minerals_L}
        loc_name = loc_by_id[loc_id].name
        route = freight_by_loc.get(loc_id)
        options: list[dict] = []

        # Direct: buy the raw mineral itself outright.
        for type_id in needed_ids:
            contributes_to = [name_by_id[type_id]]

            price = buyback_prices_by_type.get(type_id)
            avail = buyback_remaining.get(type_id, 0)
            if price is not None and avail > 0:
                options.append({
                    "type_id": type_id, "name": name_by_id[type_id], "unit_price": price,
                    "portion": 1, "yields": {type_id: 1}, "efficiency": 1.0,
                    "max_batches": avail, "channel": "buyback", "contributes_to": contributes_to,
                })
            for o in local_orders.get((loc_id, type_id), []):
                if o.volume_remain <= 0:
                    continue
                options.append({
                    "type_id": type_id, "name": name_by_id[type_id], "unit_price": float(o.price),
                    "portion": 1, "yields": {type_id: 1}, "efficiency": 1.0,
                    "max_batches": o.volume_remain, "channel": "local",
                    "location_id": loc_id, "location_name": loc_name, "contributes_to": contributes_to,
                })
            if route:
                vol = vols.get(type_id, 0)
                for o in jita_orders.get(type_id, []):
                    remaining = jita_order_remaining.get(o.order_id, 0)
                    if remaining <= 0:
                        continue
                    landed = float(o.price) + float(vol) * float(route.isk_per_m3) + float(o.price) * float(route.value_pct)
                    options.append({
                        "type_id": type_id, "name": name_by_id[type_id], "unit_price": landed,
                        "portion": 1, "yields": {type_id: 1}, "efficiency": 1.0,
                        "max_batches": remaining, "channel": "jita",
                        "location_id": loc_id, "location_name": loc_name, "contributes_to": contributes_to,
                        "_jita_order_id": o.order_id,
                    })

        # Reprocess: buy compressed ore/ice/gas that yields one or more needed minerals —
        # the multi-mineral yields dict is what lets the LP credit a shared purchase
        # against every needed mineral it produces, in one shot.
        relevant_ores: set[int] = set()
        for tid in needed_ids:
            for c in compressed_by_material.get(tid, []):
                relevant_ores.add(c["type_id"])

        for ore_id in relevant_ores:
            portion = ore_portions.get(ore_id)
            yields = _yields_for(ore_id, needed_ids)
            if not portion or not yields:
                continue
            ore_name = ore_name_by_id.get(ore_id, f"[{ore_id}]")
            contributes_to = [name_by_id[t] for t in yields]

            price = buyback_prices_by_type.get(ore_id)
            avail = buyback_remaining.get(ore_id, 0)
            if price is not None and avail >= portion:
                options.append({
                    "type_id": ore_id, "name": ore_name, "unit_price": price,
                    "portion": portion, "yields": yields, "efficiency": efficiency,
                    "max_batches": avail // portion, "channel": "buyback", "contributes_to": contributes_to,
                })
            for o in local_orders.get((loc_id, ore_id), []):
                if o.volume_remain < portion:
                    continue
                options.append({
                    "type_id": ore_id, "name": ore_name, "unit_price": float(o.price),
                    "portion": portion, "yields": yields, "efficiency": efficiency,
                    "max_batches": o.volume_remain // portion, "channel": "local",
                    "location_id": loc_id, "location_name": loc_name, "contributes_to": contributes_to,
                })
            if route:
                vol = vols.get(ore_id, 0)
                for o in jita_orders.get(ore_id, []):
                    remaining = jita_order_remaining.get(o.order_id, 0)
                    if remaining < portion:
                        continue
                    landed = float(o.price) + float(vol) * float(route.isk_per_m3) + float(o.price) * float(route.value_pct)
                    options.append({
                        "type_id": ore_id, "name": ore_name, "unit_price": landed,
                        "portion": portion, "yields": yields, "efficiency": efficiency,
                        "max_batches": remaining // portion, "channel": "jita",
                        "location_id": loc_id, "location_name": loc_name, "contributes_to": contributes_to,
                        "_jita_order_id": o.order_id,
                    })

        return options

    # Biggest shortfall first gets first claim on the shared buyback/Jita pools.
    ordered_locs = sorted(by_location.keys(), key=lambda lid: -sum(m["qty"] for m in by_location[lid]))

    materials_out: list[dict] = []
    all_items_to_buy: list[dict] = []
    all_unmet: list[dict] = []
    total_cost = 0.0

    for loc_id in ordered_locs:
        loc = loc_by_id.get(loc_id)
        if loc is None:
            continue
        minerals_L = by_location[loc_id]
        options = _build_options(loc_id, minerals_L)
        result = solve_ore_lp(minerals_L, options)

        for item in result["items_to_buy"]:
            if item["channel"] == "buyback":
                buyback_remaining[item["type_id"]] = buyback_remaining.get(item["type_id"], 0) - item["qty"]
            elif item["channel"] == "jita":
                oid = item.pop("_jita_order_id")
                jita_order_remaining[oid] = jita_order_remaining.get(oid, 0) - item["qty"]
            all_items_to_buy.append(item)

        total_cost += result["total_cost"]
        all_unmet.extend(
            {**u, "location_id": loc_id, "location_name": loc.name} for u in result["unmet_minerals"]
        )

        produced_by_type = {r["type_id"]: r["qty_produced"] for r in result["minerals"]}
        for m in minerals_L:
            qty_produced = produced_by_type.get(m["type_id"], 0)
            materials_out.append({
                "type_id": m["type_id"], "name": m["name"],
                "location_id": loc_id, "location_name": loc.name,
                "qty_needed": m["qty"], "qty_covered": min(m["qty"], qty_produced),
                "projects": m["projects"],
            })

    materials_out.sort(key=lambda r: (r["qty_needed"] == r["qty_covered"], -r["qty_needed"]))

    return {
        "materials": materials_out,
        "items_to_buy": all_items_to_buy,
        "total_cost": total_cost,
        "unmet": all_unmet,
    }
