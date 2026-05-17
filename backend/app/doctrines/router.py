import logging
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import delete, func, select
from sqlalchemy.orm import selectinload

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import esi
from ..market.poller import poll_location
from ..models import (
    Doctrine, DoctrineFit, Fit, FitItem, FreightRoute, InventoryLot, Location, MarketOrder,
)
from ..sde import region_id_for_station, region_id_for_system
from .availability import calculate
from .eft import EFTParseError, parse_eft

logger = logging.getLogger(__name__)

_AVAIL_STATUS = {"green": "ready", "yellow": "partial", "orange": "partial", "red": "short"}
_FIT_STATUS   = {"green": "stocked", "yellow": "low", "orange": "low", "red": "short"}

router = APIRouter(dependencies=[Depends(get_current_character)])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LocationCreate(_Base):
    name: str
    eve_id: int
    location_type: str
    system_id: int | None = None

class LocationFeeUpdate(_Base):
    broker_fee_pct: float | None = None
    sales_tax_pct: float | None = None
    scc_surcharge_pct: float | None = None
    region_id: int | None = None
    system_id: int | None = None

class FreightRouteCreate(_Base):
    from_id: int
    to_id: int
    isk_per_m3: float
    value_pct: float

class FreightRouteUpdate(_Base):
    from_id: int | None = None
    to_id: int | None = None
    isk_per_m3: float | None = None
    value_pct: float | None = None

class DoctrineCreate(_Base):
    name: str
    description: str | None = None
    location_id: int | None = None

class DoctrineUpdate(_Base):
    name: str | None = None
    description: str | None = None
    location_id: int | None = None

class DoctrineFitAdd(_Base):
    fit_id: int
    target_qty: int = 1

class FitCreate(_Base):
    eft: str

class FitUpdate(_Base):
    name: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _loc_dict(loc: Location) -> dict:
    return {
        "id": loc.id, "name": loc.name, "eve_id": loc.eve_id,
        "location_type": loc.location_type, "region_id": loc.region_id, "system_id": loc.system_id,
        "broker_fee_pct": loc.broker_fee_pct,
        "sales_tax_pct": loc.sales_tax_pct,
        "scc_surcharge_pct": loc.scc_surcharge_pct,
    }

def _route_dict(r: FreightRoute) -> dict:
    return {
        "id": r.id, "from_id": r.from_id, "from_name": r.from_location.name,
        "to_id": r.to_id, "to_name": r.to_location.name,
        "isk_per_m3": float(r.isk_per_m3), "value_pct": float(r.value_pct * 100),
    }

def _load_route_q(route_id: int):
    return (
        select(FreightRoute)
        .options(selectinload(FreightRoute.from_location), selectinload(FreightRoute.to_location))
        .where(FreightRoute.id == route_id)
    )

async def _orders_for_doctrines(session, doctrines: list) -> dict:
    """Returns {(loc_id, type_id): total_volume} across all doctrine staging locations."""
    loc_ids = {d.location_id for d in doctrines if d.location_id}
    if not loc_ids:
        return {}
    type_ids = {
        item.type_id
        for d in doctrines if d.location_id
        for df in d.doctrine_fits
        for item in df.fit.items
    }
    if not type_ids:
        return {}
    rows = (await session.execute(
        select(MarketOrder).where(
            MarketOrder.location_id.in_(loc_ids),
            MarketOrder.type_id.in_(list(type_ids)),
            MarketOrder.is_buy.is_(False),
        )
    )).scalars().all()
    result: dict = defaultdict(int)
    for o in rows:
        result[(o.location_id, o.type_id)] += o.volume_remain
    return result

def _fit_completable(df: DoctrineFit, loc_id: int, orders_map: dict) -> int:
    min_fits = None
    for item in df.fit.items:
        avail = orders_map.get((loc_id, item.type_id), 0)
        fits = avail // item.quantity if item.quantity else 0
        min_fits = fits if min_fits is None else min(min_fits, fits)
    return min_fits if min_fits is not None else 0

def _doctrine_status(doctrine: Doctrine, orders_map: dict) -> str:
    if not doctrine.location_id or not doctrine.doctrine_fits:
        return "unknown"
    loc_id = doctrine.location_id
    statuses = []
    for df in doctrine.doctrine_fits:
        c = _fit_completable(df, loc_id, orders_map)
        statuses.append("ready" if c >= df.target_qty else "partial" if c > 0 else "short")
    if not statuses:
        return "unknown"
    if all(s == "ready" for s in statuses):
        return "ready"
    if all(s == "short" for s in statuses):
        return "short"
    return "partial"

_DOCTRINE_OPTS = (
    selectinload(Doctrine.doctrine_fits).options(
        selectinload(DoctrineFit.fit).options(selectinload(Fit.items))
    ),
    selectinload(Doctrine.location),
)


# ── Locations ─────────────────────────────────────────────────────────────────

@router.get("/locations")
async def locations_list():
    async with AsyncSessionLocal() as session:
        locs = (await session.execute(select(Location))).scalars().all()
    return [_loc_dict(l) for l in locs]


@router.post("/locations", status_code=201)
async def create_location(body: LocationCreate):
    region_id = (
        region_id_for_station(body.eve_id)
        or (region_id_for_system(body.system_id) if body.system_id else None)
        or 0
    )
    async with AsyncSessionLocal() as session:
        loc = Location(
            name=body.name,
            eve_id=body.eve_id,
            location_type=body.location_type,
            region_id=region_id,
            system_id=body.system_id,
        )
        session.add(loc)
        await session.flush()
        result = _loc_dict(loc)
        await session.commit()
    return result


@router.patch("/locations/{location_id}")
async def update_location_fees(location_id: int, body: LocationFeeUpdate):
    async with AsyncSessionLocal() as session:
        loc = await session.get(Location, location_id)
        if not loc:
            raise HTTPException(404, "Location not found")
        if body.broker_fee_pct is not None:
            loc.broker_fee_pct = body.broker_fee_pct
        if body.sales_tax_pct is not None:
            loc.sales_tax_pct = body.sales_tax_pct
        if body.scc_surcharge_pct is not None:
            loc.scc_surcharge_pct = body.scc_surcharge_pct
        if body.region_id is not None:
            loc.region_id = body.region_id
        if "system_id" in body.model_fields_set:
            loc.system_id = body.system_id
        await session.commit()
        await session.refresh(loc)
    return _loc_dict(loc)


@router.delete("/locations/{location_id}", status_code=204)
async def delete_location(location_id: int):
    async with AsyncSessionLocal() as session:
        lot_count = (await session.execute(
            select(func.count()).select_from(InventoryLot)
            .where(InventoryLot.location_id == location_id)
            .where(InventoryLot.qty_remaining > 0)
        )).scalar_one()
        if lot_count:
            raise HTTPException(409, f"Cannot remove: {lot_count} active inventory lot(s) exist at this location. Sell or transfer them first.")
        await session.execute(delete(Location).where(Location.id == location_id))
        await session.commit()


@router.post("/locations/{location_id}/poll")
async def trigger_poll(location_id: int):
    await poll_location(location_id)
    return {"ok": True}


# ── Freight routes ────────────────────────────────────────────────────────────

@router.get("/freight-routes")
async def freight_routes_list():
    async with AsyncSessionLocal() as session:
        routes = (await session.execute(
            select(FreightRoute).options(
                selectinload(FreightRoute.from_location),
                selectinload(FreightRoute.to_location),
            )
        )).scalars().all()
    return [_route_dict(r) for r in routes]


@router.post("/freight-routes", status_code=201)
async def create_freight_route(body: FreightRouteCreate):
    async with AsyncSessionLocal() as session:
        route = FreightRoute(
            from_id=body.from_id, to_id=body.to_id,
            isk_per_m3=Decimal(str(body.isk_per_m3)),
            value_pct=Decimal(str(body.value_pct)) / 100,
        )
        session.add(route)
        await session.flush()
        loaded = (await session.execute(_load_route_q(route.id))).scalar_one()
        result = _route_dict(loaded)
        await session.commit()
    return result


@router.put("/freight-routes/{route_id}")
async def update_freight_route(route_id: int, body: FreightRouteUpdate):
    async with AsyncSessionLocal() as session:
        route = (await session.execute(_load_route_q(route_id))).scalar_one_or_none()
        if not route:
            raise HTTPException(status_code=404)
        if body.from_id is not None:
            route.from_id = body.from_id
        if body.to_id is not None:
            route.to_id = body.to_id
        if body.isk_per_m3 is not None:
            route.isk_per_m3 = Decimal(str(body.isk_per_m3))
        if body.value_pct is not None:
            route.value_pct = Decimal(str(body.value_pct)) / 100
        await session.flush()
        loaded = (await session.execute(_load_route_q(route_id))).scalar_one()
        result = _route_dict(loaded)
        await session.commit()
    return result


@router.delete("/freight-routes/{route_id}", status_code=204)
async def delete_freight_route(route_id: int):
    async with AsyncSessionLocal() as session:
        await session.execute(delete(FreightRoute).where(FreightRoute.id == route_id))
        await session.commit()


# ── Availability ─────────────────────────────────────────────────────────────

@router.get("/availability")
async def availability(doctrine_id: int | None = None):
    async with AsyncSessionLocal() as session:
        if doctrine_id is not None:
            q = select(Doctrine).where(Doctrine.id == doctrine_id).options(*_DOCTRINE_OPTS)
        else:
            q = select(Doctrine).options(*_DOCTRINE_OPTS)
        doctrines = (await session.execute(q)).scalars().all()

        staging_loc_ids = {d.location_id for d in doctrines if d.location_id}
        all_type_ids = {
            item.type_id
            for d in doctrines if d.location_id
            for df in d.doctrine_fits
            for item in df.fit.items
        }

        all_locs = (await session.execute(select(Location))).scalars().all()
        jita_loc = next((l for l in all_locs if l.eve_id == 60003760), None)
        jita_id = jita_loc.id if jita_loc else None

        staging_by_loc: dict[int, dict[int, list]] = {}
        jita_by_type: dict[int, list] = {}
        freight_map: dict[int, FreightRoute] = {}

        if all_type_ids and staging_loc_ids:
            staging_raw = (await session.execute(
                select(MarketOrder).where(
                    MarketOrder.location_id.in_(staging_loc_ids),
                    MarketOrder.type_id.in_(list(all_type_ids)),
                    MarketOrder.is_buy.is_(False),
                )
            )).scalars().all()
            for o in staging_raw:
                loc_d = staging_by_loc.setdefault(o.location_id, {})
                loc_d.setdefault(o.type_id, []).append(o)
            for loc_d in staging_by_loc.values():
                for lst in loc_d.values():
                    lst.sort(key=lambda o: o.price)

            if jita_id:
                jita_raw = (await session.execute(
                    select(MarketOrder).where(
                        MarketOrder.location_id == jita_id,
                        MarketOrder.type_id.in_(list(all_type_ids)),
                        MarketOrder.is_buy.is_(False),
                    )
                )).scalars().all()
                for o in jita_raw:
                    jita_by_type.setdefault(o.type_id, []).append(o)
                for lst in jita_by_type.values():
                    lst.sort(key=lambda o: o.price)

                routes = (await session.execute(
                    select(FreightRoute).where(
                        FreightRoute.from_id == jita_id,
                        FreightRoute.to_id.in_(staging_loc_ids),
                    )
                )).scalars().all()
                for r in routes:
                    freight_map[r.to_id] = r

        from ..sde import type_names as _tn, system_name_for_station as _sys
        # Pre-compute staging system names and fee rates
        staging_systems: dict[int, str | None] = {}
        loc_fees: dict[int, tuple[float, float]] = {}
        for loc in all_locs:
            if loc.id in staging_loc_ids:
                staging_systems[loc.id] = (
                    _sys(loc.eve_id) if loc.location_type == "station" else None
                )
                loc_fees[loc.id] = (loc.broker_fee_pct or 0.0, loc.sales_tax_pct or 0.0)

        # Market velocity: ESI history sold volumes per (region_id, ship_type_id)
        # Use SDE region lookup for NPC stations; fall back to stored region_id for structures
        velocity_tasks: list[tuple[int, int, int]] = []  # (doctrine_id, region_id, ship_type_id)
        for d in doctrines:
            if d.location_id and d.location:
                stored_rid = d.location.region_id
                region_id = (
                    region_id_for_station(d.location.eve_id)
                    or (region_id_for_system(stored_rid) if stored_rid and stored_rid >= 30000000 else stored_rid)
                )
                for df in d.doctrine_fits:
                    velocity_tasks.append((d.id, region_id, df.fit.ship_type_id))

        async def _history_vol(region_id: int, type_id: int) -> tuple[int, int]:
            today = datetime.now(timezone.utc).date()
            try:
                data = await esi.get(
                    f"/markets/{region_id}/history/", params={"type_id": type_id}
                )
                v7 = v30 = 0
                for entry in data:
                    age = (today - datetime.strptime(entry["date"], "%Y-%m-%d").date()).days
                    vol = entry.get("volume", 0)
                    if age <= 7:
                        v7 += vol
                    if age <= 30:
                        v30 += vol
                return v7, v30
            except Exception as exc:
                logger.warning("ESI history failed region=%s type=%s: %s", region_id, type_id, exc)
                return 0, 0

        seen: dict[tuple[int, int], tuple[int, int]] = {}
        for _, region_id, type_id in velocity_tasks:
            key = (region_id, type_id)
            if key not in seen:
                seen[key] = await _history_vol(region_id, type_id)

        # Map doctrine_id → (sold_7d, sold_30d) for each fit's hull
        velocity: dict[tuple[int, int], tuple[int, int]] = {}
        for doc_id, region_id, type_id in velocity_tasks:
            velocity[(doc_id, type_id)] = seen.get((region_id, type_id), (0, 0))

        fits_out = []
        for doctrine in doctrines:
            for df in doctrine.doctrine_fits:
                if not doctrine.location_id:
                    names = _tn([df.fit.ship_type_id])
                    fits_out.append({
                        "df_id": df.id,
                        "fit_id": df.fit.id, "fit_name": df.fit.name,
                        "hull": names.get(df.fit.ship_type_id, ""),
                        "ship_type_id": df.fit.ship_type_id,
                        "raw_eft": df.fit.raw_eft,
                        "doctrine_id": doctrine.id, "doctrine_name": doctrine.name,
                        "stock": None, "target": df.target_qty,
                        "staging_price": None, "jita_price": None, "import_cost": None,
                        "missing_items": [], "item_rows": [],
                        "location_name": None, "system": None,
                        "status": "unknown",
                        "sold_7d": 0,
                        "sold_30d": 0,
                    })
                    continue

                staging_id = doctrine.location_id
                route = freight_map.get(staging_id)
                staging_by_type = staging_by_loc.get(staging_id, {})
                broker_fee, sales_tax = loc_fees.get(staging_id, (0.0, 0.0))

                calc = calculate(
                    df, staging_by_type, jita_by_type,
                    route.isk_per_m3 if route else None,
                    route.value_pct if route else None,
                    broker_fee, sales_tax,
                )
                missing = [
                    {"name": r["name"], "qty": r["qty_needed"] - r["qty_available"]}
                    for r in calc["item_rows"]
                    if r["qty_available"] < r["qty_needed"]
                ]
                fits_out.append({
                    "df_id": df.id,
                    "fit_id": df.fit.id, "fit_name": df.fit.name,
                    "hull": calc["ship_name"],
                    "ship_type_id": df.fit.ship_type_id,
                    "raw_eft": df.fit.raw_eft,
                    "doctrine_id": doctrine.id, "doctrine_name": doctrine.name,
                    "stock": calc["completable"], "target": calc["target_qty"],
                    "staging_price": float(calc["staging_total"]) if calc["staging_total"] else None,
                    "jita_price": float(calc["jita_total"]) if calc["jita_total"] else None,
                    "import_cost": float(calc["import_total"]) if calc["import_total"] else None,
                    "missing_items": missing,
                    "location_name": doctrine.location.name if doctrine.location else None,
                    "system": staging_systems.get(staging_id),
                    "sold_7d": velocity.get((doctrine.id, df.fit.ship_type_id), (0, 0))[0],
                    "sold_30d": velocity.get((doctrine.id, df.fit.ship_type_id), (0, 0))[1],
                    "item_rows": [
                        {
                            "type_id": r["type_id"],
                            "name": r["name"],
                            "qty_per_fit": r["qty_per_fit"],
                            "qty_needed": r["qty_needed"],
                            "qty_available": r["qty_available"],
                            "staging_price": float(r["staging_price"]) if r["staging_price"] else None,
                            "jita_price": float(r["jita_price"]) if r["jita_price"] else None,
                            "import_cost": float(r["import_cost"]) if r["import_cost"] else None,
                            "profit_to_import": float(r["profit_to_import"]) if r["profit_to_import"] is not None else None,
                        }
                        for r in calc["item_rows"]
                    ],
                    "status": _AVAIL_STATUS.get(calc["status"], "unknown"),
                })

        fit_meta: dict[int, dict] = {}
        for doctrine in doctrines:
            for df in doctrine.doctrine_fits:
                fit = df.fit
                if fit.id not in fit_meta:
                    fit_meta[fit.id] = {
                        "name": fit.name,
                        "fingerprint": frozenset((i.type_id, i.quantity) for i in fit.items),
                        "ship_type_id": fit.ship_type_id,
                        "doctrines": [],
                    }
                fit_meta[fit.id]["doctrines"].append({"id": doctrine.id, "name": doctrine.name})

        fp_groups: dict[tuple, list] = defaultdict(list)
        for fit_id, meta in fit_meta.items():
            key = (meta["ship_type_id"], meta["fingerprint"])
            fp_groups[key].append({"id": fit_id, "name": meta["name"], "doctrines": meta["doctrines"]})

        duplicate_groups = [{"fits": g} for g in fp_groups.values() if len(g) >= 2]

    return {"fits": fits_out, "duplicate_groups": duplicate_groups}


# ── Fits ──────────────────────────────────────────────────────────────────────

@router.get("/fits")
async def fits_list():
    async with AsyncSessionLocal() as session:
        fits = (await session.execute(
            select(Fit).options(
                selectinload(Fit.items),
                selectinload(Fit.doctrine_fits).options(selectinload(DoctrineFit.doctrine)),
            )
        )).scalars().all()
    from ..sde import type_names
    names = type_names([f.ship_type_id for f in fits])
    return [
        {
            "id": f.id,
            "name": f.name,
            "hull": names.get(f.ship_type_id, ""),
            "item_count": len(f.items),
            "doctrines": [
                {"id": df.doctrine_id, "name": df.doctrine.name, "target_qty": df.target_qty}
                for df in f.doctrine_fits
            ],
        }
        for f in fits
    ]


@router.post("/fits", status_code=201)
async def create_fit(body: FitCreate):
    try:
        parsed = parse_eft(body.eft)
    except EFTParseError as e:
        raise HTTPException(status_code=422, detail=str(e))
    async with AsyncSessionLocal() as session:
        fit = Fit(name=parsed["fit_name"], ship_type_id=parsed["ship_type_id"], raw_eft=body.eft)
        session.add(fit)
        await session.flush()
        for type_id, qty in parsed["items"].items():
            session.add(FitItem(fit_id=fit.id, type_id=type_id, quantity=qty))
        fit_id, fit_name, ship_type_id = fit.id, fit.name, fit.ship_type_id
        item_count = len(parsed["items"])
        await session.commit()
    from ..sde import type_name
    return {"id": fit_id, "name": fit_name, "hull": type_name(ship_type_id) or "", "item_count": item_count, "doctrines": []}


@router.get("/fits/{fit_id}")
async def fit_detail(fit_id: int, doctrine_id: int | None = None):
    from ..sde import type_names
    async with AsyncSessionLocal() as session:
        fit = await session.get(
            Fit, fit_id,
            options=[
                selectinload(Fit.items),
                selectinload(Fit.doctrine_fits).options(selectinload(DoctrineFit.doctrine)),
            ],
        )
        if not fit:
            raise HTTPException(status_code=404)

        all_ids = [fit.ship_type_id] + [i.type_id for i in fit.items]
        names = type_names(all_ids)
        doctrines_list = [
            {"id": df.doctrine_id, "name": df.doctrine.name, "target_qty": df.target_qty}
            for df in fit.doctrine_fits
        ]

        target_qty = stock = staging_price = jita_price = None
        item_rows = []

        df_match = next((df for df in fit.doctrine_fits if df.doctrine_id == doctrine_id), None) if doctrine_id else None
        if df_match:
            target_qty = df_match.target_qty

        if doctrine_id:
            doctrine = await session.get(Doctrine, doctrine_id)
            if doctrine and doctrine.location_id:
                item_type_ids = [i.type_id for i in fit.items]
                staging_raw = (await session.execute(
                    select(MarketOrder).where(
                        MarketOrder.location_id == doctrine.location_id,
                        MarketOrder.type_id.in_(item_type_ids),
                        MarketOrder.is_buy.is_(False),
                    )
                )).scalars().all()
                staging_by_type: dict = defaultdict(list)
                for o in staging_raw:
                    staging_by_type[o.type_id].append(o)
                for v in staging_by_type.values():
                    v.sort(key=lambda o: o.price)

                all_locs = (await session.execute(select(Location))).scalars().all()
                jita_loc = next((l for l in all_locs if l.eve_id == 60003760), None)
                staging_loc_f = next((l for l in all_locs if l.id == doctrine.location_id), None)
                broker_fee_f = staging_loc_f.broker_fee_pct or 0.0 if staging_loc_f else 0.0
                sales_tax_f = staging_loc_f.sales_tax_pct or 0.0 if staging_loc_f else 0.0
                jita_by_type: dict = defaultdict(list)
                freight_isk = freight_pct = None
                if jita_loc:
                    jita_raw = (await session.execute(
                        select(MarketOrder).where(
                            MarketOrder.location_id == jita_loc.id,
                            MarketOrder.type_id.in_(item_type_ids),
                            MarketOrder.is_buy.is_(False),
                        )
                    )).scalars().all()
                    for o in jita_raw:
                        jita_by_type[o.type_id].append(o)
                    for v in jita_by_type.values():
                        v.sort(key=lambda o: o.price)
                    route = (await session.execute(
                        select(FreightRoute).where(
                            FreightRoute.from_id == jita_loc.id,
                            FreightRoute.to_id == doctrine.location_id,
                        )
                    )).scalar_one_or_none()
                    if route:
                        freight_isk = route.isk_per_m3
                        freight_pct = route.value_pct

                if df_match:
                    calc = calculate(df_match, staging_by_type, jita_by_type, freight_isk, freight_pct, broker_fee_f, sales_tax_f)
                    stock = calc["completable"]
                    staging_price = float(calc["staging_total"]) if calc["staging_total"] else None
                    jita_price = float(calc["import_total"]) if calc["import_total"] else None
                    for r in calc["item_rows"]:
                        source = "staging" if r["qty_available"] > 0 else ("import" if r["jita_price"] else None)
                        item_rows.append({
                            "type_id": r["type_id"], "name": r["name"],
                            "qty": r["qty_per_fit"], "qty_available": r["qty_available"],
                            "staging_price": float(r["staging_price"]) if r["staging_price"] else None,
                            "jita_price": float(r["jita_price"]) if r["jita_price"] else None,
                            "source": source,
                        })

    if not item_rows:
        item_rows = [
            {
                "type_id": i.type_id, "name": names.get(i.type_id, f"[{i.type_id}]"),
                "qty": i.quantity, "qty_available": None,
                "staging_price": None, "jita_price": None, "source": None,
            }
            for i in fit.items
        ]

    return {
        "id": fit.id, "name": fit.name, "hull": names.get(fit.ship_type_id, ""),
        "target_qty": target_qty, "stock": stock,
        "staging_price": staging_price, "jita_price": jita_price,
        "doctrines": doctrines_list, "items": item_rows,
    }


@router.put("/fits/{fit_id}")
async def update_fit(fit_id: int, body: FitUpdate):
    async with AsyncSessionLocal() as session:
        fit = await session.get(Fit, fit_id)
        if not fit:
            raise HTTPException(status_code=404)
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(fit, k, v)
        await session.commit()
        return {"id": fit.id, "name": fit.name}


@router.delete("/fits/{fit_id}", status_code=204)
async def delete_fit_json(fit_id: int):
    async with AsyncSessionLocal() as session:
        await session.execute(delete(Fit).where(Fit.id == fit_id))
        await session.commit()


# ── Doctrines ─────────────────────────────────────────────────────────────────
# NOTE: /doctrines/below-target MUST be defined before /doctrines/{doctrine_id}

@router.get("/doctrines/below-target")
async def below_target_count():
    async with AsyncSessionLocal() as session:
        doctrines = (await session.execute(
            select(Doctrine).options(*_DOCTRINE_OPTS)
        )).scalars().all()
        orders_map = await _orders_for_doctrines(session, doctrines)
    count = sum(
        1
        for d in doctrines if d.location_id
        for df in d.doctrine_fits
        if _fit_completable(df, d.location_id, orders_map) < df.target_qty
    )
    return {"count": count}


@router.get("/doctrines")
async def doctrines_list():
    async with AsyncSessionLocal() as session:
        doctrines = (await session.execute(
            select(Doctrine).options(*_DOCTRINE_OPTS)
        )).scalars().all()
        orders_map = await _orders_for_doctrines(session, doctrines)
    return [
        {
            "id": d.id, "name": d.name, "description": d.description,
            "location_id": d.location_id,
            "location_name": d.location.name if d.location else None,
            "fit_count": len(d.doctrine_fits),
            "status": _doctrine_status(d, orders_map),
        }
        for d in doctrines
    ]


@router.post("/doctrines", status_code=201)
async def create_doctrine(body: DoctrineCreate):
    async with AsyncSessionLocal() as session:
        d = Doctrine(name=body.name, description=body.description, location_id=body.location_id)
        session.add(d)
        await session.flush()
        doc_id = d.id
        await session.commit()
    return {
        "id": doc_id, "name": body.name, "description": body.description,
        "location_id": body.location_id, "location_name": None, "fit_count": 0, "status": "unknown",
    }


@router.get("/doctrines/{doctrine_id}")
async def doctrine_detail(doctrine_id: int):
    async with AsyncSessionLocal() as session:
        doctrine = await session.get(Doctrine, doctrine_id, options=list(_DOCTRINE_OPTS))
        if not doctrine:
            raise HTTPException(status_code=404)

        locations = (await session.execute(select(Location))).scalars().all()
        fits_out = []

        if doctrine.location_id and doctrine.doctrine_fits:
            all_type_ids = {item.type_id for df in doctrine.doctrine_fits for item in df.fit.items}
            staging_id = doctrine.location_id
            staging_loc = next((l for l in locations if l.id == staging_id), None)
            broker_fee = staging_loc.broker_fee_pct or 0.0 if staging_loc else 0.0
            sales_tax = staging_loc.sales_tax_pct or 0.0 if staging_loc else 0.0
            jita_loc = next((l for l in locations if l.eve_id == 60003760), None)
            jita_id = jita_loc.id if jita_loc else None

            staging_raw = (await session.execute(
                select(MarketOrder).where(
                    MarketOrder.location_id == staging_id,
                    MarketOrder.type_id.in_(list(all_type_ids)),
                    MarketOrder.is_buy.is_(False),
                )
            )).scalars().all()
            staging_by_type: dict = defaultdict(list)
            for o in staging_raw:
                staging_by_type[o.type_id].append(o)
            for v in staging_by_type.values():
                v.sort(key=lambda o: o.price)

            jita_by_type: dict = defaultdict(list)
            freight_isk = freight_pct = None
            if jita_id:
                jita_raw = (await session.execute(
                    select(MarketOrder).where(
                        MarketOrder.location_id == jita_id,
                        MarketOrder.type_id.in_(list(all_type_ids)),
                        MarketOrder.is_buy.is_(False),
                    )
                )).scalars().all()
                for o in jita_raw:
                    jita_by_type[o.type_id].append(o)
                for v in jita_by_type.values():
                    v.sort(key=lambda o: o.price)
                route = (await session.execute(
                    select(FreightRoute).where(
                        FreightRoute.from_id == jita_id,
                        FreightRoute.to_id == staging_id,
                    )
                )).scalar_one_or_none()
                if route:
                    freight_isk = route.isk_per_m3
                    freight_pct = route.value_pct

            for df in doctrine.doctrine_fits:
                calc = calculate(df, staging_by_type, jita_by_type, freight_isk, freight_pct, broker_fee, sales_tax)
                missing = [
                    {"name": r["name"], "qty": r["qty_needed"] - r["qty_available"]}
                    for r in calc["item_rows"]
                    if r["qty_available"] < r["qty_needed"]
                ]
                fits_out.append({
                    "df_id": df.id, "fit_id": df.fit.id,
                    "name": df.fit.name, "hull": calc["ship_name"],
                    "target_qty": calc["target_qty"], "stock": calc["completable"],
                    "status": _AVAIL_STATUS.get(calc["status"], "unknown"),
                    "staging_price": float(calc["staging_total"]) if calc["staging_total"] else None,
                    "jita_price": float(calc["import_total"]) if calc["import_total"] else None,
                    "missing_items": missing,
                    "item_rows": [
                        {
                            "type_id": r["type_id"], "name": r["name"],
                            "qty": r["qty_per_fit"], "qty_available": r["qty_available"],
                            "staging_price": float(r["staging_price"]) if r["staging_price"] else None,
                            "jita_price": float(r["jita_price"]) if r["jita_price"] else None,
                            "import_cost": float(r["import_cost"]) if r["import_cost"] else None,
                            "profit_to_import": float(r["profit_to_import"]) if r["profit_to_import"] is not None else None,
                        }
                        for r in calc["item_rows"]
                    ],
                })
        else:
            from ..sde import type_names
            for df in doctrine.doctrine_fits:
                names = type_names([df.fit.ship_type_id])
                fits_out.append({
                    "df_id": df.id, "fit_id": df.fit.id,
                    "name": df.fit.name, "hull": names.get(df.fit.ship_type_id, ""),
                    "target_qty": df.target_qty, "stock": None,
                    "status": "unknown", "staging_price": None, "jita_price": None,
                    "missing_items": [], "item_rows": [],
                })

    fit_statuses = [f["status"] for f in fits_out]
    if not fit_statuses or all(s == "unknown" for s in fit_statuses):
        overall = "unknown"
    elif all(s == "ready" for s in fit_statuses):
        overall = "ready"
    elif all(s in ("short", "unknown") for s in fit_statuses):
        overall = "short"
    else:
        overall = "partial"

    return {
        "id": doctrine.id, "name": doctrine.name, "description": doctrine.description,
        "location_id": doctrine.location_id,
        "location_name": doctrine.location.name if doctrine.location else None,
        "status": overall, "fits": fits_out,
        "locations": [{"id": l.id, "name": l.name} for l in locations],
    }


@router.put("/doctrines/{doctrine_id}")
async def update_doctrine(doctrine_id: int, body: DoctrineUpdate):
    async with AsyncSessionLocal() as session:
        d = await session.get(Doctrine, doctrine_id)
        if not d:
            raise HTTPException(status_code=404)
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(d, k, v)
        await session.commit()
        return {"id": d.id, "name": d.name, "description": d.description, "location_id": d.location_id}


@router.delete("/doctrines/{doctrine_id}", status_code=204)
async def delete_doctrine(doctrine_id: int):
    async with AsyncSessionLocal() as session:
        await session.execute(delete(Doctrine).where(Doctrine.id == doctrine_id))
        await session.commit()


@router.post("/doctrines/{doctrine_id}/fits", status_code=201)
async def add_fit_to_doctrine(doctrine_id: int, body: DoctrineFitAdd):
    async with AsyncSessionLocal() as session:
        if not await session.get(Doctrine, doctrine_id):
            raise HTTPException(status_code=404)
        df = DoctrineFit(doctrine_id=doctrine_id, fit_id=body.fit_id, target_qty=body.target_qty)
        session.add(df)
        await session.flush()
        df_id = df.id
        await session.commit()
    return {"df_id": df_id, "fit_id": body.fit_id, "target_qty": body.target_qty}


@router.patch("/doctrines/{doctrine_id}/fits/{df_id}")
async def update_doctrine_fit(doctrine_id: int, df_id: int, body: dict):
    target_qty = body.get("target_qty")
    if not isinstance(target_qty, int) or target_qty < 0:
        raise HTTPException(status_code=422, detail="target_qty must be a non-negative integer")
    async with AsyncSessionLocal() as session:
        df = await session.get(DoctrineFit, df_id)
        if not df or df.doctrine_id != doctrine_id:
            raise HTTPException(status_code=404)
        df.target_qty = target_qty
        await session.commit()
    return {"df_id": df_id, "target_qty": target_qty}


@router.delete("/doctrines/{doctrine_id}/fits/{df_id}", status_code=204)
async def remove_fit_from_doctrine(doctrine_id: int, df_id: int):
    async with AsyncSessionLocal() as session:
        await session.execute(delete(DoctrineFit).where(DoctrineFit.id == df_id))
        await session.commit()


@router.post("/fits/merge")
async def merge_fits(body: dict):
    keep_id = body.get("keep_id")
    merge_ids = body.get("merge_ids", [])
    if not isinstance(keep_id, int) or not merge_ids:
        raise HTTPException(status_code=422, detail="keep_id and merge_ids required")

    merged = 0
    async with AsyncSessionLocal() as session:
        existing_doctrine_ids = set(
            row[0] for row in (await session.execute(
                select(DoctrineFit.doctrine_id).where(DoctrineFit.fit_id == keep_id)
            )).all()
        )
        for fit_id in merge_ids:
            rows = (await session.execute(
                select(DoctrineFit).where(DoctrineFit.fit_id == fit_id)
            )).scalars().all()
            for df in rows:
                if df.doctrine_id not in existing_doctrine_ids:
                    df.fit_id = keep_id
                    existing_doctrine_ids.add(df.doctrine_id)
            fit = await session.get(Fit, fit_id)
            if fit:
                await session.delete(fit)
            merged += 1
        await session.commit()
    return {"merged": merged}


# ── Market poll ──────────────────────────────────────────────────────────────

@router.get("/poll-status")
async def poll_status():
    from ..scheduler.jobs import get_scheduler
    from ..models import MarketOrder
    _job = get_scheduler().get_job("poll_markets")
    next_poll = _job.next_run_time.isoformat() if (_job and _job.next_run_time) else None
    async with AsyncSessionLocal() as session:
        last_poll = (await session.execute(
            select(func.max(MarketOrder.fetched_at))
        )).scalar_one_or_none()
    return {
        "next_poll": next_poll,
        "last_poll": last_poll.isoformat() if last_poll else None,
    }


@router.post("/poll-all")
async def trigger_poll_all():
    import asyncio
    from ..market.poller import poll_all_locations
    asyncio.create_task(poll_all_locations())
    return {"ok": True}


# ── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def dashboard():
    async with AsyncSessionLocal() as session:
        doctrines = (await session.execute(
            select(Doctrine).options(*_DOCTRINE_OPTS)
        )).scalars().all()

        all_locs = (await session.execute(select(Location))).scalars().all()
        jita_loc = next((l for l in all_locs if l.eve_id == 60003760), None)
        jita_id = jita_loc.id if jita_loc else None

        staging_loc_ids = {d.location_id for d in doctrines if d.location_id}
        all_type_ids = {
            item.type_id
            for d in doctrines if d.location_id
            for df in d.doctrine_fits
            for item in df.fit.items
        }
        loc_fees_dash: dict[int, tuple[float, float]] = {
            loc.id: (loc.broker_fee_pct or 0.0, loc.sales_tax_pct or 0.0)
            for loc in all_locs if loc.id in staging_loc_ids
        }

        staging_by_loc: dict = {}
        jita_by_type: dict = {}
        freight_map: dict = {}

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

            if jita_id:
                jita_raw = (await session.execute(
                    select(MarketOrder).where(
                        MarketOrder.location_id == jita_id,
                        MarketOrder.type_id.in_(list(all_type_ids)),
                        MarketOrder.is_buy.is_(False),
                    )
                )).scalars().all()
                for o in jita_raw:
                    jita_by_type.setdefault(o.type_id, []).append(o)
                for lst in jita_by_type.values():
                    lst.sort(key=lambda o: o.price)

                routes = (await session.execute(
                    select(FreightRoute).where(
                        FreightRoute.from_id == jita_id,
                        FreightRoute.to_id.in_(staging_loc_ids),
                    )
                )).scalars().all()
                for r in routes:
                    freight_map[r.to_id] = r

        last_poll = (await session.execute(
            select(func.max(MarketOrder.fetched_at))
        )).scalar_one_or_none()

    now = datetime.now(timezone.utc)

    from ..scheduler.jobs import get_scheduler
    _job = get_scheduler().get_job("poll_markets")
    next_poll = _job.next_run_time.isoformat() if (_job and _job.next_run_time) else None

    doctrine_count = len(doctrines)
    doctrines_fully_stocked = 0
    fits_below_target = 0
    seen_fit_ids: set[int] = set()
    import_savings = Decimal(0)
    doctrine_summary = []
    alerts = []
    items_acc: dict[int, dict] = {}

    for doctrine in doctrines:
        fits_total = len(doctrine.doctrine_fits)
        fits_stocked = 0

        if not doctrine.location_id:
            doctrine_summary.append({
                "id": doctrine.id, "name": doctrine.name,
                "status": "unknown", "fits_stocked": 0, "fits_total": fits_total,
            })
            continue

        staging_id = doctrine.location_id
        route = freight_map.get(staging_id)
        staging_by_type = staging_by_loc.get(staging_id, {})
        broker_fee_d, sales_tax_d = loc_fees_dash.get(staging_id, (0.0, 0.0))

        for df in doctrine.doctrine_fits:
            calc = calculate(
                df, staging_by_type, jita_by_type,
                route.isk_per_m3 if route else None,
                route.value_pct if route else None,
                broker_fee_d, sales_tax_d,
            )
            if calc["completable"] >= df.target_qty:
                fits_stocked += 1
            else:
                if df.fit.id not in seen_fit_ids:
                    fits_below_target += 1
                shortfall = df.target_qty - calc["completable"]
                alerts.append({
                    "type": "fit_short",
                    "doctrine_id": doctrine.id,
                    "doctrine_name": doctrine.name,
                    "fit_name": df.fit.name,
                    "detail": f"{shortfall} fit{'s' if shortfall != 1 else ''} short",
                    "severity": "danger" if calc["completable"] == 0 else "warn",
                })
                for row in calc["item_rows"]:
                    qty_short = row["qty_needed"] - row["qty_available"]
                    if qty_short <= 0:
                        continue
                    tid = row["type_id"]
                    acc = items_acc.setdefault(tid, {
                        "type_id": tid, "name": row["name"], "qty_needed": 0,
                        "jita_price": float(row["jita_price"]) if row["jita_price"] else None,
                        "import_cost": float(row["import_cost"]) if row["import_cost"] else None,
                        "staging_price": float(row["staging_price"]) if row["staging_price"] else None,
                    })
                    acc["qty_needed"] += qty_short
                    if row["import_cost"] and row["staging_price"] and row["import_cost"] < row["staging_price"]:
                        import_savings += (row["staging_price"] - row["import_cost"]) * qty_short
            seen_fit_ids.add(df.fit.id)

        if fits_stocked == fits_total:
            doctrines_fully_stocked += 1
            doc_status = "ready"
        elif fits_stocked == 0:
            doc_status = "short"
        else:
            doc_status = "partial"

        doctrine_summary.append({
            "id": doctrine.id, "name": doctrine.name,
            "status": doc_status, "fits_stocked": fits_stocked, "fits_total": fits_total,
        })

    # Poll overdue alert
    if last_poll:
        age_min = (now - last_poll).total_seconds() / 60
        if age_min > 15:
            alerts.append({
                "type": "poll_overdue",
                "detail": f"Markets last polled {int(age_min)} min ago",
                "severity": "warn",
            })
    elif doctrines:
        alerts.append({
            "type": "poll_overdue",
            "detail": "Markets have never been polled",
            "severity": "warn",
        })

    items_list = sorted(
        items_acc.values(),
        key=lambda x: x["qty_needed"] * (x["jita_price"] or 0),
        reverse=True,
    )[:5]

    return {
        "doctrine_count": doctrine_count,
        "doctrines_fully_stocked": doctrines_fully_stocked,
        "fits_below_target": fits_below_target,
        "location_count": len(all_locs),
        "location_names": [l.name for l in all_locs],
        "import_savings_isk": float(import_savings),
        "last_poll": last_poll.isoformat() if last_poll else None,
        "next_poll": next_poll,
        "doctrine_summary": doctrine_summary,
        "alerts": alerts,
        "items_to_source": [
            {
                "type_id": item["type_id"],
                "name": item["name"],
                "qty_needed": item["qty_needed"],
                "source": (
                    "import"
                    if item["import_cost"] and item["staging_price"] and item["import_cost"] < item["staging_price"]
                    else "staging"
                ),
                "jita_price": item["jita_price"],
            }
            for item in items_list
        ],
    }
