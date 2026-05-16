from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..models import (
    Character, IndustryProject, InventoryLot, Location,
    LotReservation, MarketOrder, ProjectJob, ProjectMaterial, ProjectOutput,
)
from ..sde import search_types, type_id_by_name, type_names

router = APIRouter(prefix="/industry", dependencies=[Depends(get_current_character)])

VALID_CATEGORIES = [
    "Intermediate Composite Reactions",
    "Composite Reactions",
    "Biochem Reactions",
    "Hybrid Reactions",
    "Advanced Components",
    "Capital Components",
    "Others",
    "End Product Jobs",
]


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProjectCreate(_Base):
    name: str
    ravworks_url: str | None = None
    invention_cost: float = 0.0
    blueprint_cost: float = 0.0
    extra_cost: float = 0.0
    target_margin_pct: float | None = None
    output_location_id: int | None = None

class ProjectUpdate(_Base):
    name: str | None = None
    ravworks_url: str | None = None
    invention_cost: float | None = None
    blueprint_cost: float | None = None
    extra_cost: float | None = None
    target_margin_pct: float | None = None
    output_location_id: int | None = None

class MaterialUpsert(_Base):
    type_id: int
    quantity_needed: int

class OutputUpsert(_Base):
    type_id: int
    quantity: int
    is_byproduct: bool = False

class JobPaste(_Base):
    category: str
    text: str  # raw tab-separated paste

class JobUpdate(_Base):
    is_done: bool | None = None
    job_cost: float | None = None

class RawPaste(_Base):
    text: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _project_dict(p: IndustryProject, names: dict) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "status": p.status,
        "ravworks_url": p.ravworks_url,
        "invention_cost": float(p.invention_cost),
        "blueprint_cost": float(p.blueprint_cost),
        "extra_cost": float(p.extra_cost),
        "target_margin_pct": p.target_margin_pct,
        "output_location_id": p.output_location_id,
        "output_location_name": p.output_location.name if p.output_location else None,
        "created_at": p.created_at.isoformat(),
        "completed_at": p.completed_at.isoformat() if p.completed_at else None,
        "materials": [_material_dict(m, names) for m in p.materials],
        "outputs": [_output_dict(o, names) for o in p.outputs],
    }


def _material_dict(m: ProjectMaterial, names: dict) -> dict:
    return {
        "id": m.id,
        "type_id": m.type_id,
        "name": names.get(m.type_id, str(m.type_id)),
        "quantity_needed": m.quantity_needed,
        "quantity_reserved": m.quantity_reserved,
    }


def _output_dict(o: ProjectOutput, names: dict) -> dict:
    return {
        "id": o.id,
        "type_id": o.type_id,
        "name": names.get(o.type_id, str(o.type_id)),
        "quantity": o.quantity,
        "is_byproduct": o.is_byproduct,
    }


async def _get_project(session, project_id: int) -> IndustryProject:
    p = (await session.execute(
        select(IndustryProject)
        .options(
            selectinload(IndustryProject.materials).selectinload(ProjectMaterial.reservations),
            selectinload(IndustryProject.outputs),
            selectinload(IndustryProject.jobs),
            selectinload(IndustryProject.output_location),
        )
        .where(IndustryProject.id == project_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Project not found")
    return p


async def _get_character_id(session) -> int:
    char = (await session.execute(select(Character).limit(1))).scalar_one_or_none()
    if not char:
        raise HTTPException(401, "No character")
    return char.id


# ── Project CRUD ──────────────────────────────────────────────────────────────

@router.get("")
async def list_projects():
    async with AsyncSessionLocal() as session:
        projects = (await session.execute(
            select(IndustryProject)
            .options(
                selectinload(IndustryProject.materials),
                selectinload(IndustryProject.outputs),
                selectinload(IndustryProject.jobs),
                selectinload(IndustryProject.output_location),
            )
            .order_by(IndustryProject.created_at.desc())
        )).scalars().all()

    all_type_ids = set()
    for p in projects:
        for m in p.materials:
            all_type_ids.add(m.type_id)
        for o in p.outputs:
            all_type_ids.add(o.type_id)
    names = type_names(list(all_type_ids))

    return [_project_dict(p, names) for p in projects]


@router.post("")
async def create_project(body: ProjectCreate):
    async with AsyncSessionLocal() as session:
        char_id = await _get_character_id(session)
        p = IndustryProject(
            name=body.name,
            status="planning",
            ravworks_url=body.ravworks_url,
            invention_cost=Decimal(str(body.invention_cost)),
            blueprint_cost=Decimal(str(body.blueprint_cost)),
            extra_cost=Decimal(str(body.extra_cost)),
            target_margin_pct=body.target_margin_pct,
            output_location_id=body.output_location_id,
            character_id=char_id,
            created_at=datetime.now(timezone.utc),
        )
        session.add(p)
        await session.flush()
        project_id = p.id
        await session.commit()

    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        names = type_names([m.type_id for m in p.materials] + [o.type_id for o in p.outputs])
        return _project_dict(p, names)


@router.get("/{project_id}")
async def get_project(project_id: int):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        all_type_ids = [m.type_id for m in p.materials] + [o.type_id for o in p.outputs]
        names = type_names(all_type_ids)

        # Inventory availability per material type
        availability = {}
        if p.materials:
            type_ids = [m.type_id for m in p.materials]
            lots = (await session.execute(
                select(InventoryLot)
                .where(InventoryLot.type_id.in_(type_ids))
                .where(InventoryLot.qty_remaining > 0)
            )).scalars().all()

            # Total reserved qty per type across ALL projects
            reservations = (await session.execute(
                select(LotReservation.lot_id, func.sum(LotReservation.qty_reserved).label("total"))
                .join(InventoryLot, LotReservation.lot_id == InventoryLot.id)
                .where(InventoryLot.type_id.in_(type_ids))
                .where(LotReservation.project_id != project_id)
                .group_by(LotReservation.lot_id)
            )).all()
            reserved_by_lot = {r.lot_id: int(r.total) for r in reservations}

            for lot in lots:
                other_reserved = reserved_by_lot.get(lot.id, 0)
                available = lot.qty_remaining - other_reserved
                if available > 0:
                    availability[lot.type_id] = availability.get(lot.type_id, 0) + available

        # Material cost:
        # - complete: frozen at completion time
        # - in_progress: use actual reservation lot costs
        # - planning: FIFO-simulate from available lots
        material_cost = 0.0
        if p.status == "complete":
            material_cost = float(p.frozen_material_cost) if p.frozen_material_cost is not None else 0.0
        elif p.status == "in_progress":
            own_reservations = (await session.execute(
                select(LotReservation)
                .options(selectinload(LotReservation.lot))
                .where(LotReservation.project_id == project_id)
            )).scalars().all()
            material_cost = sum(float(r.qty_reserved * r.lot.unit_cost) for r in own_reservations)
        elif p.materials:
            type_ids = [m.type_id for m in p.materials]
            all_lots = (await session.execute(
                select(InventoryLot)
                .where(InventoryLot.type_id.in_(type_ids))
                .where(InventoryLot.qty_remaining > 0)
                .order_by(InventoryLot.purchased_at)
            )).scalars().all()
            lots_by_type: dict[int, list[InventoryLot]] = {}
            for lot in all_lots:
                lots_by_type.setdefault(lot.type_id, []).append(lot)
            for m in p.materials:
                needed = m.quantity_needed
                for lot in lots_by_type.get(m.type_id, []):
                    free = lot.qty_remaining - reserved_by_lot.get(lot.id, 0)
                    take = min(needed, max(0, free))
                    material_cost += take * float(lot.unit_cost)
                    needed -= take
                    if needed <= 0:
                        break

        material_rows = []
        for m in p.materials:
            avail = availability.get(m.type_id, 0)
            material_rows.append({
                **_material_dict(m, names),
                "qty_available_in_inventory": avail,
                "qty_shortfall": max(0, m.quantity_needed - avail),
            })

        jobs_by_category = {cat: [] for cat in VALID_CATEGORIES}
        for job in sorted(p.jobs, key=lambda j: j.sort_order):
            if job.category in jobs_by_category:
                jobs_by_category[job.category].append({
                    "id": job.id,
                    "name": job.name,
                    "runs": job.runs,
                    "days": job.days,
                    "job_cost": float(job.job_cost),
                    "is_done": job.is_done,
                })

        total_runs_cost = sum(float(j.job_cost) for j in p.jobs)
        total_fixed_cost = float(p.invention_cost + p.blueprint_cost + p.extra_cost)
        total_cost = total_runs_cost + total_fixed_cost

        # Jita prices for all outputs (primary: min sell; byproducts: split)
        all_output_type_ids = [o.type_id for o in p.outputs]
        primary_type_ids = {o.type_id for o in p.outputs if not o.is_byproduct}
        jita_sell_by_type: dict[int, float] = {}
        if all_output_type_ids:
            jita_loc = (await session.execute(
                select(Location).where(Location.eve_id == 60003760)
            )).scalar_one_or_none()
            if jita_loc:
                mkt_rows = (await session.execute(
                    select(
                        MarketOrder.type_id,
                        MarketOrder.is_buy,
                        func.min(MarketOrder.price).label("min_p"),
                        func.max(MarketOrder.price).label("max_p"),
                    )
                    .where(MarketOrder.location_id == jita_loc.id)
                    .where(MarketOrder.type_id.in_(all_output_type_ids))
                    .group_by(MarketOrder.type_id, MarketOrder.is_buy)
                )).all()
                by_type: dict[int, dict] = {}
                for row in mkt_rows:
                    d = by_type.setdefault(row.type_id, {})
                    if row.is_buy:
                        d["buy"] = float(row.max_p)
                    else:
                        d["sell"] = float(row.min_p)
                for tid, d in by_type.items():
                    if tid in primary_type_ids:
                        if "sell" in d:
                            jita_sell_by_type[tid] = d["sell"]
                    else:
                        buy = d.get("buy", 0.0)
                        sell = d.get("sell", 0.0)
                        if buy and sell:
                            jita_sell_by_type[tid] = (buy + sell) / 2
                        elif sell:
                            jita_sell_by_type[tid] = sell
                        elif buy:
                            jita_sell_by_type[tid] = buy

        output_rows = []
        estimated_revenue = 0.0
        estimated_byproduct_value = 0.0
        for o in p.outputs:
            jita_sell = jita_sell_by_type.get(o.type_id)
            if jita_sell is not None:
                if o.is_byproduct:
                    estimated_byproduct_value += jita_sell * o.quantity
                else:
                    estimated_revenue += jita_sell * o.quantity
            output_rows.append({
                **_output_dict(o, names),
                "jita_sell": jita_sell,
            })

        full_total_cost = total_cost + material_cost
        estimated_profit = estimated_revenue - full_total_cost if estimated_revenue > 0 else None

        return {
            **_project_dict(p, names),
            "materials": material_rows,
            "outputs": output_rows,
            "jobs_by_category": jobs_by_category,
            "total_runs_cost": total_runs_cost,
            "material_cost": material_cost,
            "total_cost": full_total_cost,
            "estimated_revenue": estimated_revenue if estimated_revenue > 0 else None,
            "estimated_profit": estimated_profit,
            "estimated_byproduct_value": estimated_byproduct_value if estimated_byproduct_value > 0 else None,
        }


@router.patch("/{project_id}")
async def update_project(project_id: int, body: ProjectUpdate):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if body.name is not None:
            p.name = body.name
        if body.ravworks_url is not None:
            p.ravworks_url = body.ravworks_url
        if body.invention_cost is not None:
            p.invention_cost = Decimal(str(body.invention_cost))
        if body.blueprint_cost is not None:
            p.blueprint_cost = Decimal(str(body.blueprint_cost))
        if body.extra_cost is not None:
            p.extra_cost = Decimal(str(body.extra_cost))
        if body.target_margin_pct is not None:
            p.target_margin_pct = body.target_margin_pct
        if "output_location_id" in body.model_fields_set:
            p.output_location_id = body.output_location_id
        await session.commit()

    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        names = type_names([m.type_id for m in p.materials] + [o.type_id for o in p.outputs])
        return _project_dict(p, names)


@router.delete("/{project_id}")
async def delete_project(project_id: int):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status == "in_progress":
            raise HTTPException(400, "Cannot delete an in-progress project — cancel it first")
        await session.delete(p)
        await session.commit()
    return {"ok": True}


# ── Status Transitions ────────────────────────────────────────────────────────

@router.post("/{project_id}/start")
async def start_project(project_id: int):
    """Planning → In Progress: FIFO-reserve materials from inventory."""
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "planning":
            raise HTTPException(400, f"Project is {p.status}, not planning")
        if not p.materials:
            raise HTTPException(400, "Add materials before starting")

        type_ids = [m.type_id for m in p.materials]

        # Load all relevant lots ordered FIFO
        lots_by_type: dict[int, list[InventoryLot]] = {}
        for tid in type_ids:
            lots = (await session.execute(
                select(InventoryLot)
                .where(InventoryLot.type_id == tid)
                .where(InventoryLot.qty_remaining > 0)
                .order_by(InventoryLot.purchased_at)
            )).scalars().all()
            lots_by_type[tid] = list(lots)

        # Calculate already-reserved qty per lot from other projects
        existing_res = (await session.execute(
            select(LotReservation.lot_id, func.sum(LotReservation.qty_reserved).label("total"))
            .group_by(LotReservation.lot_id)
        )).all()
        reserved_by_lot: dict[int, int] = {r.lot_id: int(r.total) for r in existing_res}

        names = type_names(type_ids)
        shortfalls = []

        for mat in p.materials:
            lots = lots_by_type.get(mat.type_id, [])
            needed = mat.quantity_needed
            available_total = sum(
                max(0, l.qty_remaining - reserved_by_lot.get(l.id, 0)) for l in lots
            )
            if available_total < needed:
                shortfalls.append(
                    f"{names.get(mat.type_id, str(mat.type_id))}: "
                    f"need {needed:,}, have {available_total:,}"
                )

        if shortfalls:
            raise HTTPException(400, {"shortfalls": shortfalls})

        # Create reservations FIFO
        for mat in p.materials:
            lots = lots_by_type.get(mat.type_id, [])
            remaining = mat.quantity_needed
            for lot in lots:
                if remaining <= 0:
                    break
                free = lot.qty_remaining - reserved_by_lot.get(lot.id, 0)
                if free <= 0:
                    continue
                take = min(remaining, free)
                session.add(LotReservation(
                    lot_id=lot.id,
                    project_id=project_id,
                    material_id=mat.id,
                    qty_reserved=take,
                ))
                reserved_by_lot[lot.id] = reserved_by_lot.get(lot.id, 0) + take
                remaining -= take
            mat.quantity_reserved = mat.quantity_needed

        p.status = "in_progress"
        await session.commit()

    return {"ok": True, "status": "in_progress"}


@router.post("/{project_id}/complete")
async def complete_project(project_id: int):
    """In Progress → Complete: consume reservations, add output lots."""
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "in_progress":
            raise HTTPException(400, f"Project is {p.status}, not in_progress")
        if not p.outputs:
            raise HTTPException(400, "Add outputs before completing")
        if not p.output_location_id:
            raise HTTPException(400, "Set an output location before completing")

        # Gather all reservations for this project
        reservations = (await session.execute(
            select(LotReservation)
            .options(selectinload(LotReservation.lot))
            .where(LotReservation.project_id == project_id)
        )).scalars().all()

        # Compute material cost from reserved lots
        material_cost = Decimal(0)
        for res in reservations:
            material_cost += res.qty_reserved * res.lot.unit_cost

        # Consume reserved lots
        for res in reservations:
            res.lot.qty_remaining -= res.qty_reserved
            await session.delete(res)

        # Total project cost
        run_cost = sum(j.job_cost for j in p.jobs)
        total_cost = (
            material_cost
            + p.invention_cost
            + p.blueprint_cost
            + p.extra_cost
            + run_cost
        )

        # Split cost across primary outputs
        primary_outputs = [o for o in p.outputs if not o.is_byproduct]
        byproduct_outputs = [o for o in p.outputs if o.is_byproduct]
        total_primary_units = sum(o.quantity for o in primary_outputs)
        unit_cost = (total_cost / total_primary_units) if total_primary_units else Decimal(0)

        now = datetime.now(timezone.utc)

        # Look up Jita split price for byproducts
        jita_loc = (await session.execute(
            select(Location).where(Location.eve_id == 60003760)
        )).scalar_one_or_none()

        byproduct_type_ids = [o.type_id for o in byproduct_outputs]
        jita_prices: dict[int, Decimal] = {}
        if jita_loc and byproduct_type_ids:
            mkt_rows = (await session.execute(
                select(
                    MarketOrder.type_id,
                    MarketOrder.is_buy,
                    func.min(MarketOrder.price).label("min_p"),
                    func.max(MarketOrder.price).label("max_p"),
                )
                .where(MarketOrder.location_id == jita_loc.id)
                .where(MarketOrder.type_id.in_(byproduct_type_ids))
                .group_by(MarketOrder.type_id, MarketOrder.is_buy)
            )).all()
            by_type: dict[int, dict] = {}
            for row in mkt_rows:
                d = by_type.setdefault(row.type_id, {})
                if row.is_buy:
                    d["buy"] = row.max_p
                else:
                    d["sell"] = row.min_p
            for tid, d in by_type.items():
                buy = d.get("buy", Decimal(0))
                sell = d.get("sell", Decimal(0))
                if buy and sell:
                    jita_prices[tid] = (buy + sell) / 2
                elif sell:
                    jita_prices[tid] = sell
                elif buy:
                    jita_prices[tid] = buy

        type_ids_all = [o.type_id for o in p.outputs]
        names = type_names(type_ids_all)

        # Add primary output lots
        for o in primary_outputs:
            session.add(InventoryLot(
                type_id=o.type_id,
                item_name=names.get(o.type_id, str(o.type_id)),
                location_id=p.output_location_id,
                qty_original=o.quantity,
                qty_remaining=o.quantity,
                unit_cost=unit_cost,
                purchased_at=now,
                source="industry",
            ))

        # Add byproduct lots at Jita split (0 if no market data)
        for o in byproduct_outputs:
            bp_cost = jita_prices.get(o.type_id, Decimal(0))
            session.add(InventoryLot(
                type_id=o.type_id,
                item_name=names.get(o.type_id, str(o.type_id)),
                location_id=p.output_location_id,
                qty_original=o.quantity,
                qty_remaining=o.quantity,
                unit_cost=bp_cost,
                purchased_at=now,
                source="industry",
            ))

        p.frozen_material_cost = material_cost
        p.status = "complete"
        p.completed_at = now
        await session.commit()

    return {"ok": True, "status": "complete"}


@router.post("/{project_id}/cancel")
async def cancel_project(project_id: int):
    """In Progress → Planning: release all reservations."""
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "in_progress":
            raise HTTPException(400, f"Project is {p.status}, not in_progress")

        reservations = (await session.execute(
            select(LotReservation).where(LotReservation.project_id == project_id)
        )).scalars().all()
        for res in reservations:
            await session.delete(res)

        for mat in p.materials:
            mat.quantity_reserved = 0

        p.status = "planning"
        await session.commit()

    return {"ok": True, "status": "planning"}


# ── Materials ─────────────────────────────────────────────────────────────────

@router.post("/{project_id}/materials")
async def add_material(project_id: int, body: MaterialUpsert):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "planning":
            raise HTTPException(400, "Can only add materials in planning status")

        existing = next((m for m in p.materials if m.type_id == body.type_id), None)
        if existing:
            existing.quantity_needed = body.quantity_needed
        else:
            session.add(ProjectMaterial(
                project_id=project_id,
                type_id=body.type_id,
                quantity_needed=body.quantity_needed,
            ))
        await session.commit()
    return {"ok": True}


@router.delete("/{project_id}/materials/{material_id}")
async def remove_material(project_id: int, material_id: int):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "planning":
            raise HTTPException(400, "Can only remove materials in planning status")
        mat = next((m for m in p.materials if m.id == material_id), None)
        if not mat:
            raise HTTPException(404, "Material not found")
        await session.delete(mat)
        await session.commit()
    return {"ok": True}


# ── Outputs ───────────────────────────────────────────────────────────────────

@router.post("/{project_id}/outputs")
async def add_output(project_id: int, body: OutputUpsert):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status == "complete":
            raise HTTPException(400, "Project is already complete")

        existing = next(
            (o for o in p.outputs if o.type_id == body.type_id and o.is_byproduct == body.is_byproduct),
            None,
        )
        if existing:
            existing.quantity = body.quantity
        else:
            session.add(ProjectOutput(
                project_id=project_id,
                type_id=body.type_id,
                quantity=body.quantity,
                is_byproduct=body.is_byproduct,
            ))
        await session.commit()
    return {"ok": True}


@router.delete("/{project_id}/outputs/{output_id}")
async def remove_output(project_id: int, output_id: int):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status == "complete":
            raise HTTPException(400, "Project is already complete")
        out = next((o for o in p.outputs if o.id == output_id), None)
        if not out:
            raise HTTPException(404, "Output not found")
        await session.delete(out)
        await session.commit()
    return {"ok": True}


# ── Bulk paste: materials table ───────────────────────────────────────────────

@router.post("/{project_id}/materials/paste")
async def paste_materials(project_id: int, body: RawPaste):
    """
    Parse a Ravworks materials table.
    Columns: Name | To Buy | To Buy (Sell-Value) | To Buy Volume | Start Amount | End Amount
    - To Buy > 0  → input material
    - End Amount > 0 → byproduct output
    Replaces all existing materials and byproduct outputs.
    """
    lines = [l for l in body.text.strip().splitlines() if l.strip()]

    inputs: list[tuple[int, str, int]] = []   # (type_id, name, qty)
    byproducts: list[tuple[int, str, int]] = []
    skipped: list[str] = []

    for line in lines:
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 6:
            continue
        name = parts[0]
        if name.lower() == "name":
            continue  # header row
        try:
            to_buy = int(parts[1].replace(",", "") or "0")
            end_amount = int(parts[5].replace(",", "") or "0")
        except ValueError:
            skipped.append(name)
            continue

        tid = type_id_by_name(name)
        if tid is None:
            skipped.append(name)
            continue

        if to_buy > 0:
            inputs.append((tid, name, to_buy))
        if end_amount > 0:
            byproducts.append((tid, name, end_amount))

    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status != "planning":
            raise HTTPException(400, "Can only update materials in planning status")

        # Delete existing materials and byproduct outputs
        for m in list(p.materials):
            await session.delete(m)
        for o in [o for o in p.outputs if o.is_byproduct]:
            await session.delete(o)
        await session.flush()

        for tid, name, qty in inputs:
            session.add(ProjectMaterial(project_id=project_id, type_id=tid, quantity_needed=qty))
        for tid, name, qty in byproducts:
            session.add(ProjectOutput(project_id=project_id, type_id=tid, quantity=qty, is_byproduct=True))

        await session.commit()

    return {
        "ok": True,
        "materials_added": len(inputs),
        "byproducts_added": len(byproducts),
        "skipped": skipped,
    }


# ── Bulk paste: outputs table ─────────────────────────────────────────────────

@router.post("/{project_id}/outputs/paste")
async def paste_outputs(project_id: int, body: RawPaste):
    """
    Parse a Ravworks outputs table.
    Columns: Name | Amount | Volume | Sell Price/Unit | Sell Price
    Replaces all existing primary outputs.
    """
    lines = [l for l in body.text.strip().splitlines() if l.strip()]

    outputs: list[tuple[int, str, int]] = []
    skipped: list[str] = []

    for line in lines:
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 2:
            continue
        name = parts[0]
        if name.lower() == "name":
            continue
        try:
            amount = int(parts[1].replace(",", "") or "0")
        except ValueError:
            skipped.append(name)
            continue

        if amount <= 0:
            continue

        tid = type_id_by_name(name)
        if tid is None:
            skipped.append(name)
            continue

        outputs.append((tid, name, amount))

    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        if p.status == "complete":
            raise HTTPException(400, "Project is already complete")

        # Delete existing primary outputs only
        for o in [o for o in p.outputs if not o.is_byproduct]:
            await session.delete(o)
        await session.flush()

        for tid, name, qty in outputs:
            session.add(ProjectOutput(project_id=project_id, type_id=tid, quantity=qty, is_byproduct=False))

        await session.commit()

    return {"ok": True, "outputs_added": len(outputs), "skipped": skipped}


# ── Jobs ──────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/jobs/paste")
async def paste_jobs(project_id: int, body: JobPaste):
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"Invalid category. Must be one of: {VALID_CATEGORIES}")

    lines = [l.strip() for l in body.text.strip().splitlines() if l.strip()]
    parsed = []
    errors = []

    for i, line in enumerate(lines):
        parts = [p.strip() for p in line.split("\t") if p.strip()]
        if len(parts) < 4:
            errors.append(f"Line {i + 1}: expected at least 4 columns (Name, Runs, [ME,] Days, Job Cost)")
            continue
        # Skip header row
        if parts[0].lower() == "name":
            continue
        try:
            name = parts[0]
            runs = int(parts[1].replace(",", ""))
            # 5-col format has ME between Runs and Days (Name|Runs|ME|Days|Job Cost)
            if len(parts) >= 5:
                days = float(parts[3].replace(",", ""))
                cost = Decimal(parts[4].replace(",", ""))
            else:
                days = float(parts[2].replace(",", ""))
                cost = Decimal(parts[3].replace(",", ""))
            parsed.append((name, runs, days, cost))
        except (ValueError, Exception):
            errors.append(f"Line {i + 1}: could not parse '{line}'")

    if errors:
        raise HTTPException(400, {"errors": errors})

    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)

        # Delete existing jobs in this category and replace
        existing = [j for j in p.jobs if j.category == body.category]
        for j in existing:
            await session.delete(j)
        await session.flush()

        for order, (name, runs, days, cost) in enumerate(parsed):
            session.add(ProjectJob(
                project_id=project_id,
                category=body.category,
                name=name,
                runs=runs,
                days=days,
                job_cost=cost,
                sort_order=order,
            ))

        await session.commit()

    return {"ok": True, "imported": len(parsed)}


@router.patch("/{project_id}/jobs/{job_id}")
async def update_job(project_id: int, job_id: int, body: JobUpdate):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        job = next((j for j in p.jobs if j.id == job_id), None)
        if not job:
            raise HTTPException(404, "Job not found")
        if body.is_done is not None:
            job.is_done = body.is_done
        if body.job_cost is not None:
            job.job_cost = Decimal(str(body.job_cost))
        await session.commit()
    return {"ok": True}


@router.delete("/{project_id}/jobs/{job_id}")
async def delete_job(project_id: int, job_id: int):
    async with AsyncSessionLocal() as session:
        p = await _get_project(session, project_id)
        job = next((j for j in p.jobs if j.id == job_id), None)
        if not job:
            raise HTTPException(404, "Job not found")
        await session.delete(job)
        await session.commit()
    return {"ok": True}


# ── Item search (for material/output picker) ──────────────────────────────────

@router.get("/search/items")
async def search_items(q: str):
    return search_types(q, limit=20)
