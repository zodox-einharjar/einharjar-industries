from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import IndustryProject, InventoryLot, LotReservation


async def aggregate_project_needs(session) -> dict[int, dict]:
    """Cross-project material shortfall aggregation, keyed by type_id.

    Mirrors doctrines.shortfall.aggregate_shortfalls() but sourced from
    ProjectMaterial vs. inventory for planning/in_progress projects. Each
    entry: {type_id, qty_shortfall, projects: {project_name, ...}}.
    """
    projects = (await session.execute(
        select(IndustryProject)
        .where(IndustryProject.status.in_(["planning", "in_progress"]))
        .options(selectinload(IndustryProject.materials))
    )).scalars().all()
    # A project with no output location has no "correct location" to check stock
    # against, so it can't be scored — same convention as doctrines/shortfall.py
    # skipping doctrines with no staging location.
    projects = [p for p in projects if p.output_location_id]

    type_ids = {m.type_id for p in projects for m in p.materials}
    if not type_ids:
        return {}

    lots = (await session.execute(
        select(InventoryLot)
        .where(InventoryLot.type_id.in_(type_ids))
        .where(InventoryLot.qty_remaining > 0)
    )).scalars().all()
    lots_by_loc_type: dict[tuple[int, int], list[InventoryLot]] = {}
    for lot in lots:
        if lot.location_id is not None:
            lots_by_loc_type.setdefault((lot.location_id, lot.type_id), []).append(lot)

    all_reservations = (await session.execute(
        select(LotReservation.lot_id, LotReservation.project_id, LotReservation.qty_reserved)
        .join(InventoryLot, LotReservation.lot_id == InventoryLot.id)
        .where(InventoryLot.type_id.in_(type_ids))
    )).all()
    reserved_total_by_lot: dict[int, int] = {}
    reserved_by_project_lot: dict[tuple[int, int], int] = {}
    for r in all_reservations:
        reserved_total_by_lot[r.lot_id] = reserved_total_by_lot.get(r.lot_id, 0) + r.qty_reserved
        key = (r.project_id, r.lot_id)
        reserved_by_project_lot[key] = reserved_by_project_lot.get(key, 0) + r.qty_reserved

    needs: dict[int, dict] = {}
    for p in projects:
        for m in p.materials:
            avail = 0
            for lot in lots_by_loc_type.get((p.output_location_id, m.type_id), []):
                other_reserved = (
                    reserved_total_by_lot.get(lot.id, 0)
                    - reserved_by_project_lot.get((p.id, lot.id), 0)
                )
                free = lot.qty_remaining - other_reserved
                if free > 0:
                    avail += free

            shortfall = max(0, m.quantity_needed - avail)
            if shortfall <= 0:
                continue

            acc = needs.setdefault(m.type_id, {
                "type_id": m.type_id, "qty_shortfall": 0, "projects": set(),
            })
            acc["qty_shortfall"] += shortfall
            acc["projects"].add(p.name)

    return needs
