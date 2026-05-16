import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..models import FreightRoute, IndustryProject, InventoryLot, InventorySale, InventoryTransfer, Location, LotReservation, MarketListing, MarketOrder
from ..sde import (
    station_by_name, type_id_by_name, type_volume,
    type_names, type_volumes, type_categories, system_name_for_station,
)
from .wallet_parser import parse_wallet_text

router = APIRouter(prefix="/inventory", dependencies=[Depends(get_current_character)])


# ── Schemas ───────────────────────────────────────────────────────────────────

class _TransferItem(_Base):
    type_id: int
    qty: int
    from_location_id: int

class TransferListRequest(_Base):
    items: list[_TransferItem]
    to_location_id: int

class _SellItem(_Base):
    type_id: int
    qty: int
    location_id: int

class SellListRequest(_Base):
    items: list[_SellItem]

class _MarkSoldItem(_Base):
    type_id: int
    qty: int
    location_id: int
    unit_sell_price: float = 0.0
    method: str = "market"  # "market" | "contract"

class MarkSoldRequest(_Base):
    items: list[_MarkSoldItem]

class ImportRequest(_Base):
    text: str

class JanicePreviewRequest(_Base):
    text: str
    price_type: str  # "buy" | "sell" | "split"
    location_id: int

class _JaniceLotItem(_Base):
    type_id: int
    item_name: str
    qty: int
    unit_price: float

class JaniceSaveRequest(_Base):
    items: list[_JaniceLotItem]
    location_id: int


# ── Helper ────────────────────────────────────────────────────────────────────

def _ceil_4sf(n: float) -> float:
    """Round up to 4 significant figures — the max precision EVE allows for order prices."""
    if n <= 0:
        return n
    tick = 10 ** (math.floor(math.log10(n)) - 3)
    return math.ceil(n / tick) * tick


async def _fifo_transfer(session, type_id: int, item_name: str, from_id: int, to_id: int,
                         qty: int, isk_per_m3: Decimal, value_pct: Decimal,
                         jita_price: Decimal | None = None) -> None:
    """FIFO-deduct qty from from_id lots and create one blended lot at to_id."""
    lots = (await session.execute(
        select(InventoryLot)
        .where(InventoryLot.type_id == type_id)
        .where(InventoryLot.location_id == from_id)
        .where(InventoryLot.qty_remaining > 0)
        .order_by(InventoryLot.purchased_at)
    )).scalars().all()

    remaining = qty
    weighted_cost = Decimal(0)
    deductions: list[tuple[InventoryLot, int]] = []

    for lot in lots:
        if remaining <= 0:
            break
        take = min(remaining, lot.qty_remaining)
        weighted_cost += take * lot.unit_cost
        deductions.append((lot, take))
        remaining -= take

    if remaining > 0:
        raise HTTPException(400, f"Insufficient stock for {item_name}: "
                                 f"requested {qty}, available {qty - remaining}")

    blended_cost = weighted_cost / qty
    vol = Decimal(str(type_volume(type_id) or 0))
    value_basis = jita_price if jita_price is not None else blended_cost
    per_unit_freight = vol * isk_per_m3 + value_basis * value_pct

    new_lot = InventoryLot(
        type_id=type_id,
        item_name=item_name,
        location_id=to_id,
        qty_original=qty,
        qty_remaining=qty,
        unit_cost=blended_cost + per_unit_freight,
        purchased_at=datetime.now(timezone.utc),
        source="manual",
    )
    session.add(new_lot)
    await session.flush()

    now = datetime.now(timezone.utc)
    for lot, take in deductions:
        lot.qty_remaining -= take
        session.add(InventoryTransfer(
            source_lot_id=lot.id,
            dest_lot_id=new_lot.id,
            qty=take,
            freight_cost_total=per_unit_freight * take,
            transferred_at=now,
        ))


# ── Inventory JSON API ────────────────────────────────────────────────────────

@router.get("")
async def inventory_list(location_id: int | None = None):
    async with AsyncSessionLocal() as session:
        q = (select(InventoryLot)
             .options(selectinload(InventoryLot.location))
             .where(InventoryLot.qty_remaining > 0))
        if location_id:
            q = q.where(InventoryLot.location_id == location_id)
        lots = (await session.execute(
            q.order_by(InventoryLot.item_name, InventoryLot.purchased_at)
        )).scalars().all()

        all_locs = (await session.execute(select(Location))).scalars().all()
        jita_loc = next((l for l in all_locs if l.eve_id == 60003760), None)
        jita_id = jita_loc.id if jita_loc else None

        type_ids = list({lot.type_id for lot in lots})
        inv_loc_ids = list({lot.location_id for lot in lots})
        mkt_loc_ids = list(set(inv_loc_ids) | ({jita_id} if jita_id else set()))

        market_rows = []
        if type_ids and mkt_loc_ids:
            market_rows = (await session.execute(
                select(
                    MarketOrder.type_id,
                    MarketOrder.location_id,
                    MarketOrder.is_buy,
                    func.min(MarketOrder.price).label("min_price"),
                    func.max(MarketOrder.price).label("max_price"),
                )
                .where(MarketOrder.location_id.in_(mkt_loc_ids))
                .where(MarketOrder.type_id.in_(type_ids))
                .group_by(MarketOrder.type_id, MarketOrder.location_id, MarketOrder.is_buy)
            )).all()

        # Reservations: qty reserved per lot + project name
        lot_ids = [l.id for l in lots]
        reservation_rows = []
        if lot_ids:
            reservation_rows = (await session.execute(
                select(
                    LotReservation.lot_id,
                    func.sum(LotReservation.qty_reserved).label("total_reserved"),
                    IndustryProject.id.label("project_id"),
                    IndustryProject.name.label("project_name"),
                )
                .join(IndustryProject, LotReservation.project_id == IndustryProject.id)
                .where(LotReservation.lot_id.in_(lot_ids))
                .group_by(LotReservation.lot_id, IndustryProject.id, IndustryProject.name)
            )).all()

        # Active market listings
        listing_rows = []
        if type_ids:
            listing_rows = (await session.execute(
                select(
                    MarketListing.type_id,
                    MarketListing.eve_location_id,
                    MarketListing.order_id,
                    MarketListing.qty_remaining,
                    MarketListing.list_price,
                )
                .where(MarketListing.status == "active")
                .where(MarketListing.type_id.in_(type_ids))
            )).all()

    # Map lot_id → {qty_reserved, project_id, project_name}
    reserved_by_lot: dict[int, dict] = {}
    for row in reservation_rows:
        reserved_by_lot[row.lot_id] = {
            "qty": int(row.total_reserved),
            "project_id": row.project_id,
            "project_name": row.project_name,
        }

    # Market data keyed by (type_id, location_id)
    market: dict[tuple[int, int], dict] = {}
    for row in market_rows:
        d = market.setdefault((row.type_id, row.location_id), {})
        if row.is_buy:
            d["buy"] = float(row.max_price)
        else:
            d["sell"] = float(row.min_price)

    # SDE batch lookups
    vols = type_volumes(type_ids)
    cats = type_categories(type_ids)
    sde_names = type_names(type_ids)

    # Group lots by (location_id, type_id)
    by_loc: dict[int, dict[int, list[InventoryLot]]] = defaultdict(lambda: defaultdict(list))
    for lot in lots:
        by_loc[lot.location_id][lot.type_id].append(lot)

    loc_map = {l.id: l for l in all_locs}
    loc_by_eve_id = {l.eve_id: l for l in all_locs}

    # Map (type_id, location_id) → active market listing entries
    on_market: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for row in listing_rows:
        loc = loc_by_eve_id.get(row.eve_location_id)
        if loc:
            on_market[(row.type_id, loc.id)].append({
                "order_id": row.order_id,
                "qty": row.qty_remaining,
                "list_price": float(row.list_price),
            })

    result = []
    for loc_id_key in sorted(by_loc.keys(), key=lambda i: loc_map[i].name if i in loc_map else ""):
        items_by_type = by_loc[loc_id_key]
        loc = loc_map.get(loc_id_key)
        if not loc:
            continue

        items = []
        for tid in sorted(items_by_type, key=lambda i: sde_names.get(i) or ""):
            type_lots = items_by_type[tid]
            qty_total = sum(l.qty_remaining for l in type_lots)
            qty_reserved = sum(reserved_by_lot.get(l.id, {}).get("qty", 0) for l in type_lots)
            on_market_listings = on_market.get((tid, loc_id_key), [])
            qty_on_market = sum(e["qty"] for e in on_market_listings)
            qty_available = max(0, qty_total - qty_reserved - qty_on_market)

            # Collect in-use project references
            in_use_projects = []
            seen_projects = set()
            for l in type_lots:
                res = reserved_by_lot.get(l.id)
                if res and res["project_id"] not in seen_projects:
                    in_use_projects.append({"id": res["project_id"], "name": res["project_name"]})
                    seen_projects.add(res["project_id"])

            basis = sum(l.qty_remaining * l.unit_cost for l in type_lots)
            unit_value = float(basis / qty_total) if qty_total else 0.0
            vol = vols.get(tid, 0.0)
            jita_mkt = market.get((tid, jita_id), {}) if jita_id else {}

            # Show row if there's anything available, reserved, or on market
            if qty_available <= 0 and qty_reserved <= 0 and qty_on_market <= 0:
                continue

            items.append({
                "type_id": tid,
                "name": sde_names.get(tid) or type_lots[0].item_name,
                "type": cats.get(tid, "other"),
                "qty": qty_available,
                "qty_reserved": qty_reserved,
                "qty_on_market": qty_on_market,
                "on_market_listings": on_market_listings,
                "in_use_projects": in_use_projects,
                "unit_volume": vol,
                "total_volume": vol * qty_available,
                "unit_value": unit_value,
                "jita_buy": jita_mkt.get("buy"),
                "jita_sell": jita_mkt.get("sell"),
                "total_value": unit_value * qty_available,
            })

        if not items:
            continue

        sys_name = (system_name_for_station(loc.eve_id)
                    if loc.location_type == "station" else None)
        result.append({
            "location_id": loc.id,
            "location_name": loc.name,
            "system": sys_name,
            "fees": {
                "broker_fee_pct": loc.broker_fee_pct,
                "sales_tax_pct": loc.sales_tax_pct,
                "scc_surcharge_pct": loc.scc_surcharge_pct,
            },
            "items": items,
        })

    return result


@router.get("/pnl")
async def pnl_history(days: int | None = None):
    async with AsyncSessionLocal() as session:
        q = (
            select(
                InventorySale.id,
                InventorySale.sold_at,
                InventorySale.qty,
                InventorySale.unit_sell_price,
                InventoryLot.unit_cost,
                InventoryLot.item_name,
                InventoryLot.type_id,
                Location.name.label("location_name"),
            )
            .join(InventoryLot, InventorySale.lot_id == InventoryLot.id)
            .join(Location, InventoryLot.location_id == Location.id)
            .order_by(InventorySale.sold_at.desc())
        )
        if days:
            q = q.where(InventorySale.sold_at >= datetime.now(timezone.utc) - timedelta(days=days))
        rows = (await session.execute(q)).all()

    entries = []
    daily: dict[str, dict] = {}

    for row in rows:
        date_str = row.sold_at.strftime("%Y-%m-%d")
        unit_sell = float(row.unit_sell_price)
        unit_cost = float(row.unit_cost)
        revenue = unit_sell * row.qty
        cost = unit_cost * row.qty
        has_price = unit_sell > 0

        entries.append({
            "id": row.id,
            "sold_at": row.sold_at.isoformat(),
            "date": date_str,
            "item_name": row.item_name,
            "qty": row.qty,
            "unit_cost": unit_cost,
            "unit_sell_price": unit_sell,
            "revenue": round(revenue, 2) if has_price else None,
            "cost": round(cost, 2),
            "profit": round(revenue - cost, 2) if has_price else None,
            "location_name": row.location_name,
        })

        if has_price:
            d = daily.setdefault(date_str, {"date": date_str, "revenue": 0.0, "cost": 0.0, "profit": 0.0})
            d["revenue"] += revenue
            d["cost"] += cost
            d["profit"] += revenue - cost

    sorted_daily = sorted(daily.values(), key=lambda x: x["date"])
    cumulative = 0.0
    for d in sorted_daily:
        cumulative += d["profit"]
        d["profit"] = round(d["profit"], 2)
        d["revenue"] = round(d["revenue"], 2)
        d["cost"] = round(d["cost"], 2)
        d["cumulative_profit"] = round(cumulative, 2)

    priced = [e for e in entries if e["profit"] is not None]
    total_revenue = sum(e["revenue"] for e in priced)
    total_cost = sum(e["cost"] for e in priced)
    total_profit = total_revenue - total_cost

    return {
        "daily": sorted_daily,
        "entries": entries,
        "summary": {
            "total_revenue": round(total_revenue, 2),
            "total_cost": round(total_cost, 2),
            "total_profit": round(total_profit, 2),
            "roi_pct": round(total_profit / total_cost * 100, 2) if total_cost > 0 else 0.0,
            "sold_count": len(entries),
            "priced_count": len(priced),
        },
    }


@router.post("/transfer-list")
async def transfer_execute_json(body: TransferListRequest):
    async with AsyncSessionLocal() as session:
        to_loc = await session.get(Location, body.to_location_id)
        if not to_loc:
            raise HTTPException(404, "Destination location not found")

        from_ids = list({i.from_location_id for i in body.items})
        routes: dict[int, FreightRoute | None] = {}
        for fid in from_ids:
            if fid == body.to_location_id:
                routes[fid] = None
                continue
            route = (await session.execute(
                select(FreightRoute)
                .where(FreightRoute.from_id == fid)
                .where(FreightRoute.to_id == body.to_location_id)
            )).scalar_one_or_none()
            routes[fid] = route

        names = type_names([i.type_id for i in body.items])

        tids = [i.type_id for i in body.items]
        jita_loc = (await session.execute(
            select(Location).where(Location.eve_id == 60003760)
        )).scalar_one_or_none()
        jita_prices: dict[int, Decimal] = {}
        if jita_loc and tids:
            jita_rows = (await session.execute(
                select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
                .where(MarketOrder.location_id == jita_loc.id)
                .where(MarketOrder.type_id.in_(tids))
                .where(MarketOrder.is_buy.is_(False))
                .group_by(MarketOrder.type_id)
            )).all()
            jita_prices = {r.type_id: Decimal(str(r.price)) for r in jita_rows}

        for item in body.items:
            route = routes.get(item.from_location_id)
            isk_per_m3 = Decimal(str(route.isk_per_m3)) if route else Decimal(0)
            value_pct = Decimal(str(route.value_pct)) if route else Decimal(0)
            name = names.get(item.type_id, f"type:{item.type_id}")
            await _fifo_transfer(
                session, item.type_id, name,
                item.from_location_id, body.to_location_id,
                item.qty, isk_per_m3, value_pct,
                jita_price=jita_prices.get(item.type_id),
            )

        await session.commit()

    return {"ok": True}


@router.post("/sell-list")
async def sell_list(body: SellListRequest):
    async with AsyncSessionLocal() as session:
        locs = {l.id: l for l in (await session.execute(select(Location))).scalars().all()}
        jita_loc = next((l for l in locs.values() if l.eve_id == 60003760), None)
        jita_id = jita_loc.id if jita_loc else None

        tids = [i.type_id for i in body.items]
        jita_buy_rows = []
        if jita_id and tids:
            jita_buy_rows = (await session.execute(
                select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
                .where(MarketOrder.location_id == jita_id)
                .where(MarketOrder.type_id.in_(tids))
                .where(MarketOrder.is_buy.is_(False))
                .group_by(MarketOrder.type_id)
            )).all()

        # Blended unit cost per (type_id, location_id) from open lots
        unit_costs: dict[tuple[int, int], float] = {}
        for item in body.items:
            key = (item.type_id, item.location_id)
            if key in unit_costs:
                continue
            lots = (await session.execute(
                select(InventoryLot)
                .where(InventoryLot.type_id == item.type_id)
                .where(InventoryLot.location_id == item.location_id)
                .where(InventoryLot.qty_remaining > 0)
            )).scalars().all()
            if lots:
                total_qty = sum(l.qty_remaining for l in lots)
                total_cost = sum(l.qty_remaining * l.unit_cost for l in lots)
                unit_costs[key] = float(total_cost / total_qty)

    jita_sell = {row.type_id: float(row.price) for row in jita_buy_rows}
    names = type_names(tids)

    lines = ["Sell reference", ""]
    total_isk = 0.0
    for item in body.items:
        name = names.get(item.type_id, str(item.type_id))
        loc = locs.get(item.location_id)
        price = jita_sell.get(item.type_id)
        unit_cost = unit_costs.get((item.type_id, item.location_id))

        breakeven = markup = None
        if unit_cost is not None and loc is not None:
            total_fee = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100
            if total_fee < 1.0:
                breakeven = _ceil_4sf(unit_cost / (1 - total_fee))
                markup = _ceil_4sf(breakeven * 1.1)

        price_str = f"{price:,.0f} ISK/u (Jita sell)" if price is not None else "no market data"
        value = price * item.qty if price is not None else None
        value_str = f"  = {value:,.0f} ISK" if value is not None else ""
        ref_parts = []
        if breakeven is not None:
            ref_parts.append(f"break-even: {breakeven:,.4g}")
        if markup is not None:
            ref_parts.append(f"+10%: {markup:,.4g}")
        ref_str = f"  [{', '.join(ref_parts)}]" if ref_parts else ""

        lines.append(
            f"  {item.qty:,}x {name}  "
            f"@ {price_str}/u{value_str}{ref_str}  [{loc.name if loc else '?'}]"
        )
        if value is not None:
            total_isk += value

    lines += ["", f"Total Jita sell value: {total_isk:,.0f} ISK"]
    return {"text": "\n".join(lines)}


@router.post("/mark-sold")
async def mark_sold(body: MarkSoldRequest):
    now = datetime.now(timezone.utc)
    total_sold = 0
    async with AsyncSessionLocal() as session:
        for item in body.items:
            lots = (await session.execute(
                select(InventoryLot)
                .where(InventoryLot.type_id == item.type_id)
                .where(InventoryLot.location_id == item.location_id)
                .where(InventoryLot.qty_remaining > 0)
                .order_by(InventoryLot.purchased_at)
            )).scalars().all()
            remaining = item.qty
            for lot in lots:
                if remaining <= 0:
                    break
                take = min(remaining, lot.qty_remaining)
                lot.qty_remaining -= take
                session.add(InventorySale(
                    lot_id=lot.id,
                    qty=take,
                    unit_sell_price=Decimal(str(item.unit_sell_price)),
                    sold_at=now,
                    source=item.method,
                ))
                remaining -= take
                total_sold += take
        await session.commit()
    return {"sold": total_sold}


# ── Import JSON API ───────────────────────────────────────────────────────────

@router.post("/import-preview")
async def import_preview_json(body: ImportRequest):
    rows, parse_errors = parse_wallet_text(body.text)
    buy_rows = [r for r in rows if r.is_buy]
    sell_count = sum(1 for r in rows if not r.is_buy)

    preview_rows = []
    for row in buy_rows:
        tid = type_id_by_name(row.item_name)
        station = station_by_name(row.station_name)
        ok = tid is not None and station is not None
        if not ok:
            status = "unknown_item" if tid is None else "unknown_station"
        else:
            status = "ready"
        preview_rows.append({
            "item_name": row.item_name,
            "qty": row.qty,
            "unit_price": float(row.unit_price),
            "date_str": row.purchased_at.strftime("%Y-%m-%d %H:%M"),
            "station_name": row.station_name,
            "ok": ok,
            "status": status,
        })

    return {"rows": preview_rows, "errors": parse_errors, "sell_count": sell_count}


@router.post("/import-save")
async def import_save_json(body: ImportRequest):
    rows, _ = parse_wallet_text(body.text)
    buy_rows = [r for r in rows if r.is_buy]

    created = 0
    skipped = 0
    async with AsyncSessionLocal() as session:
        for row in buy_rows:
            tid = type_id_by_name(row.item_name)
            station_info = station_by_name(row.station_name)
            if tid is None or station_info is None:
                skipped += 1
                continue

            station_id, region_id = station_info
            loc = (await session.execute(
                select(Location).where(Location.eve_id == station_id)
            )).scalar_one_or_none()
            if loc is None:
                loc = Location(name=row.station_name, eve_id=station_id,
                               location_type="station", region_id=region_id)
                session.add(loc)
                await session.flush()

            session.add(InventoryLot(
                type_id=tid,
                item_name=row.item_name,
                location_id=loc.id,
                qty_original=row.qty,
                qty_remaining=row.qty,
                unit_cost=row.unit_price,
                purchased_at=row.purchased_at.replace(tzinfo=timezone.utc),
                source="manual",
                seller=row.counterparty,
                character_name=row.character_name,
                wallet_name=row.wallet_name,
            ))
            created += 1

        await session.commit()

    return {"created": created, "skipped": skipped}


@router.post("/import-janice-preview")
async def import_janice_preview(body: JanicePreviewRequest):
    items = []
    errors = []

    for lineno, raw in enumerate(body.text.strip().splitlines(), 1):
        # Janice copies as tab-separated; fall back to 2+-space split
        parts = raw.split('\t')
        if len(parts) < 5:
            import re as _re
            parts = _re.split(r' {2,}', raw.strip())
        if len(parts) < 5:
            errors.append(f"Line {lineno}: expected 5 columns (name, qty, vol, buy, sell)")
            continue

        name = parts[0].strip()
        try:
            qty = int(parts[1].replace(',', '').strip())
        except ValueError:
            errors.append(f"Line {lineno}: invalid quantity '{parts[1].strip()}'")
            continue
        try:
            buy_p  = float(parts[3].replace(',', '').strip())
            sell_p = float(parts[4].replace(',', '').strip())
        except ValueError:
            errors.append(f"Line {lineno}: invalid price")
            continue

        if body.price_type == "buy":
            unit_price = buy_p
        elif body.price_type == "sell":
            unit_price = sell_p
        else:
            unit_price = (buy_p + sell_p) / 2

        tid = type_id_by_name(name)
        canonical = type_names([tid]).get(tid) if tid else None
        items.append({
            "type_id": tid,
            "item_name": canonical or name,
            "qty": qty,
            "unit_price": unit_price,
            "ok": tid is not None,
        })

    return {"items": items, "errors": errors}


@router.post("/import-janice-save")
async def import_janice_save(body: JaniceSaveRequest):
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        loc = await session.get(Location, body.location_id)
        if not loc:
            raise HTTPException(404, "Location not found")
        for item in body.items:
            session.add(InventoryLot(
                type_id=item.type_id,
                item_name=item.item_name,
                location_id=body.location_id,
                qty_original=item.qty,
                qty_remaining=item.qty,
                unit_cost=Decimal(str(item.unit_price)),
                purchased_at=now,
                source="janice",
            ))
        await session.commit()
    return {"created": len(body.items)}


