from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import Location, MarketOrder, TrackedItem
from ..sde import type_name, type_names
from .tracking import track_items

router = APIRouter(prefix="/market-watch", dependencies=[Depends(get_current_character)])

_JITA_EVE_ID = 60003760

# ESI history returns up to ~400 days; trim to a chart-friendly window.
_HISTORY_DAYS = 180


@router.get("")
async def list_tracked_items():
    async with AsyncSessionLocal() as session:
        tracked = (await session.execute(
            select(TrackedItem).order_by(TrackedItem.added_at.desc())
        )).scalars().all()
        if not tracked:
            return []

        type_ids = [t.type_id for t in tracked]
        names = type_names(type_ids)

        jita_loc = (await session.execute(
            select(Location).where(Location.eve_id == _JITA_EVE_ID)
        )).scalar_one_or_none()

        jita_sell: dict[int, float] = {}
        if jita_loc:
            rows = (await session.execute(
                select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
                .where(MarketOrder.location_id == jita_loc.id)
                .where(MarketOrder.type_id.in_(type_ids))
                .where(MarketOrder.is_buy.is_(False))
                .group_by(MarketOrder.type_id)
            )).all()
            jita_sell = {r.type_id: float(r.price) for r in rows}

        result = [{
            "type_id": t.type_id,
            "name": names.get(t.type_id, f"type:{t.type_id}"),
            "source": t.source,
            "added_at": t.added_at.isoformat(),
            "jita_sell": jita_sell.get(t.type_id),
        } for t in tracked]
        result.sort(key=lambda r: r["name"])
        return result


class TrackItemRequest(_Base):
    type_id: int


@router.post("", status_code=201)
async def track_item(body: TrackItemRequest):
    if type_name(body.type_id) is None:
        raise HTTPException(404, "Unknown item")
    async with AsyncSessionLocal() as session:
        await track_items(session, [body.type_id], source="manual")
        await session.commit()
    return {"ok": True}


@router.delete("/{type_id}", status_code=204)
async def untrack_item(type_id: int):
    async with AsyncSessionLocal() as session:
        row = (await session.execute(
            select(TrackedItem).where(TrackedItem.type_id == type_id)
        )).scalar_one_or_none()
        if row:
            await session.delete(row)
            await session.commit()


def _depth_side(orders: list[MarketOrder], *, descending: bool) -> list[dict]:
    ordered = sorted(orders, key=lambda o: float(o.price), reverse=descending)
    points = []
    cumulative = 0
    for o in ordered:
        cumulative += o.volume_remain
        points.append({"price": float(o.price), "cumulative": cumulative})
    return points


@router.get("/{type_id}")
async def item_detail(type_id: int, location_id: int | None = None):
    name = type_name(type_id)
    if name is None:
        raise HTTPException(404, "Unknown item")

    async with AsyncSessionLocal() as session:
        if location_id is not None:
            location = await session.get(Location, location_id)
            if not location:
                raise HTTPException(404, "Location not found")
        else:
            location = (await session.execute(
                select(Location).where(Location.eve_id == _JITA_EVE_ID)
            )).scalar_one_or_none()

        tracked = (await session.execute(
            select(TrackedItem).where(TrackedItem.type_id == type_id)
        )).scalar_one_or_none() is not None

        history: list[dict] = []
        velocity: list[dict] = []
        if location:
            try:
                rows = await esi.get(
                    f"/markets/{location.region_id}/history/",
                    params={"type_id": type_id},
                )
                rows = rows[-_HISTORY_DAYS:]
                history = [
                    {"date": r["date"], "average": r["average"], "highest": r["highest"], "lowest": r["lowest"]}
                    for r in rows
                ]
                velocity = [
                    {"date": r["date"], "volume": r["volume"], "order_count": r["order_count"]}
                    for r in rows
                ]
            except ESIError:
                pass

        depth = {"buy": [], "sell": []}
        data_as_of = None
        if location:
            orders = (await session.execute(
                select(MarketOrder).where(
                    MarketOrder.location_id == location.id,
                    MarketOrder.type_id == type_id,
                )
            )).scalars().all()
            buy_orders = [o for o in orders if o.is_buy]
            sell_orders = [o for o in orders if not o.is_buy]
            depth = {
                "buy": _depth_side(buy_orders, descending=True),
                "sell": _depth_side(sell_orders, descending=False),
            }
            fetched = (await session.execute(
                select(func.max(MarketOrder.fetched_at)).where(MarketOrder.location_id == location.id)
            )).scalar_one_or_none()
            data_as_of = fetched.isoformat() if fetched else None

        return {
            "type_id": type_id,
            "name": name,
            "tracked": tracked,
            "location": {"id": location.id, "name": location.name} if location else None,
            "history": history,
            "velocity": velocity,
            "depth": depth,
            "data_as_of": data_as_of,
        }
