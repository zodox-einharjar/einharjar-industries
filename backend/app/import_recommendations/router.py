from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..doctrines.shortfall import aggregate_shortfalls
from ..market.sell_book import walk_sell_book
from ..market.velocity import daily_velocity
from ..models import FreightRoute, InventoryLot, Location, MarketOrder
from ..sde import resolve_region_id, type_volumes

router = APIRouter(prefix="/import-recommendations", dependencies=[Depends(get_current_character)])

_JITA_EVE_ID = 60003760


@router.get("")
async def import_recommendations(window_days: int = 14):
    window_days = max(1, min(window_days, 90))

    async with AsyncSessionLocal() as session:
        items_acc = await aggregate_shortfalls(session)
        if not items_acc:
            return {"generated_at": None, "excluded_locations": [], "groups": []}

        staging_loc_ids = {sid for sid, _ in items_acc.keys()}
        all_type_ids = {tid for _, tid in items_acc.keys()}

        all_locs = (await session.execute(select(Location))).scalars().all()
        loc_by_id = {l.id: l for l in all_locs}
        jita_loc = next((l for l in all_locs if l.eve_id == _JITA_EVE_ID), None)
        jita_id = jita_loc.id if jita_loc else None

        jita_by_type: dict[int, list] = {}
        freight_map: dict[int, FreightRoute] = {}

        if jita_id:
            jita_raw = (await session.execute(
                select(MarketOrder).where(
                    MarketOrder.location_id == jita_id,
                    MarketOrder.type_id.in_(list(all_type_ids)),
                    MarketOrder.is_buy.is_(False),
                )
            )).scalars().all()
            for o in jita_raw:
                jita_by_type.setdefault(o.type_id, []).append(o)
            for lst in jita_by_type.values():
                lst.sort(key=lambda o: o.price)

            routes = (await session.execute(
                select(FreightRoute).where(
                    FreightRoute.from_id == jita_id,
                    FreightRoute.to_id.in_(staging_loc_ids),
                )
            )).scalars().all()
            for r in routes:
                freight_map[r.to_id] = r

        owned_rows = (await session.execute(
            select(InventoryLot.type_id, func.sum(InventoryLot.qty_remaining).label("qty"))
            .where(InventoryLot.type_id.in_({tid for _, tid in items_acc.keys()}))
            .where(InventoryLot.qty_remaining > 0)
            .group_by(InventoryLot.type_id)
        )).all()
        owned = {r.type_id: r.qty for r in owned_rows}

        region_by_staging = {
            loc.id: resolve_region_id(loc.eve_id, loc.region_id)
            for loc in all_locs if loc.id in staging_loc_ids
        }

        history_cache: dict[tuple[int, int], list[dict]] = {}

        type_vols = type_volumes(list({tid for _, tid in items_acc.keys()}))

        by_staging: dict[int, list[tuple[int, dict]]] = defaultdict(list)
        for (staging_id, type_id), acc in items_acc.items():
            by_staging[staging_id].append((type_id, acc))

        excluded_locations = []
        groups = []

        for staging_id, entries in by_staging.items():
            loc = loc_by_id[staging_id]
            route = freight_map.get(staging_id)
            if not route:
                excluded_locations.append({
                    "location_id": staging_id, "location_name": loc.name, "reason": "no_freight_route",
                })
                continue

            fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0
            region_id = region_by_staging.get(staging_id)

            items_out = []
            for type_id, acc in entries:
                qty_after_netting = max(0, acc["qty_shortfall"] - owned.get(type_id, 0))
                if qty_after_netting <= 0:
                    continue

                v_daily = await daily_velocity(region_id, type_id, history_cache) if region_id else 0.0
                low_velocity = v_daily <= 0
                qty_to_buy = 0 if low_velocity else min(qty_after_netting, round(v_daily * window_days))

                walk = walk_sell_book(jita_by_type.get(type_id, []), qty_to_buy) if qty_to_buy > 0 else {
                    "unit_cost_avg": None, "qty_fillable": 0, "worst_unit_price": None,
                }
                actual_qty = min(qty_to_buy, walk["qty_fillable"])
                jita_depth_insufficient = walk["qty_fillable"] < qty_to_buy

                vol = type_vols.get(type_id, 0)
                freight_per_unit = float(vol) * float(route.isk_per_m3) + (
                    walk["unit_cost_avg"] * float(route.value_pct) if walk["unit_cost_avg"] is not None else 0.0
                )
                import_cost_per_unit = (
                    walk["unit_cost_avg"] + freight_per_unit if walk["unit_cost_avg"] is not None else None
                )

                staging_price = float(acc["staging_price"]) if acc["staging_price"] is not None else None
                net_proceeds_per_unit = staging_price * (1 - fee_frac) if staging_price is not None else None
                profit_per_unit = (
                    net_proceeds_per_unit - import_cost_per_unit
                    if net_proceeds_per_unit is not None and import_cost_per_unit is not None
                    else None
                )
                total_profit = profit_per_unit * actual_qty if profit_per_unit is not None else None

                items_out.append({
                    "type_id": type_id, "name": acc["name"],
                    "qty_shortfall": acc["qty_shortfall"], "qty_owned": owned.get(type_id, 0),
                    "qty_to_buy": actual_qty,
                    "velocity_daily": round(v_daily, 2), "low_velocity": low_velocity,
                    "days_to_sell": round(actual_qty / v_daily, 1) if v_daily > 0 else None,
                    "jita_unit_cost": walk["unit_cost_avg"], "jita_qty_available": walk["qty_fillable"],
                    "jita_depth_insufficient": jita_depth_insufficient,
                    "freight_per_unit": round(freight_per_unit, 2) if walk["unit_cost_avg"] is not None else None,
                    "import_cost_per_unit": import_cost_per_unit,
                    "staging_sell_price": staging_price,
                    "profit_per_unit": profit_per_unit,
                    "total_profit": total_profit,
                    "total_m3": float(vol) * actual_qty,
                    "doctrines": [{"doctrine_name": dn, "fit_name": fn} for dn, fn in sorted(acc["doctrines"])],
                })

            items_out.sort(key=lambda r: r["total_profit"] if r["total_profit"] is not None else float("-inf"), reverse=True)

            groups.append({
                "location_id": staging_id, "location_name": loc.name,
                "total_investment": sum(
                    r["import_cost_per_unit"] * r["qty_to_buy"] for r in items_out if r["import_cost_per_unit"] is not None
                ),
                "total_profit": sum(r["total_profit"] for r in items_out if r["total_profit"] is not None),
                "total_m3": sum(r["total_m3"] for r in items_out),
                "items": items_out,
            })

        groups.sort(key=lambda g: g["total_profit"], reverse=True)

        last_poll = (await session.execute(select(func.max(MarketOrder.fetched_at)))).scalar_one_or_none()

        return {
            "generated_at": last_poll.isoformat() if last_poll else None,
            "excluded_locations": excluded_locations,
            "groups": groups,
        }
