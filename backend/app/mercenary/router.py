from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import esi
from ..models import Character, MercenaryDen, MercenaryOperation
from ..sde import type_names

router = APIRouter(prefix="/mercenary", dependencies=[Depends(get_current_character)])


@router.get("/dens")
async def list_dens():
    async with AsyncSessionLocal() as session:
        dens = (await session.execute(select(MercenaryDen))).scalars().all()
        all_chars = (await session.execute(select(Character))).scalars().all()

    char_name_by_id = {c.id: c.character_name for c in all_chars}

    planet_ids = {d.planet_id for d in dens} | {d.skyhook_planet_id for d in dens if d.skyhook_planet_id}
    corp_ids = {d.skyhook_corporation_id for d in dens if d.skyhook_corporation_id}
    names = await esi.resolve_names(list(planet_ids | corp_ids))
    type_id_names = type_names(list({d.type_id for d in dens}))

    result = []
    for d in dens:
        result.append({
            "id": d.id,
            "den_id": d.den_id,
            "character_id": d.character_id,
            "character_name": char_name_by_id.get(d.character_id),
            "planet_id": d.planet_id,
            "planet_name": names.get(d.planet_id),
            "type_id": d.type_id,
            "type_name": type_id_names.get(d.type_id),
            "state": d.state,
            "development_level": d.development_level,
            "development_amount": d.development_amount,
            "anarchy_level": d.anarchy_level,
            "anarchy_amount": d.anarchy_amount,
            "infomorphs": d.infomorphs,
            "reinforced_until": d.reinforced_until.isoformat() if d.reinforced_until else None,
            "skyhook_id": d.skyhook_id,
            "skyhook_planet_id": d.skyhook_planet_id,
            "skyhook_planet_name": names.get(d.skyhook_planet_id) if d.skyhook_planet_id else None,
            "skyhook_corporation_id": d.skyhook_corporation_id,
            "skyhook_corporation_name": names.get(d.skyhook_corporation_id) if d.skyhook_corporation_id else None,
            "last_synced": d.last_synced.isoformat(),
        })

    result.sort(key=lambda x: x["character_name"] or "")
    return result


@router.get("/operations")
async def list_operations():
    async with AsyncSessionLocal() as session:
        operations = (await session.execute(select(MercenaryOperation))).scalars().all()
        dens = (await session.execute(select(MercenaryDen))).scalars().all()
        all_chars = (await session.execute(select(Character))).scalars().all()

    char_name_by_id = {c.id: c.character_name for c in all_chars}
    den_by_id = {d.den_id: d for d in dens}
    dungeon_names = type_names(list({op.dungeon_type_id for op in operations}))

    result = []
    for op in operations:
        den = den_by_id.get(op.den_id)
        result.append({
            "id": op.id,
            "operation_id": op.operation_id,
            "character_id": op.character_id,
            "character_name": char_name_by_id.get(op.character_id),
            "den_id": op.den_id,
            "den_planet_id": den.planet_id if den else None,
            "dungeon_type_id": op.dungeon_type_id,
            "dungeon_name": dungeon_names.get(op.dungeon_type_id),
            "state": op.state,
            "expires": op.expires.isoformat(),
            "last_synced": op.last_synced.isoformat(),
        })

    result.sort(key=lambda x: x["expires"])
    return result


@router.post("/sync")
async def sync_now():
    from ..mercenary.poller import poll_mercenary
    stats = await poll_mercenary()
    return {"ok": True, "count": stats["count"]}
