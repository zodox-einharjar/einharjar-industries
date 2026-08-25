from math import ceil

from sqlalchemy import select

from ..industry.shortfall import aggregate_project_needs
from ..market.sell_book import walk_sell_book
from ..models import FreightRoute, Location, MarketOrder
from ..sde import reprocessing_sources, type_volumes

_JITA_EVE_ID = 60003760


async def compute_project_sourcing(
    session, buyback_prices_by_type: dict[int, float], efficiency: float,
) -> list[dict]:
    """One row per outstanding project-material shortfall, comparing buyback / local
    market / Jita-landed / reprocessed-compressed-ore cost per unit.

    This is a per-material greedy best-source pick, not a joint multi-material LP
    allocation (that's what /reprocessing does for planning a batch ore purchase).
    """
    needs = await aggregate_project_needs(session)
    if not needs:
        return []

    loc_ids = {loc_id for loc_id, _ in needs.keys()}
    type_ids = {tid for _, tid in needs.keys()}

    locations = (await session.execute(select(Location))).scalars().all()
    loc_by_id = {loc.id: loc for loc in locations}
    jita_loc = next((loc for loc in locations if loc.eve_id == _JITA_EVE_ID), None)

    compressed_by_material = reprocessing_sources(list(type_ids))
    compressed_type_ids = {c["type_id"] for lst in compressed_by_material.values() for c in lst}
    all_source_type_ids = type_ids | compressed_type_ids

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

    def _local_walk(loc_id: int, type_id: int, qty: int) -> dict | None:
        orders = local_orders.get((loc_id, type_id), [])
        if not orders or qty <= 0:
            return None
        walk = walk_sell_book(orders, qty)
        if walk["unit_cost_avg"] is None:
            return None
        return {
            "unit_cost": walk["unit_cost_avg"],
            "qty_fillable": walk["qty_fillable"],
            "depth_insufficient": walk["qty_fillable"] < qty,
        }

    def _jita_walk(loc_id: int, type_id: int, qty: int) -> dict | None:
        orders = jita_orders.get(type_id, [])
        route = freight_by_loc.get(loc_id)
        if not orders or not route or qty <= 0:
            return None
        walk = walk_sell_book(orders, qty)
        if walk["unit_cost_avg"] is None:
            return None
        vol = vols.get(type_id, 0)
        freight_per_unit = float(vol) * float(route.isk_per_m3) + walk["unit_cost_avg"] * float(route.value_pct)
        return {
            "unit_cost": walk["unit_cost_avg"] + freight_per_unit,
            "qty_fillable": walk["qty_fillable"],
            "depth_insufficient": walk["qty_fillable"] < qty,
        }

    def _label(base: str, walk: dict) -> str:
        if not walk["depth_insufficient"]:
            return base
        return f"{base} (only {walk['qty_fillable']:,} available)"

    rows = []
    for (loc_id, type_id), acc in needs.items():
        loc = loc_by_id.get(loc_id)
        if loc is None:
            continue
        qty = acc["qty_shortfall"]
        candidates: list[dict] = []

        buyback_price = buyback_prices_by_type.get(type_id)
        if buyback_price is not None:
            # Buyback is a standing program price, not an order-book depth we can walk —
            # unlike local/Jita there's no fillable-quantity concept to check here.
            candidates.append({
                "channel": "buyback", "label": "Buyback", "unit_cost": buyback_price,
                "depth_insufficient": False,
            })

        local_walk = _local_walk(loc_id, type_id, qty)
        if local_walk is not None:
            candidates.append({
                "channel": "local", "label": _label("Local market", local_walk),
                "unit_cost": local_walk["unit_cost"], "depth_insufficient": local_walk["depth_insufficient"],
            })

        jita_walk = _jita_walk(loc_id, type_id, qty)
        if jita_walk is not None:
            candidates.append({
                "channel": "jita", "label": _label("Jita (landed)", jita_walk),
                "unit_cost": jita_walk["unit_cost"], "depth_insufficient": jita_walk["depth_insufficient"],
            })

        for source in compressed_by_material.get(type_id, []):
            yield_per_unit = (source["quantity"] / source["portion_size"]) * efficiency
            if yield_per_unit <= 0:
                continue
            compressed_qty_needed = ceil(qty / yield_per_unit)

            cb = buyback_prices_by_type.get(source["type_id"])
            if cb is not None:
                candidates.append({
                    "channel": "compressed_buyback", "label": f"{source['name']} via Buyback",
                    "unit_cost": cb / yield_per_unit, "depth_insufficient": False,
                })

            cl = _local_walk(loc_id, source["type_id"], compressed_qty_needed)
            if cl is not None:
                candidates.append({
                    "channel": "compressed_local",
                    "label": _label(f"{source['name']} via Local market", cl),
                    "unit_cost": cl["unit_cost"] / yield_per_unit, "depth_insufficient": cl["depth_insufficient"],
                })

            cj = _jita_walk(loc_id, source["type_id"], compressed_qty_needed)
            if cj is not None:
                candidates.append({
                    "channel": "compressed_jita",
                    "label": _label(f"{source['name']} via Jita (landed)", cj),
                    "unit_cost": cj["unit_cost"] / yield_per_unit, "depth_insufficient": cj["depth_insufficient"],
                })

        # Prefer sources that can actually fill the full shortfall; only fall back to a
        # depth-insufficient one if nothing else can cover it at all.
        fillable = [c for c in candidates if not c["depth_insufficient"]]
        best = min(fillable or candidates, key=lambda c: c["unit_cost"]) if candidates else None

        rows.append({
            "type_id": type_id, "name": acc["name"],
            "location_id": loc_id, "location_name": loc.name,
            "qty_needed": qty,
            "projects": sorted(acc["projects"]),
            "buyback_price": buyback_price,
            "local_price": local_walk["unit_cost"] if local_walk else None,
            "local_depth_insufficient": local_walk["depth_insufficient"] if local_walk else False,
            "jita_landed_price": jita_walk["unit_cost"] if jita_walk else None,
            "jita_depth_insufficient": jita_walk["depth_insufficient"] if jita_walk else False,
            "compressed_options": [c for c in candidates if c["channel"].startswith("compressed_")],
            "best": best,
            "total_cost_at_best": best["unit_cost"] * qty if best else None,
        })

    rows.sort(key=lambda r: (r["total_cost_at_best"] is None, -(r["total_cost_at_best"] or 0)))
    return rows
