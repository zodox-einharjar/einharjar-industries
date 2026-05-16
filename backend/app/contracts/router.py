from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import esi
from ..models import Character, Contract
from ..sde import station_name

router = APIRouter(prefix="/contracts", dependencies=[Depends(get_current_character)])

_NPC_STATION_MAX = 1_000_000_000


def _loc_name(loc_id: int | None) -> str | None:
    if loc_id is None:
        return None
    if loc_id < _NPC_STATION_MAX:
        return station_name(loc_id)
    return None


@router.get("")
async def list_contracts():
    async with AsyncSessionLocal() as session:
        contracts = (await session.execute(select(Contract))).scalars().all()
        all_chars = (await session.execute(select(Character))).scalars().all()

    our_char_ids = {c.character_id for c in all_chars}
    our_corp_ids = {c.corporation_id for c in all_chars if c.corporation_id}
    char_name_by_id = {c.character_id: c.character_name for c in all_chars}

    # Collect IDs that aren't already known from our own characters
    unknown_ids = {
        c.issuer_id for c in contracts if c.issuer_id not in char_name_by_id
    } | {
        c.assignee_id for c in contracts
        if c.assignee_id and c.assignee_id not in char_name_by_id
    }
    resolved = await esi.resolve_names(list(unknown_ids))
    name_by_id = {**char_name_by_id, **resolved}

    result = []
    for c in contracts:
        if c.issuer_id in our_char_ids or c.issuer_corporation_id in our_corp_ids:
            direction = "outgoing"
        else:
            direction = "incoming"

        result.append({
            "id": c.id,
            "contract_id": c.contract_id,
            "type": c.type,
            "status": c.status,
            "title": c.title,
            "direction": direction,
            "issuer_id": c.issuer_id,
            "issuer_name": name_by_id.get(c.issuer_id),
            "assignee_id": c.assignee_id,
            "assignee_name": name_by_id.get(c.assignee_id) if c.assignee_id else None,
            "for_corporation": c.for_corporation,
            "availability": c.availability,
            "price": float(c.price) if c.price is not None else None,
            "reward": float(c.reward) if c.reward is not None else None,
            "collateral": float(c.collateral) if c.collateral is not None else None,
            "volume": c.volume,
            "date_issued": c.date_issued.isoformat(),
            "date_expired": c.date_expired.isoformat(),
            "date_accepted": c.date_accepted.isoformat() if c.date_accepted else None,
            "date_completed": c.date_completed.isoformat() if c.date_completed else None,
            "days_to_complete": c.days_to_complete,
            "start_location_name": _loc_name(c.start_location_id),
            "end_location_name": _loc_name(c.end_location_id),
            "last_synced": c.last_synced.isoformat(),
        })

    _status_order = {
        "outstanding": 0, "in_progress": 1,
        "finished_issuer": 2, "finished_contractor": 2, "finished": 3,
    }
    result.sort(key=lambda x: (_status_order.get(x["status"], 4), x["date_expired"]))
    return result


@router.post("/sync")
async def sync_now():
    from ..contracts.poller import poll_contracts
    stats = await poll_contracts()
    return {"ok": True, "count": stats["count"]}
