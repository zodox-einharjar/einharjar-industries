from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..inventory.janice_parser import parse_janice_text
from ..inventory.simple_list_parser import parse_name_qty_text
from ..models import IndustryProject, Location
from ..procurement.ore_pricing import reprice_ore_by_reprocessed_value
from ..settings.router import _load_settings
from ..shopping.router import options as doctrine_scope_options
from .planner import JITA_EVE_ID, PlanInputs, build_buying_plan

router = APIRouter(prefix="/buying", dependencies=[Depends(get_current_character)])


@router.get("/options")
async def options():
    """Everything the Buying page's controls need: the staging → doctrine → fit tree
    (same as Shopping's scope picker), active industry projects, and all locations."""
    scope = await doctrine_scope_options()
    async with AsyncSessionLocal() as session:
        projects = (await session.execute(
            select(IndustryProject)
            .where(IndustryProject.status.in_(["planning", "in_progress"]))
            .order_by(IndustryProject.name)
        )).scalars().all()
        jita = (await session.execute(select(Location).where(Location.eve_id == JITA_EVE_ID))).scalar_one_or_none()
    settings = await _load_settings()
    return {
        "staging": scope["staging"],
        "locations": scope["locations"],
        "jita_location_id": jita.id if jita else None,
        "projects": [
            {"id": p.id, "name": p.name, "status": p.status, "location_id": p.output_location_id}
            for p in projects if p.output_location_id
        ],
        "ore_efficiency_pct": settings.get("reprocessing_efficiency_pct", 90.63),
        "gas_efficiency_pct": settings.get("reprocessing_gas_efficiency_pct", 90.0),
    }


class PlanRequest(BaseModel):
    include_doctrines: bool = True
    doctrine_fit_ids: list[int] | None = None
    fill_pct: float = Field(1.0, ge=0.0, le=5.0)
    doctrine_mode: Literal["fill", "profit"] = "fill"
    window_days: int = Field(14, ge=1, le=90)
    include_projects: bool = True
    project_ids: list[int] | None = None
    want_text: str = ""
    want_location_id: int | None = None
    net_inventory: bool = True
    use_local: bool = True
    use_ore: bool = True
    buyback_text: str = ""
    buyback_price_type: Literal["buy", "sell", "split"] = "buy"
    buyback_location_id: int | None = None
    flip_location_id: int | None = None
    exclude_type_ids: list[int] = []
    # "location_id:type_id" -> quantity to buy instead of the computed need
    qty_overrides: dict[str, int] = {}


@router.post("/plan")
async def plan(body: PlanRequest):
    parsed, parse_errors = (
        parse_janice_text(body.buyback_text, body.buyback_price_type)
        if body.buyback_text.strip() else ([], [])
    )
    buyback = [i for i in parsed if i["ok"]]
    buyback_unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed if not i["ok"]]
    wants, want_unknown = parse_name_qty_text(body.want_text) if body.want_text.strip() else ([], [])

    settings = await _load_settings()
    efficiency = settings.get("reprocessing_efficiency_pct", 90.63) / 100.0
    gas_efficiency = settings.get("reprocessing_gas_efficiency_pct", 90.0) / 100.0
    fee_pct = settings.get("reprocessing_fee_pct", 1.0)

    overrides: dict[tuple[int, int], int] = {}
    for key, qty in body.qty_overrides.items():
        loc, _, tid = key.partition(":")
        if loc.isdigit() and tid.isdigit():
            overrides[(int(loc), int(tid))] = max(0, qty)

    async with AsyncSessionLocal() as session:
        jita = (await session.execute(select(Location).where(Location.eve_id == JITA_EVE_ID))).scalar_one_or_none()
        # Buyback programs usually pay for ore by its reprocessed mineral value, not
        # its own market price — same repricing Procurement applies.
        repriced = await reprice_ore_by_reprocessed_value(
            session, jita.id if jita else None, buyback, body.buyback_price_type,
            efficiency, gas_efficiency, fee_pct,
        ) if buyback else set()

        result = await build_buying_plan(session, PlanInputs(
            include_doctrines=body.include_doctrines,
            doctrine_fit_ids=set(body.doctrine_fit_ids) if body.doctrine_fit_ids is not None else None,
            fill_pct=body.fill_pct,
            doctrine_mode=body.doctrine_mode,
            window_days=body.window_days,
            include_projects=body.include_projects,
            project_ids=body.project_ids or None,
            wants=wants,
            want_location_id=body.want_location_id,
            net_inventory=body.net_inventory,
            use_local=body.use_local,
            use_ore=body.use_ore,
            buyback=buyback,
            buyback_location_id=body.buyback_location_id,
            flip_location_id=body.flip_location_id,
            exclude_type_ids=set(body.exclude_type_ids),
            qty_overrides=overrides,
            efficiency=efficiency,
            gas_efficiency=gas_efficiency,
        ))

    result["buyback"] = {
        "count": len(buyback),
        "unknown": buyback_unknown,
        "parse_errors": parse_errors,
        "repriced_ore": sorted(i["item_name"] for i in buyback if i["type_id"] in repriced),
    }
    result["want_unknown"] = want_unknown
    return result
