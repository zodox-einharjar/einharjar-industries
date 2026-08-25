from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import IndustryProject, InventoryLot, LotReservation
from ..sde import type_names


async def aggregate_project_needs(
    session, project_ids: list[int] | None = None, ignore_inventory: bool = False,
) -> dict[tuple[int, int], dict]:
    """Cross-project material shortfall aggregation, keyed by (output_location_id, type_id).

    Mirrors doctrines.shortfall.aggregate_shortfalls() but sourced from
    ProjectMaterial vs. inventory for planning/in_progress projects. Each
    entry: {type_id, name, qty_shortfall, projects: {project_name, ...}}.

    project_ids restricts to a specific set of projects (None/empty = every active
    project, the default). ignore_inventory skips netting against owned stock
    entirely — every material's full quantity_needed counts as "shortfall," for
    planning a from-scratch buy rather than topping up what's missing.
    """
    query = select(IndustryProject).where(IndustryProject.status.in_(["planning", "in_progress"]))
    if project_ids:
        query = query.where(IndustryProject.id.in_(project_ids))
    projects = (await session.execute(
        query.options(selectinload(IndustryProject.materials))
    )).scalars().all()
    # A project with no output location has no "correct location" to check stock
    # against, so it can't be scored — same convention as doctrines/shortfall.py
    # skipping doctrines with no staging location.
    projects = [p for p in projects if p.output_location_id]

    type_ids = {m.type_id for p in projects for m in p.materials}
    if not type_ids:
        return {}
    names = type_names(list(type_ids))

    lots_by_loc_type: dict[tuple[int, int], list[InventoryLot]] = {}
    reserved_total_by_lot: dict[int, int] = {}
    reserved_by_project_lot: dict[tuple[int, int], int] = {}

    if not ignore_inventory:
        lots = (await session.execute(
            select(InventoryLot)
            .where(InventoryLot.type_id.in_(type_ids))
            .where(InventoryLot.qty_remaining > 0)
        )).scalars().all()
        for lot in lots:
            if lot.location_id is not None:
                lots_by_loc_type.setdefault((lot.location_id, lot.type_id), []).append(lot)

        all_reservations = (await session.execute(
            select(LotReservation.lot_id, LotReservation.project_id, LotReservation.qty_reserved)
            .join(InventoryLot, LotReservation.lot_id == InventoryLot.id)
            .where(InventoryLot.type_id.in_(type_ids))
        )).all()
        for r in all_reservations:
            reserved_total_by_lot[r.lot_id] = reserved_total_by_lot.get(r.lot_id, 0) + r.qty_reserved
            key = (r.project_id, r.lot_id)
            reserved_by_project_lot[key] = reserved_by_project_lot.get(key, 0) + r.qty_reserved

    needs: dict[tuple[int, int], dict] = {}
    for p in projects:
        for m in p.materials:
            if ignore_inventory:
                shortfall = m.quantity_needed
            else:
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

            key = (p.output_location_id, m.type_id)
            acc = needs.setdefault(key, {
                "type_id": m.type_id, "name": names.get(m.type_id, f"[{m.type_id}]"),
                "qty_shortfall": 0, "projects": set(),
            })
            acc["qty_shortfall"] += shortfall
            acc["projects"].add(p.name)

    return needs
