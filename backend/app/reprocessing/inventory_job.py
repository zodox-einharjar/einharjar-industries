import sqlite3
from decimal import Decimal
from math import floor

from fastapi import HTTPException
from sqlalchemy import func, select

from ..models import InventoryLot, Location, MarketOrder
from ..sde import portion_sizes, reprocessing_materials, type_names

_JITA_EVE_ID = 60003760


async def compute_reprocess_job(
    session, location_id: int, items: list[dict], efficiency_pct: float, fee_pct: float,
) -> dict:
    """Preview (and the basis for confirming) a reprocessing job against owned inventory.

    items: [{"type_id": int, "qty": int}] — quantity requested to reprocess, at location_id.
    Quantity is floored to whole portions (EVE can't reprocess a partial batch); any
    remainder is left untouched in inventory, not consumed.

    Output quantities come from efficiency_pct alone — the station fee does NOT reduce
    yield. Instead fee_pct is charged against the reference market value of the raw
    output (local sell price at location_id, falling back to Jita) as a flat ISK cost,
    exactly like freight cost gets folded into a transferred lot's cost basis elsewhere
    in this app (see inventory/router.py::_fifo_transfer). That total cost — the
    consumed ore's original cost basis plus the fee — is then allocated across the
    output minerals in proportion to each one's share of reference market value (the
    standard joint-cost "relative sales value" allocation), so a cheap high-volume
    mineral like Tritanium doesn't end up with the same $/unit as a rare one.

    Returns {"ok": False, "errors": [...]} on any problem, or
    {"ok": True, "location_name", "inputs", "outputs", "total_input_cost", "fee_pct",
     "fee_isk", "total_output_reference_value", "total_cost_to_allocate", "efficiency_pct"}.
    Each input: {type_id, name, qty_requested, qty_consumed, qty_leftover, unit_cost, line_cost}.
    Each output: {type_id, name, qty, reference_price, reference_value, value_share_pct,
                  allocated_cost, unit_cost}.
    """
    type_ids = [i["type_id"] for i in items]
    if not type_ids:
        return {"ok": False, "errors": ["No items selected."]}

    try:
        sizes = portion_sizes(type_ids)
        mats = reprocessing_materials(type_ids)
    except sqlite3.OperationalError:
        raise HTTPException(
            503,
            "Reprocessing data isn't in the local SDE yet — go to Settings → General "
            "and click \"Update SDE\", then try again.",
        )
    names = type_names(type_ids)

    lots_by_type: dict[int, list[InventoryLot]] = {}
    rows = (await session.execute(
        select(InventoryLot)
        .where(InventoryLot.location_id == location_id)
        .where(InventoryLot.type_id.in_(type_ids))
        .where(InventoryLot.qty_remaining > 0)
        .order_by(InventoryLot.purchased_at)
    )).scalars().all()
    for lot in rows:
        lots_by_type.setdefault(lot.type_id, []).append(lot)

    efficiency = efficiency_pct / 100.0

    inputs: list[dict] = []
    produced: dict[int, int] = {}
    errors: list[str] = []

    for item in items:
        tid, requested = item["type_id"], item["qty"]
        name = names.get(tid, f"[{tid}]")
        portion = sizes.get(tid)
        yields = {m["material_type_id"]: m["quantity"] for m in mats.get(tid, [])}
        if not portion or not yields:
            errors.append(f"{name} has no reprocessing data")
            continue

        lots = lots_by_type.get(tid, [])
        available = sum(lot.qty_remaining for lot in lots)
        if requested <= 0 or requested > available:
            errors.append(f"{name}: requested {requested:,}, only {available:,} available")
            continue

        batches = requested // portion
        qty_consumed = batches * portion
        if qty_consumed <= 0:
            errors.append(f"{name}: {requested:,} is less than one portion ({portion:,})")
            continue

        remaining = qty_consumed
        cost = Decimal(0)
        for lot in lots:
            if remaining <= 0:
                break
            take = min(remaining, lot.qty_remaining)
            cost += take * lot.unit_cost
            remaining -= take

        inputs.append({
            "type_id": tid, "name": name,
            "qty_requested": requested, "qty_consumed": qty_consumed,
            "qty_leftover": requested - qty_consumed,
            "unit_cost": float(cost / qty_consumed), "line_cost": float(cost),
        })
        for mtid, mqty in yields.items():
            produced[mtid] = produced.get(mtid, 0) + floor(batches * mqty * efficiency)

    if errors:
        return {"ok": False, "errors": errors}
    if not inputs or not produced:
        return {"ok": False, "errors": ["Nothing to reprocess."]}

    total_input_cost = sum(i["line_cost"] for i in inputs)

    out_type_ids = list(produced.keys())
    out_names = type_names(out_type_ids)

    loc = await session.get(Location, location_id)
    jita_loc = (await session.execute(
        select(Location).where(Location.eve_id == _JITA_EVE_ID)
    )).scalar_one_or_none()

    local_prices: dict[int, float] = {}
    rows = (await session.execute(
        select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
        .where(MarketOrder.location_id == location_id)
        .where(MarketOrder.type_id.in_(out_type_ids))
        .where(MarketOrder.is_buy.is_(False))
        .group_by(MarketOrder.type_id)
    )).all()
    local_prices = {r.type_id: float(r.price) for r in rows}

    jita_prices: dict[int, float] = {}
    if jita_loc:
        rows = (await session.execute(
            select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
            .where(MarketOrder.location_id == jita_loc.id)
            .where(MarketOrder.type_id.in_(out_type_ids))
            .where(MarketOrder.is_buy.is_(False))
            .group_by(MarketOrder.type_id)
        )).all()
        jita_prices = {r.type_id: float(r.price) for r in rows}

    reference_prices = {tid: local_prices.get(tid) or jita_prices.get(tid) or 0.0 for tid in out_type_ids}
    total_output_reference_value = sum(produced[tid] * reference_prices[tid] for tid in out_type_ids)

    fee_isk = total_output_reference_value * (fee_pct / 100.0)
    total_cost_to_allocate = total_input_cost + fee_isk
    total_qty_all = sum(produced.values())

    outputs = []
    for tid in out_type_ids:
        qty = produced[tid]
        ref_price = reference_prices[tid]
        ref_value = qty * ref_price
        # If nothing has price data at all, fall back to splitting cost by raw quantity
        # rather than producing a division-by-zero share.
        share = (
            ref_value / total_output_reference_value if total_output_reference_value > 0
            else (qty / total_qty_all if total_qty_all else 0.0)
        )
        allocated_cost = total_cost_to_allocate * share
        outputs.append({
            "type_id": tid, "name": out_names.get(tid, f"[{tid}]"), "qty": qty,
            "reference_price": ref_price, "reference_value": ref_value,
            "value_share_pct": share * 100.0,
            "allocated_cost": allocated_cost,
            "unit_cost": (allocated_cost / qty) if qty else 0.0,
        })
    outputs.sort(key=lambda o: -o["allocated_cost"])

    return {
        "ok": True,
        "location_name": loc.name if loc else None,
        "inputs": inputs,
        "outputs": outputs,
        "total_input_cost": total_input_cost,
        "fee_pct": fee_pct,
        "fee_isk": fee_isk,
        "total_output_reference_value": total_output_reference_value,
        "total_cost_to_allocate": total_cost_to_allocate,
        "efficiency_pct": efficiency_pct,
    }
