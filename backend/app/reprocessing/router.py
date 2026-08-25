import sqlite3
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..inventory.janice_parser import parse_janice_text
from ..inventory.simple_list_parser import parse_name_qty_text
from ..models import InventoryLot
from ..sde import portion_sizes, reprocessing_materials
from ..settings.router import _load_settings
from .inventory_job import compute_reprocess_job
from .optimizer import solve_ore_lp

router = APIRouter(prefix="/reprocessing", dependencies=[Depends(get_current_character)])


# ── Buy planner (LP-optimized ore/mineral purchase) ─────────────────────────────

class OptimizeRequest(_Base):
    minerals_text: str
    supply_text: str        # ore and/or raw minerals available to buy, Janice paste format
    price_type: str         # "buy" | "sell" | "split"
    efficiency_pct: float | None = None


async def _resolve_efficiency_pct(efficiency_pct: float | None) -> float:
    if efficiency_pct is not None:
        return efficiency_pct
    settings_data = await _load_settings()
    return settings_data.get("reprocessing_efficiency_pct", 90.63)


@router.post("/optimize")
async def optimize(body: OptimizeRequest):
    minerals, mineral_unresolved = parse_name_qty_text(body.minerals_text)
    mineral_id_set = {m["type_id"] for m in minerals}

    parsed_supply, supply_parse_errors = parse_janice_text(body.supply_text, body.price_type)
    supply_unknown = [{"item_name": i["item_name"], "qty": i["qty"]} for i in parsed_supply if not i["ok"]]
    supply_unpriced = [
        {"type_id": i["type_id"], "name": i["item_name"], "qty": i["qty"]}
        for i in parsed_supply if i["ok"] and i["unit_price"] <= 0
    ]
    supply_resolved = [i for i in parsed_supply if i["ok"] and i["unit_price"] > 0]

    efficiency_pct = await _resolve_efficiency_pct(body.efficiency_pct)
    efficiency = efficiency_pct / 100.0

    supply_type_ids = [i["type_id"] for i in supply_resolved]
    try:
        mats_by_type = reprocessing_materials(supply_type_ids)
        sizes_by_type = portion_sizes(supply_type_ids)
    except sqlite3.OperationalError:
        raise HTTPException(
            503,
            "Reprocessing data isn't in the local SDE yet — go to Settings → General "
            "and click \"Update SDE\", then try again.",
        )

    # Each pasted line can contribute up to two independent supply options:
    # reprocessing it (if it's ore/anything with reprocessing yield data), and/or
    # buying it outright (if it's itself one of the requested minerals — no
    # reprocessing loss). Both are modeled the same way for the LP: a "portion"
    # size, a cost per portion, and a mineral yield per portion.
    options: list[dict] = []
    for i in supply_resolved:
        tid = i["type_id"]
        portion = sizes_by_type.get(tid)
        yields = {m["material_type_id"]: m["quantity"] for m in mats_by_type.get(tid, [])}
        if portion and yields:
            max_batches = i["qty"] // portion
            if max_batches > 0:
                options.append({
                    "type_id": tid, "name": i["item_name"], "unit_price": i["unit_price"],
                    "mode": "reprocess", "portion": portion, "yields": yields,
                    "efficiency": efficiency, "max_batches": max_batches,
                })
        if tid in mineral_id_set and i["qty"] > 0:
            options.append({
                "type_id": tid, "name": i["item_name"], "unit_price": i["unit_price"],
                "mode": "direct", "portion": 1, "yields": {tid: 1},
                "efficiency": 1.0, "max_batches": i["qty"],
            })

    result = solve_ore_lp(minerals, options)

    return {
        **result,
        "efficiency_pct": efficiency * 100,
        "unpriced": supply_unpriced,
        "unknown": supply_unknown,
        "parse_errors": supply_parse_errors,
        "mineral_unresolved": mineral_unresolved,
    }


# ── Reprocess owned inventory ────────────────────────────────────────────────────

class ReprocessItem(_Base):
    type_id: int
    qty: int


class ReprocessJobRequest(_Base):
    location_id: int
    items: list[ReprocessItem]
    efficiency_pct: float | None = None
    fee_pct: float = 0.0


@router.get("/inventory-candidates")
async def inventory_candidates(location_id: int):
    async with AsyncSessionLocal() as session:
        lots = (await session.execute(
            select(InventoryLot)
            .where(InventoryLot.location_id == location_id)
            .where(InventoryLot.qty_remaining > 0)
        )).scalars().all()

        by_type: dict[int, list[InventoryLot]] = {}
        for lot in lots:
            by_type.setdefault(lot.type_id, []).append(lot)
        type_ids = list(by_type.keys())

        try:
            sizes = portion_sizes(type_ids)
            mats = reprocessing_materials(type_ids)
        except sqlite3.OperationalError:
            raise HTTPException(
                503,
                "Reprocessing data isn't in the local SDE yet — go to Settings → General "
                "and click \"Update SDE\", then try again.",
            )

        candidates = []
        for tid, tid_lots in by_type.items():
            if tid not in sizes or not mats.get(tid):
                continue
            qty = sum(lot.qty_remaining for lot in tid_lots)
            cost = sum(lot.qty_remaining * lot.unit_cost for lot in tid_lots)
            candidates.append({
                "type_id": tid, "name": tid_lots[0].item_name,
                "qty_available": qty, "unit_cost": float(cost / qty) if qty else 0.0,
                "portion_size": sizes[tid],
            })
        candidates.sort(key=lambda c: c["name"])

    return {"candidates": candidates}


@router.post("/inventory-preview")
async def inventory_preview(body: ReprocessJobRequest):
    efficiency_pct = await _resolve_efficiency_pct(body.efficiency_pct)
    async with AsyncSessionLocal() as session:
        result = await compute_reprocess_job(
            session, body.location_id, [i.model_dump() for i in body.items], efficiency_pct, body.fee_pct,
        )
    return result


@router.post("/inventory-confirm")
async def inventory_confirm(body: ReprocessJobRequest):
    efficiency_pct = await _resolve_efficiency_pct(body.efficiency_pct)
    async with AsyncSessionLocal() as session:
        items = [i.model_dump() for i in body.items]
        result = await compute_reprocess_job(session, body.location_id, items, efficiency_pct, body.fee_pct)
        if not result["ok"]:
            raise HTTPException(400, "; ".join(result["errors"]))

        # Recompute wasn't a mutation — do the actual FIFO deduction now, against the
        # exact qty_consumed each preview line already validated against available stock.
        type_ids = [i["type_id"] for i in items]
        rows = (await session.execute(
            select(InventoryLot)
            .where(InventoryLot.location_id == body.location_id)
            .where(InventoryLot.type_id.in_(type_ids))
            .where(InventoryLot.qty_remaining > 0)
            .order_by(InventoryLot.purchased_at)
        )).scalars().all()
        lots_by_type: dict[int, list[InventoryLot]] = {}
        for lot in rows:
            lots_by_type.setdefault(lot.type_id, []).append(lot)

        for inp in result["inputs"]:
            remaining = inp["qty_consumed"]
            for lot in lots_by_type.get(inp["type_id"], []):
                if remaining <= 0:
                    break
                take = min(remaining, lot.qty_remaining)
                lot.qty_remaining -= take
                remaining -= take
            if remaining > 0:
                raise HTTPException(409, f"{inp['name']}: inventory changed since preview, try again.")

        now = datetime.now(timezone.utc)
        for out in result["outputs"]:
            session.add(InventoryLot(
                type_id=out["type_id"], item_name=out["name"], location_id=body.location_id,
                qty_original=out["qty"], qty_remaining=out["qty"],
                unit_cost=Decimal(str(round(out["unit_cost"], 2))),
                purchased_at=now, source="reprocess",
            ))
        await session.commit()

    return result
