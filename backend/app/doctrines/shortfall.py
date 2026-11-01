import math

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import Doctrine, DoctrineFit, Fit, MarketOrder
from ..sde import type_names

_DOCTRINE_OPTS = (
    selectinload(Doctrine.doctrine_fits).options(
        selectinload(DoctrineFit.fit).options(selectinload(Fit.items))
    ),
    selectinload(Doctrine.location),
)


async def aggregate_shortfalls(
    session, doctrine_fit_ids: set[int] | None = None, fill_pct: float = 1.0,
) -> dict[tuple[int, int], dict]:
    """Cross-doctrine shortfall aggregation, keyed by (staging_location_id, type_id).

    Need is pooled across every included fit at a staging location before local
    stock is subtracted — stock is shared, so summing per-fit shortfalls would
    undercount (fits needing 10 + 25 with 5 on market is 30 short, not 25).

    doctrine_fit_ids restricts to those DoctrineFit rows (None = all). fill_pct
    scales every target (0.5 = stock to half of target).

    Each entry: {type_id, name, qty_needed, qty_available, qty_shortfall,
    staging_price, doctrines: {(doctrine_name, fit_name), ...}}.
    """
    doctrines = (await session.execute(select(Doctrine).options(*_DOCTRINE_OPTS))).scalars().all()

    included = [
        (d, df)
        for d in doctrines if d.location_id
        for df in d.doctrine_fits
        if doctrine_fit_ids is None or df.id in doctrine_fit_ids
    ]

    need: dict[tuple[int, int], float] = {}
    refs: dict[tuple[int, int], set] = {}
    for d, df in included:
        for item in df.fit.items:
            key = (d.location_id, item.type_id)
            need[key] = need.get(key, 0) + item.quantity * df.target_qty * fill_pct
            refs.setdefault(key, set()).add((d.name, df.fit.name))

    if not need:
        return {}

    staging_loc_ids = {sid for sid, _ in need}
    all_type_ids = {tid for _, tid in need}
    orders = (await session.execute(
        select(MarketOrder).where(
            MarketOrder.location_id.in_(staging_loc_ids),
            MarketOrder.type_id.in_(list(all_type_ids)),
            MarketOrder.is_buy.is_(False),
        )
    )).scalars().all()
    avail: dict[tuple[int, int], int] = {}
    best: dict[tuple[int, int], object] = {}
    for o in orders:
        key = (o.location_id, o.type_id)
        avail[key] = avail.get(key, 0) + o.volume_remain
        if key not in best or o.price < best[key]:
            best[key] = o.price

    names = type_names(list(all_type_ids))
    items_acc: dict[tuple[int, int], dict] = {}
    for key, needed in need.items():
        qty_needed = math.ceil(needed - 1e-9)
        qty_available = avail.get(key, 0)
        qty_short = qty_needed - qty_available
        if qty_short <= 0:
            continue
        items_acc[key] = {
            "type_id": key[1], "name": names.get(key[1], f"[{key[1]}]"),
            "qty_needed": qty_needed, "qty_available": qty_available,
            "qty_shortfall": qty_short, "staging_price": best.get(key),
            "doctrines": refs[key],
        }
    return items_acc
