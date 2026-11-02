"""Item lookup: top-bar search and the item page overview (prices at our locations,
our stock and listings, and which fits, doctrines and projects use the item).

Price history / order-book charts come from /market-watch/{type_id}; this module
only adds the "what do we have and where is it used" side.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..models import (
    Doctrine, DoctrineFit, Fit, FitItem, IndustryProject, InventoryLot, Location,
    LotReservation, MarketListing, MarketOrder, ProjectMaterial, ProjectOutput,
)
from ..sde import get_sde, type_volume

router = APIRouter(prefix="/items", dependencies=[Depends(get_current_character)])

_JITA_EVE_ID = 60003760


@router.get("/search")
async def search(q: str, limit: int = 12):
    """Published, market-listed items whose name contains every word of q.
    Exact match first, blueprints/SKINs last, then names starting with q, then shortest."""
    words = q.strip().split()
    if not words:
        return []
    limit = max(1, min(limit, 30))
    where = " AND ".join("t.typeName LIKE ?" for _ in words)
    phrase = " ".join(words)
    rows = get_sde().execute(
        f"""SELECT t.typeID, t.typeName, g.groupName
            FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
            WHERE t.published = 1 AND t.marketGroupID IS NOT NULL AND {where}
            ORDER BY (lower(t.typeName) = lower(?)) DESC,
                     (g.categoryID IN (9, 91)) ASC,  -- blueprints and SKINs last
                     (t.typeName LIKE ?) DESC,
                     length(t.typeName), t.typeName
            LIMIT ?""",
        [f"%{w}%" for w in words] + [phrase, f"{phrase}%", limit],
    ).fetchall()
    return [{"type_id": r["typeID"], "name": r["typeName"], "group": r["groupName"]} for r in rows]


def _type_info(type_id: int) -> dict | None:
    row = get_sde().execute(
        """SELECT t.typeName, g.groupName, t.marketGroupID
           FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
           WHERE t.typeID = ?""",
        (type_id,),
    ).fetchone()
    if row is None:
        return None
    return {"name": row["typeName"], "group": row["groupName"], "on_market": row["marketGroupID"] is not None}


@router.get("/{type_id}")
async def overview(type_id: int):
    info = _type_info(type_id)
    if info is None:
        raise HTTPException(404, "Unknown item")

    async with AsyncSessionLocal() as session:
        locations = (await session.execute(select(Location))).scalars().all()
        loc_by_id = {l.id: l for l in locations}
        loc_by_eve = {l.eve_id: l for l in locations}

        # Market prices at each location we poll
        price_rows = (await session.execute(
            select(
                MarketOrder.location_id, MarketOrder.is_buy,
                func.min(MarketOrder.price), func.max(MarketOrder.price),
                func.sum(MarketOrder.volume_remain),
            )
            .where(MarketOrder.type_id == type_id)
            .group_by(MarketOrder.location_id, MarketOrder.is_buy)
        )).all()

        # Our stock
        lots = (await session.execute(
            select(InventoryLot)
            .where(InventoryLot.type_id == type_id, InventoryLot.qty_remaining > 0)
        )).scalars().all()
        reserved_rows = []
        if lots:
            reserved_rows = (await session.execute(
                select(LotReservation.lot_id, func.sum(LotReservation.qty_reserved))
                .where(LotReservation.lot_id.in_([l.id for l in lots]))
                .group_by(LotReservation.lot_id)
            )).all()

        listings = (await session.execute(
            select(MarketListing)
            .where(MarketListing.type_id == type_id, MarketListing.status == "active")
            .order_by(MarketListing.list_price)
        )).scalars().all()

        # Fits that contain the item (as a module/charge) or are that hull
        fit_rows = (await session.execute(
            select(Fit.id, Fit.name, Fit.ship_type_id, func.coalesce(func.sum(FitItem.quantity), 0))
            .outerjoin(FitItem, (FitItem.fit_id == Fit.id) & (FitItem.type_id == type_id))
            .group_by(Fit.id, Fit.name, Fit.ship_type_id)
            .having((Fit.ship_type_id == type_id) | (func.sum(FitItem.quantity) > 0))
            .order_by(Fit.name)
        )).all()
        fit_ids = [r[0] for r in fit_rows]
        doctrine_rows = []
        if fit_ids:
            doctrine_rows = (await session.execute(
                select(DoctrineFit.fit_id, DoctrineFit.target_qty, Doctrine.id, Doctrine.name)
                .join(Doctrine, Doctrine.id == DoctrineFit.doctrine_id)
                .where(DoctrineFit.fit_id.in_(fit_ids))
                .order_by(Doctrine.name)
            )).all()

        # Industry projects that are not finished
        mat_rows = (await session.execute(
            select(IndustryProject.id, IndustryProject.name, IndustryProject.status,
                   ProjectMaterial.quantity_needed, ProjectMaterial.quantity_reserved)
            .join(ProjectMaterial, ProjectMaterial.project_id == IndustryProject.id)
            .where(ProjectMaterial.type_id == type_id, IndustryProject.status != "complete")
            .order_by(IndustryProject.name)
        )).all()
        out_rows = (await session.execute(
            select(IndustryProject.id, IndustryProject.name, IndustryProject.status, ProjectOutput.quantity)
            .join(ProjectOutput, ProjectOutput.project_id == IndustryProject.id)
            .where(ProjectOutput.type_id == type_id, IndustryProject.status != "complete")
            .order_by(IndustryProject.name)
        )).all()

    # ── Prices ──
    prices: dict[int, dict] = {}
    for loc_id, is_buy, pmin, pmax, units in price_rows:
        d = prices.setdefault(loc_id, {})
        if is_buy:
            d["buy"] = float(pmax)
            d["buy_units"] = int(units or 0)
        else:
            d["sell"] = float(pmin)
            d["sell_units"] = int(units or 0)

    # ── Stock ──
    reserved_by_lot = {lot_id: int(q or 0) for lot_id, q in reserved_rows}
    stock_by_loc: dict[int | None, dict] = defaultdict(lambda: {"qty": 0, "reserved": 0, "cost": 0.0})
    for lot in lots:
        s = stock_by_loc[lot.location_id]
        s["qty"] += lot.qty_remaining
        s["reserved"] += reserved_by_lot.get(lot.id, 0)
        s["cost"] += lot.qty_remaining * float(lot.unit_cost)

    listed_by_loc: dict[int | None, int] = defaultdict(int)
    listings_out = []
    for m in listings:
        loc = loc_by_eve.get(m.eve_location_id)
        lid = loc.id if loc else None
        listed_by_loc[lid] += m.qty_remaining
        listings_out.append({
            "order_id": m.order_id,
            "location_name": loc.name if loc else f"Location {m.eve_location_id}",
            "qty_remaining": m.qty_remaining,
            "qty_total": m.qty_total,
            "price": float(m.list_price),
            "expires": m.expires.isoformat(),
        })

    jita = loc_by_eve.get(_JITA_EVE_ID)
    jita_sell = prices.get(jita.id, {}).get("sell") if jita else None

    stock_out = []
    for lid, s in stock_by_loc.items():
        loc = loc_by_id.get(lid) if lid is not None else None
        stock_out.append({
            "location_id": lid,
            "location_name": loc.name if loc else "Unknown location",
            "qty": s["qty"],
            "reserved": s["reserved"],
            "on_market": listed_by_loc.get(lid, 0),
            "avg_cost": s["cost"] / s["qty"] if s["qty"] else None,
            "value_jita_sell": s["qty"] * jita_sell if jita_sell is not None else None,
        })
    stock_out.sort(key=lambda r: -r["qty"])

    price_out = []
    for loc in sorted(locations, key=lambda l: (l.eve_id != _JITA_EVE_ID, l.name)):
        p = prices.get(loc.id, {})
        price_out.append({
            "location_id": loc.id,
            "location_name": loc.name,
            "is_jita": loc.eve_id == _JITA_EVE_ID,
            "sell": p.get("sell"),
            "sell_units": p.get("sell_units", 0),
            "buy": p.get("buy"),
            "buy_units": p.get("buy_units", 0),
        })

    # ── Used in ──
    doctrines_by_fit: dict[int, list[dict]] = defaultdict(list)
    for fit_id, target, d_id, d_name in doctrine_rows:
        doctrines_by_fit[fit_id].append({"id": d_id, "name": d_name, "target_qty": target})
    fits_out = [{
        "id": fid,
        "name": fname,
        "hull": ship_tid == type_id,
        # Parsed fits list the hull among their items too; count it once.
        "qty_per_fit": max(int(qty), 1 if ship_tid == type_id else 0),
        "doctrines": doctrines_by_fit.get(fid, []),
    } for fid, fname, ship_tid, qty in fit_rows]

    projects_out = (
        [{"id": pid, "name": n, "status": st, "role": "material", "qty": need, "reserved": res}
         for pid, n, st, need, res in mat_rows]
        + [{"id": pid, "name": n, "status": st, "role": "output", "qty": q, "reserved": None}
           for pid, n, st, q in out_rows]
    )

    return {
        "type_id": type_id,
        "name": info["name"],
        "group": info["group"],
        "on_market": info["on_market"],
        "volume_m3": type_volume(type_id),
        "prices": price_out,
        "stock": stock_out,
        "listings": listings_out,
        "fits": fits_out,
        "projects": projects_out,
    }
