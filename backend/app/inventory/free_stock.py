from sqlalchemy import func, select

from ..models import InventoryLot, LotReservation


async def free_qty_by_location(session, type_ids) -> dict[tuple[int, int], int]:
    """Owned stock not reserved by any industry project, keyed by (location_id, type_id).

    Lots with no location are skipped — they can't be credited to any staging point.
    """
    type_ids = list(type_ids)
    if not type_ids:
        return {}

    lots = (await session.execute(
        select(InventoryLot.id, InventoryLot.location_id, InventoryLot.type_id, InventoryLot.qty_remaining)
        .where(InventoryLot.type_id.in_(type_ids))
        .where(InventoryLot.qty_remaining > 0)
        .where(InventoryLot.location_id.is_not(None))
    )).all()
    if not lots:
        return {}

    reserved = dict((await session.execute(
        select(LotReservation.lot_id, func.sum(LotReservation.qty_reserved))
        .where(LotReservation.lot_id.in_([l.id for l in lots]))
        .group_by(LotReservation.lot_id)
    )).all())

    free: dict[tuple[int, int], int] = {}
    for l in lots:
        qty = l.qty_remaining - (reserved.get(l.id) or 0)
        if qty > 0:
            key = (l.location_id, l.type_id)
            free[key] = free.get(key, 0) + qty
    return free
