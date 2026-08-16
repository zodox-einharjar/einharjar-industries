from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..doctrines.availability import calculate
from ..market.history import get_history
from ..models import Doctrine, DoctrineFit, Fit, FreightRoute, InventoryLot, Location, MarketOrder
from ..sde import resolve_region_id, type_volumes

router = APIRouter(prefix="/import-recommendations", dependencies=[Depends(get_current_character)])

_JITA_EVE_ID = 60003760
_HISTORY_WINDOW_DAYS = 30  # velocity is averaged over the most recent N days of ESI history

_DOCTRINE_OPTS = (
    selectinload(Doctrine.doctrine_fits).options(
        selectinload(DoctrineFit.fit).options(selectinload(Fit.items))
    ),
    selectinload(Doctrine.location),
)


def _walk_sell_book(orders: list[MarketOrder], qty: int) -> dict:
    """Walk sell orders cheapest-first up to qty; returns the true volume-weighted cost
    rather than assuming every unit costs what the single best order costs."""
    ordered = sorted(orders, key=lambda o: float(o.price))
    remaining = qty
    total_cost = Decimal(0)
    filled = 0
    worst_price: Decimal | None = None
    for o in ordered:
        if remaining <= 0:
            break
        take = min(remaining, o.volume_remain)
        total_cost += o.price * take
        filled += take
        worst_price = o.price
        remaining -= take
    return {
        "unit_cost_avg": float(total_cost / filled) if filled else None,
        "qty_fillable": filled,
        "worst_unit_price": float(worst_price) if worst_price is not None else None,
    }


@router.get("")
async def import_recommendations(window_days: int = 14):
    window_days = max(1, min(window_days, 90))

    async with AsyncSessionLocal() as session:
        doctrines = (await session.execute(select(Doctrine).options(*_DOCTRINE_OPTS))).scalars().all()

        staging_loc_ids = {d.location_id for d in doctrines if d.location_id}
        all_type_ids = {
            item.type_id
            for d in doctrines if d.location_id
            for df in d.doctrine_fits
            for item in df.fit.items
        }

        all_locs = (await session.execute(select(Location))).scalars().all()
        loc_by_id = {l.id: l for l in all_locs}
        jita_loc = next((l for l in all_locs if l.eve_id == _JITA_EVE_ID), None)
        jita_id = jita_loc.id if jita_loc else None

        staging_by_loc: dict[int, dict[int, list]] = {}
        jita_by_type: dict[int, list] = {}
        freight_map: dict[int, FreightRoute] = {}

        if all_type_ids and staging_loc_ids:
            staging_raw = (await session.execute(
                select(MarketOrder).where(
                    MarketOrder.location_id.in_(staging_loc_ids),
                    MarketOrder.type_id.in_(list(all_type_ids)),
                    MarketOrder.is_buy.is_(False),
                )
            )).scalars().all()
            for o in staging_raw:
                staging_by_loc.setdefault(o.location_id, {}).setdefault(o.type_id, []).append(o)
            for loc_d in staging_by_loc.values():
                for lst in loc_d.values():
                    lst.sort(key=lambda o: o.price)

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

        # Cross-doctrine shortfall aggregation, reusing calculate()'s per-fit-item math.
        items_acc: dict[tuple[int, int], dict] = {}
        for doctrine in doctrines:
            if not doctrine.location_id:
                continue
            staging_id = doctrine.location_id
            staging_by_type = staging_by_loc.get(staging_id, {})
            for df in doctrine.doctrine_fits:
                calc = calculate(df, staging_by_type, jita_by_type, None, None, 0, 0)
                for row in calc["item_rows"]:
                    qty_short = row["qty_needed"] - row["qty_available"]
                    if qty_short <= 0:
                        continue
                    key = (staging_id, row["type_id"])
                    acc = items_acc.setdefault(key, {
                        "type_id": row["type_id"], "name": row["name"],
                        "qty_shortfall": 0, "staging_price": row["staging_price"],
                        "doctrines": set(),
                    })
                    acc["qty_shortfall"] += qty_short
                    if acc["staging_price"] is None:
                        acc["staging_price"] = row["staging_price"]
                    acc["doctrines"].add((doctrine.name, df.fit.name))

        if not items_acc:
            return {"generated_at": None, "excluded_locations": [], "groups": []}

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

        async def velocity_daily(region_id: int, type_id: int) -> float:
            key = (region_id, type_id)
            if key not in history_cache:
                history_cache[key] = await get_history(region_id, type_id)
            # ESI omits no-trade days entirely rather than returning zero-volume rows, so
            # filter by actual calendar age and divide by the fixed window — not by the
            # count of rows returned, which would silently skip gaps and inflate the average.
            today = datetime.now(timezone.utc).date()
            total = 0
            for r in history_cache[key]:
                age = (today - datetime.strptime(r["date"], "%Y-%m-%d").date()).days
                if 0 <= age <= _HISTORY_WINDOW_DAYS:
                    total += r.get("volume", 0)
            return total / _HISTORY_WINDOW_DAYS

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

                v_daily = await velocity_daily(region_id, type_id) if region_id else 0.0
                low_velocity = v_daily <= 0
                qty_to_buy = 0 if low_velocity else min(qty_after_netting, round(v_daily * window_days))

                walk = _walk_sell_book(jita_by_type.get(type_id, []), qty_to_buy) if qty_to_buy > 0 else {
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
