"""Fees that listing costs beyond the normal broker fee on a sale.

Broker fee and SCC surcharge are paid when an order is placed and aren't refunded, so:
- units still unsold when an order ends carry that fee as extra cost when relisted;
- changing an order's price charges a separate fee.

Both are added to the unit_cost of the stock they relate to, and each is recorded once
in listing_fee_charges.
"""
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select

from ..models import AppSetting, InventoryLot, ListingFeeCharge, Location

_START_KEY = "listing_fees_start"
_MIN_REPRICE_FEE = 100.0
DEFAULT_RELIST_DISCOUNT_PCT = 80.0  # 50% base + Advanced Broker Relations V


def upfront_rate(loc: Location) -> float:
    return (loc.broker_fee_pct + loc.scc_surcharge_pct) / 100.0


def reprice_fee(old_price: float, new_price: float, qty: int, rate: float, relist_discount: float) -> float:
    """EVE's order modification fee: broker fee on any increase in order value, plus the
    discounted broker fee on the new order value. Never less than 100 ISK."""
    old_value, new_value = old_price * qty, new_price * qty
    return max(_MIN_REPRICE_FEE, max(0.0, rate * (new_value - old_value)) + (1 - relist_discount) * rate * new_value)


async def relist_discount(session) -> float:
    setting = await session.get(AppSetting, "relist_discount_pct")
    return float(setting.value if setting and setting.value else DEFAULT_RELIST_DISCOUNT_PCT) / 100.0


async def tracking_start(session) -> datetime:
    """When charging began. Orders that ended before this aren't charged: their stock
    has moved on, so old fees would land on the wrong lots."""
    setting = await session.get(AppSetting, _START_KEY)
    if setting:
        return datetime.fromisoformat(setting.value)
    now = datetime.now(timezone.utc)
    session.add(AppSetting(key=_START_KEY, value=now.isoformat()))
    return now


async def charge_lots(
    session, *, order_id: int, kind: str, order_issued: datetime,
    type_id: int, location_id: int, qty: int, amount: float,
) -> bool:
    """Add `amount` ISK to the cost of the oldest `qty` units in stock. Returns False if
    this charge was already made."""
    already = (await session.execute(
        select(ListingFeeCharge.id).where(
            ListingFeeCharge.order_id == order_id,
            ListingFeeCharge.kind == kind,
            ListingFeeCharge.order_issued == order_issued,
        )
    )).first()
    if already:
        return False

    lots = (await session.execute(
        select(InventoryLot)
        .where(
            InventoryLot.type_id == type_id,
            InventoryLot.location_id == location_id,
            InventoryLot.qty_remaining > 0,
        )
        .order_by(InventoryLot.purchased_at)
    )).scalars().all()

    covered = min(qty, sum(l.qty_remaining for l in lots))
    if covered > 0:
        per_unit = (Decimal(str(amount)) / covered).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        left = covered
        for lot in lots:
            if left <= 0:
                break
            take = min(left, lot.qty_remaining)
            if take == lot.qty_remaining:
                lot.unit_cost += per_unit
            else:
                # Only part of this lot is affected: spread its share across the lot.
                lot.unit_cost += (per_unit * take / lot.qty_remaining).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            left -= take

    session.add(ListingFeeCharge(
        order_id=order_id, kind=kind, order_issued=order_issued, type_id=type_id,
        location_id=location_id, qty=qty, qty_charged=covered, amount=Decimal(str(round(amount, 2))),
        charged_at=datetime.now(timezone.utc),
    ))
    return True
