from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..models import InventoryLot, Location, MarketListing, MarketOrder
from ..sde import type_names

router = APIRouter(prefix="/market-listings", dependencies=[Depends(get_current_character)])

_JITA_EVE_ID = 60003760


@router.get("")
async def list_market_listings():
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        listings = (await session.execute(
            select(MarketListing).where(MarketListing.status == "active")
        )).scalars().all()

        if not listings:
            return []

        type_ids = list({ml.type_id for ml in listings})
        eve_loc_ids = list({ml.eve_location_id for ml in listings})

        # Location map: eve_id → Location
        loc_rows = (await session.execute(
            select(Location).where(Location.eve_id.in_(eve_loc_ids))
        )).scalars().all()
        loc_by_eve_id = {l.eve_id: l for l in loc_rows}

        # Jita location
        jita_loc = (await session.execute(
            select(Location).where(Location.eve_id == _JITA_EVE_ID)
        )).scalar_one_or_none()

        loc_ids = list({l.id for l in loc_rows})

        # Best sell price per (type_id, location_id) from the authenticated market poll
        best_sell_rows = []
        if loc_ids and type_ids:
            best_sell_rows = (await session.execute(
                select(
                    MarketOrder.type_id,
                    MarketOrder.location_id,
                    func.min(MarketOrder.price).label("best_sell"),
                )
                .where(MarketOrder.location_id.in_(loc_ids))
                .where(MarketOrder.type_id.in_(type_ids))
                .where(MarketOrder.is_buy.is_(False))
                .group_by(MarketOrder.type_id, MarketOrder.location_id)
            )).all()

        # Jita buy + sell for the modal price options
        jita_price_rows = []
        if jita_loc and type_ids:
            jita_price_rows = (await session.execute(
                select(
                    MarketOrder.type_id,
                    MarketOrder.is_buy,
                    func.min(MarketOrder.price).label("min_price"),
                    func.max(MarketOrder.price).label("max_price"),
                )
                .where(MarketOrder.location_id == jita_loc.id)
                .where(MarketOrder.type_id.in_(type_ids))
                .group_by(MarketOrder.type_id, MarketOrder.is_buy)
            )).all()

        # Which (type_id, location_id) pairs have inventory lots with qty > 0
        # Also compute weighted avg unit cost per pair
        inventory_pairs: set[tuple[int, int]] = set()
        unit_cost_rows = []
        if loc_ids and type_ids:
            lot_rows = (await session.execute(
                select(
                    InventoryLot.type_id,
                    InventoryLot.location_id,
                    (func.sum(InventoryLot.unit_cost * InventoryLot.qty_remaining) / func.sum(InventoryLot.qty_remaining)).label("avg_cost"),
                )
                .where(InventoryLot.location_id.in_(loc_ids))
                .where(InventoryLot.type_id.in_(type_ids))
                .where(InventoryLot.qty_remaining > 0)
                .group_by(InventoryLot.type_id, InventoryLot.location_id)
            )).all()
            for r in lot_rows:
                inventory_pairs.add((r.type_id, r.location_id))
                unit_cost_rows.append(r)


    best_sell: dict[tuple[int, int], float] = {}
    for row in best_sell_rows:
        best_sell[(row.type_id, row.location_id)] = float(row.best_sell)

    jita_buy: dict[int, float] = {}
    jita_sell: dict[int, float] = {}
    for row in jita_price_rows:
        if row.is_buy:
            jita_buy[row.type_id] = float(row.max_price)
        else:
            jita_sell[row.type_id] = float(row.min_price)

    unit_costs: dict[tuple[int, int], float] = {}
    for row in unit_cost_rows:
        unit_costs[(row.type_id, row.location_id)] = float(row.avg_cost)

    names = type_names(type_ids)
    result = []

    for ml in listings:
        loc = loc_by_eve_id.get(ml.eve_location_id)
        loc_name = loc.name if loc else f"Unknown ({ml.eve_location_id})"

        time_remaining = ml.expires - now
        hours_remaining = max(0, time_remaining.total_seconds() / 3600)

        market_low = None
        is_undercut = False
        has_inventory = False
        if loc:
            market_low = best_sell.get((ml.type_id, loc.id))
            if market_low is not None:
                is_undercut = market_low < float(ml.list_price)
            has_inventory = (ml.type_id, loc.id) in inventory_pairs

        fee_frac = 0.0
        if loc:
            fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0

        net_per_unit = float(ml.list_price) * (1.0 - fee_frac)

        unit_cost = unit_costs.get((ml.type_id, loc.id)) if loc else None
        profit_per_unit = round(net_per_unit - unit_cost, 2) if unit_cost is not None else None

        jb = jita_buy.get(ml.type_id)
        js = jita_sell.get(ml.type_id)
        jita_split = round((jb + js) / 2, 2) if jb is not None and js is not None else None

        result.append({
            "id": ml.id,
            "order_id": ml.order_id,
            "type_id": ml.type_id,
            "item_name": names.get(ml.type_id, f"type:{ml.type_id}"),
            "location_name": loc_name,
            "location_known": loc is not None,
            "qty_total": ml.qty_total,
            "qty_remaining": ml.qty_remaining,
            "list_price": float(ml.list_price),
            "market_low": market_low,
            "is_undercut": is_undercut,
            "has_inventory": has_inventory,
            "profit_per_unit": profit_per_unit,
            "jita_buy": jb,
            "jita_sell": js,
            "jita_split": jita_split,
            "issued": ml.issued.isoformat(),
            "expires": ml.expires.isoformat(),
            "hours_remaining": round(hours_remaining, 1),
            "last_synced": ml.last_synced.isoformat(),
            "status": ml.status,
        })

    result.sort(key=lambda x: (x["has_inventory"], x["is_undercut"] is False, x["item_name"]))
    return result


class AddInventoryRequest(_Base):
    unit_cost: float
    qty: int | None = None  # defaults to listing qty_remaining


@router.post("/{listing_id}/add-inventory")
async def add_inventory(listing_id: int, body: AddInventoryRequest):
    async with AsyncSessionLocal() as session:
        ml = await session.get(MarketListing, listing_id)
        if not ml:
            raise HTTPException(404, "Listing not found")

        loc = (await session.execute(
            select(Location).where(Location.eve_id == ml.eve_location_id)
        )).scalar_one_or_none()
        if not loc:
            raise HTTPException(400, "Location not registered — add it in Settings → Locations first")

        qty = body.qty if body.qty is not None else ml.qty_remaining
        if qty <= 0:
            raise HTTPException(400, "Quantity must be positive")

        names = type_names([ml.type_id])
        item_name = names.get(ml.type_id, f"type:{ml.type_id}")

        session.add(InventoryLot(
            type_id=ml.type_id,
            item_name=item_name,
            location_id=loc.id,
            qty_original=qty,
            qty_remaining=qty,
            unit_cost=Decimal(str(body.unit_cost)),
            purchased_at=datetime.now(timezone.utc),
            source="manual",
        ))
        await session.commit()

    return {"ok": True, "item_name": item_name, "qty": qty}


@router.post("/sync")
async def sync_now():
    from ..market.orders_poller import poll_character_orders
    from ..market.transaction_poller import poll_wallet_transactions
    order_stats = await poll_character_orders()
    await poll_wallet_transactions()
    return {
        "ok": True,
        "orders_found": order_stats["found"],
        "orders_new": order_stats["new"],
        "orders_expired": order_stats["expired"],
    }


@router.delete("/{listing_id}")
async def cancel_listing(listing_id: int):
    async with AsyncSessionLocal() as session:
        ml = await session.get(MarketListing, listing_id)
        if not ml:
            raise HTTPException(404, "Listing not found")
        ml.status = "cancelled"
        await session.commit()
    return {"ok": True}
