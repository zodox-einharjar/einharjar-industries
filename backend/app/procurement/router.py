from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..doctrines.shortfall import aggregate_shortfalls
from ..industry.shortfall import aggregate_project_needs
from ..inventory.janice_parser import parse_janice_text
from ..inventory.simple_list_parser import parse_name_qty_text
from ..market.velocity import daily_velocity
from ..models import Location, MarketOrder
from ..sde import resolve_region_id
from ..settings.router import _load_settings
from .sourcing import compute_project_sourcing

router = APIRouter(prefix="/procurement", dependencies=[Depends(get_current_character)])


class EvaluateRequest(_Base):
    text: str
    price_type: str  # "buy" | "sell" | "split"
    location_id: int
    want_list_text: str = ""


@router.post("/evaluate")
async def evaluate(body: EvaluateRequest):
    parsed, parse_errors = parse_janice_text(body.text, body.price_type)
    unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed if not i["ok"]]
    resolved = [i for i in parsed if i["ok"]]

    want_resolved, unknown_wants = parse_name_qty_text(body.want_list_text)
    want_qty_by_type = {w["type_id"]: w["qty"] for w in want_resolved}

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

        # Does *any* doctrine/project (anywhere) currently have an open shortfall on this
        # item? Informational/priority flag only — not location-scoped, since the item is
        # already useful regardless of where the shortfall happens to be.
        shortfalls = await aggregate_shortfalls(session)
        project_needs = await aggregate_project_needs(session)
        target_type_ids = set(type_ids)
        needed_by_type: dict[int, dict] = {}
        for (_staging_id, tid), acc in shortfalls.items():
            if tid not in target_type_ids:
                continue
            entry = needed_by_type.setdefault(tid, {"doctrines": set(), "projects": set()})
            entry["doctrines"] |= acc["doctrines"]
        for (_loc_id, tid), acc in project_needs.items():
            if tid not in target_type_ids:
                continue
            entry = needed_by_type.setdefault(tid, {"doctrines": set(), "projects": set()})
            entry["projects"] |= acc["projects"]

        matched_want_types: set[int] = set()

        fee_frac = (loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct) / 100.0
        region_id = resolve_region_id(loc.eve_id, loc.region_id)
        history_cache: dict[tuple[int, int], list[dict]] = {}

        recommended = []
        unprofitable = []
        unpriced = []

        for item in resolved:
            tid = item["type_id"]
            want_qty = want_qty_by_type.get(tid)
            if want_qty is not None:
                matched_want_types.add(tid)

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

            v_daily = await daily_velocity(region_id, tid, history_cache) if region_id else 0.0
            low_velocity = v_daily <= 0

            needed = needed_by_type.get(tid)
            needed_by = {
                "doctrines": (
                    [{"doctrine_name": dn, "fit_name": fn} for dn, fn in sorted(needed["doctrines"])]
                    if needed else []
                ),
                "projects": sorted(needed["projects"]) if needed else [],
                "want_qty": want_qty,
            }
            row = {
                "type_id": tid, "name": item["item_name"], "qty": item["qty"],
                "unit_price": item["unit_price"], "staging_sell_price": sp,
                "profit_per_unit": profit_per_unit, "profit_pct": profit_pct,
                "total_profit": total_profit,
                "velocity_daily": round(v_daily, 2), "low_velocity": low_velocity,
                "days_to_sell": round(item["qty"] / v_daily, 1) if v_daily > 0 else None,
                "needed_by": needed_by,
            }

            if profit_per_unit > 0:
                recommended.append(row)
            else:
                unprofitable.append(row)

        # Only items that turn a profit are ever recommended — need flags affect sort
        # priority within that set, not whether an item qualifies at all.
        def _has_need(r):
            nb = r["needed_by"]
            return bool(nb["doctrines"] or nb["projects"] or nb["want_qty"])

        recommended.sort(key=lambda r: (not _has_need(r), -r["total_profit"]))
        unprofitable.sort(key=lambda r: r["total_profit"], reverse=True)

        unmatched_wants = [
            {"type_id": w["type_id"], "name": w["name"], "qty": w["qty"]}
            for w in want_resolved if w["type_id"] not in matched_want_types
        ]

        buyback_prices_by_type = {i["type_id"]: i["unit_price"] for i in resolved}
        settings_data = await _load_settings()
        efficiency = settings_data.get("reprocessing_efficiency_pct", 90.63) / 100.0
        project_sourcing = await compute_project_sourcing(session, buyback_prices_by_type, efficiency)

        return {
            "location_name": loc.name,
            "recommended": recommended,
            "unprofitable": unprofitable,
            "unpriced": unpriced,
            "unknown": unknown,
            "parse_errors": parse_errors,
            "unmatched_wants": unmatched_wants,
            "unknown_wants": unknown_wants,
            "project_sourcing": project_sourcing,
        }
