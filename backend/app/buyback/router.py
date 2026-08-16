from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..doctrines.shortfall import aggregate_shortfalls
from ..inventory.janice_parser import parse_janice_text
from ..inventory.lots import save_lots
from ..models import Location, MarketOrder

router = APIRouter(prefix="/buyback", dependencies=[Depends(get_current_character)])


class EvaluateRequest(_Base):
    text: str
    price_type: str  # "buy" | "sell" | "split"
    location_id: int


class _BuybackItem(_Base):
    type_id: int
    item_name: str
    qty: int
    unit_price: float


class AcceptRequest(_Base):
    items: list[_BuybackItem]
    location_id: int


@router.post("/evaluate")
async def evaluate(body: EvaluateRequest):
    parsed, parse_errors = parse_janice_text(body.text, body.price_type)
    unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed if not i["ok"]]
    resolved = [i for i in parsed if i["ok"]]

    async with AsyncSessionLocal() as session:
        loc = await session.get(Location, body.location_id)
        if not loc:
            raise HTTPException(404, "Location not found")

        type_ids = [i["type_id"] for i in resolved]
        staging_price: dict[int, float] = {}
        if type_ids:
            rows = (await session.execute(
                select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
                .where(MarketOrder.location_id == loc.id)
                .where(MarketOrder.type_id.in_(type_ids))
                .where(MarketOrder.is_buy.is_(False))
                .group_by(MarketOrder.type_id)
            )).all()
            staging_price = {r.type_id: float(r.price) for r in rows}

        # Does *any* doctrine (anywhere) currently have an open shortfall on this item?
        # Informational/priority flag only — not location-scoped, since the item is
        # already in hand regardless of where the shortfall happens to be.
        shortfalls = await aggregate_shortfalls(session)
        target_type_ids = set(type_ids)
        needed_by_type: dict[int, dict] = {}
        for (_staging_id, tid), acc in shortfalls.items():
            if tid not in target_type_ids:
                continue
            entry = needed_by_type.setdefault(tid, {"qty_shortfall": 0, "doctrines": set()})
            entry["qty_shortfall"] += acc["qty_shortfall"]
            entry["doctrines"] |= acc["doctrines"]

        fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0

        recommended = []
        unprofitable = []
        unpriced = []

        for item in resolved:
            tid = item["type_id"]
            sp = staging_price.get(tid)
            if sp is None:
                unpriced.append({
                    "type_id": tid, "name": item["item_name"], "qty": item["qty"],
                    "unit_price": item["unit_price"],
                })
                continue

            net_proceeds = sp * (1 - fee_frac)
            profit_per_unit = net_proceeds - item["unit_price"]
            profit_pct = (profit_per_unit / item["unit_price"] * 100) if item["unit_price"] > 0 else None
            total_profit = profit_per_unit * item["qty"]

            needed = needed_by_type.get(tid)
            row = {
                "type_id": tid, "name": item["item_name"], "qty": item["qty"],
                "unit_price": item["unit_price"], "staging_sell_price": sp,
                "profit_per_unit": profit_per_unit, "profit_pct": profit_pct,
                "total_profit": total_profit,
                "needed": needed is not None,
                "doctrines": (
                    [{"doctrine_name": dn, "fit_name": fn} for dn, fn in sorted(needed["doctrines"])]
                    if needed else []
                ),
            }

            if profit_per_unit > 0:
                recommended.append(row)
            else:
                unprofitable.append(row)

        # Only items that turn a profit are ever recommended — doctrine need affects
        # sort priority within that set, not whether an item qualifies at all.
        recommended.sort(key=lambda r: (not r["needed"], -r["total_profit"]))
        unprofitable.sort(key=lambda r: r["total_profit"], reverse=True)

        return {
            "location_name": loc.name,
            "recommended": recommended,
            "unprofitable": unprofitable,
            "unpriced": unpriced,
            "unknown": unknown,
            "parse_errors": parse_errors,
        }


@router.post("/accept")
async def accept(body: AcceptRequest):
    async with AsyncSessionLocal() as session:
        loc = await session.get(Location, body.location_id)
        if not loc:
            raise HTTPException(404, "Location not found")
        created = save_lots(session, body.items, body.location_id, source="buyback")
        await session.commit()
    return {"created": created}
