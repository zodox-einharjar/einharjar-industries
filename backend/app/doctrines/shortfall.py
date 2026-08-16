from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import Doctrine, DoctrineFit, Fit, MarketOrder
from .availability import calculate

_DOCTRINE_OPTS = (
    selectinload(Doctrine.doctrine_fits).options(
        selectinload(DoctrineFit.fit).options(selectinload(Fit.items))
    ),
    selectinload(Doctrine.location),
)


async def aggregate_shortfalls(session) -> dict[tuple[int, int], dict]:
    """Cross-doctrine shortfall aggregation, keyed by (staging_location_id, type_id).

    Each entry: {type_id, name, qty_shortfall, staging_price, doctrines: {(doctrine_name, fit_name), ...}}.
    Jita pricing is irrelevant here — calculate() is called with an empty jita_orders
    dict since only qty_needed/qty_available/staging_price/name are read from item_rows.
    """
    doctrines = (await session.execute(select(Doctrine).options(*_DOCTRINE_OPTS))).scalars().all()

    staging_loc_ids = {d.location_id for d in doctrines if d.location_id}
    all_type_ids = {
        item.type_id
        for d in doctrines if d.location_id
        for df in d.doctrine_fits
        for item in df.fit.items
    }

    staging_by_loc: dict[int, dict[int, list]] = {}
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

    items_acc: dict[tuple[int, int], dict] = {}
    for doctrine in doctrines:
        if not doctrine.location_id:
            continue
        staging_id = doctrine.location_id
        staging_by_type = staging_by_loc.get(staging_id, {})
        for df in doctrine.doctrine_fits:
            calc = calculate(df, staging_by_type, {}, None, None, 0, 0)
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

    return items_acc
