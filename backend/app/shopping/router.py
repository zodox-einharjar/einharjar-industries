from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..doctrines.shortfall import _DOCTRINE_OPTS
from ..inventory.janice_parser import parse_janice_text
from ..models import Doctrine, FreightRoute, Location
from ..sde import type_names
from .planner import JITA_EVE_ID, build_plan

router = APIRouter(prefix="/shopping", dependencies=[Depends(get_current_character)])


@router.get("/options")
async def options():
    """Staging location → doctrine → fit tree for the scope picker, plus every known
    location (for the buyback "delivered at" select)."""
    async with AsyncSessionLocal() as session:
        doctrines = (await session.execute(select(Doctrine).options(*_DOCTRINE_OPTS))).scalars().all()
        all_locs = (await session.execute(select(Location))).scalars().all()
        jita = next((l for l in all_locs if l.eve_id == JITA_EVE_ID), None)
        routed_to = set()
        if jita:
            routed_to = set((await session.execute(
                select(FreightRoute.to_id).where(FreightRoute.from_id == jita.id)
            )).scalars().all())

        ship_names = type_names(list({df.fit.ship_type_id for d in doctrines for df in d.doctrine_fits}))
        by_loc: dict[int, dict] = {}
        for d in sorted(doctrines, key=lambda d: d.name.lower()):
            if not d.location_id or not d.doctrine_fits:
                continue
            loc = by_loc.setdefault(d.location_id, {
                "location_id": d.location_id, "location_name": d.location.name,
                "has_jita_route": d.location_id in routed_to or (jita is not None and d.location_id == jita.id),
                "doctrines": [],
            })
            loc["doctrines"].append({
                "doctrine_id": d.id, "doctrine_name": d.name,
                "fits": [
                    {
                        "doctrine_fit_id": df.id, "fit_name": df.fit.name,
                        "ship_name": ship_names.get(df.fit.ship_type_id, ""), "target_qty": df.target_qty,
                    }
                    for df in sorted(d.doctrine_fits, key=lambda df: df.fit.name.lower())
                ],
            })

        return {
            "staging": sorted(by_loc.values(), key=lambda l: l["location_name"]),
            "locations": [
                {"location_id": l.id, "location_name": l.name}
                for l in sorted(all_locs, key=lambda l: l.name)
            ],
        }


class PlanRequest(BaseModel):
    mode: Literal["fill", "profit"] = "fill"
    doctrine_fit_ids: list[int] | None = None
    fill_pct: float = Field(1.0, ge=0.0, le=5.0)
    net_inventory: bool = True
    window_days: int = Field(14, ge=1, le=90)
    buyback_text: str = ""
    buyback_price_type: Literal["buy", "sell", "split"] = "buy"
    buyback_location_id: int | None = None


@router.post("/plan")
async def plan(body: PlanRequest):
    parsed, parse_errors = parse_janice_text(body.buyback_text, body.buyback_price_type) if body.buyback_text.strip() else ([], [])
    buyback_items = [i for i in parsed if i["ok"]]
    unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed if not i["ok"]]

    async with AsyncSessionLocal() as session:
        result = await build_plan(
            session,
            mode=body.mode,
            doctrine_fit_ids=set(body.doctrine_fit_ids) if body.doctrine_fit_ids is not None else None,
            fill_pct=body.fill_pct,
            net_inventory=body.net_inventory,
            window_days=body.window_days,
            buyback_items=buyback_items,
            buyback_location_id=body.buyback_location_id,
        )

    result["buyback_unknown"] = unknown
    result["buyback_parse_errors"] = parse_errors
    result["buyback_count"] = len(buyback_items)
    return result
