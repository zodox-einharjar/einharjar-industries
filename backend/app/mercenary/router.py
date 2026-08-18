from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import esi
from ..models import Character, MercenaryDen, MercenaryDenSnapshot, MercenaryOperation
from ..sde import type_names

router = APIRouter(prefix="/mercenary", dependencies=[Depends(get_current_character)])

# Development/anarchy bands are 20/20/30/30 (cumulative thresholds 20-40-70-100),
# not evenly spaced — confirmed by the user, not documented by CCP anywhere public.
_LEVEL_THRESHOLDS = [20, 40, 70, 100]
_MIN_RATE_WINDOW = timedelta(minutes=20)

# Infomorph generation rate depends on development level (confirmed by the
# user; not in any public ESI/wiki documentation). Shown as a range since
# the exact instantaneous rate within a level isn't known.
_INFOMORPH_RATE_BY_LEVEL: dict[str, tuple[int, int]] = {
    "Level0": (64, 100),
    "Level1": (68, 105),
    "Level2": (71, 110),
    "Level3": (74, 115),
    "Level4": (78, 120),
}


def _level_index(level: str) -> int | None:
    if not level.startswith("Level"):
        return None
    try:
        return int(level[len("Level"):])
    except ValueError:
        return None


def _next_level_threshold(level: str) -> int | None:
    idx = _level_index(level)
    if idx is None or idx >= len(_LEVEL_THRESHOLDS):
        return None
    return _LEVEL_THRESHOLDS[idx]


async def _estimate_next_level(
    session: AsyncSession, den_id: int, level_field: str, amount_field: str,
    current_level: str, current_amount: int,
) -> datetime | None:
    threshold = _next_level_threshold(current_level)
    if threshold is None or current_amount >= threshold:
        return None

    level_col = getattr(MercenaryDenSnapshot, level_field)
    result = await session.execute(
        select(MercenaryDenSnapshot)
        .where(MercenaryDenSnapshot.den_id == den_id, level_col == current_level)
        .order_by(MercenaryDenSnapshot.recorded_at.asc())
    )
    snaps = result.scalars().all()
    if len(snaps) < 2:
        return None

    earliest, latest = snaps[0], snaps[-1]
    elapsed = latest.recorded_at - earliest.recorded_at
    if elapsed < _MIN_RATE_WINDOW:
        return None

    delta = getattr(latest, amount_field) - getattr(earliest, amount_field)
    if delta <= 0:
        return None

    rate_per_second = delta / elapsed.total_seconds()
    seconds_needed = (threshold - current_amount) / rate_per_second
    return datetime.now(timezone.utc) + timedelta(seconds=seconds_needed)


async def _mto_status(session: AsyncSession, den_id: int) -> tuple[dict | None, str | None]:
    """Returns (active_operation, next_mto_estimate_iso). The estimate is
    only populated once at least two past spawns have been observed for this
    den, projecting from their average gap — CCP doesn't document a spawn
    trigger, so this can't be computed any other way."""
    result = await session.execute(
        select(MercenaryOperation)
        .where(MercenaryOperation.den_id == den_id)
        .order_by(MercenaryOperation.first_seen_at.asc())
    )
    ops = result.scalars().all()

    active = next((op for op in reversed(ops) if op.state in ("Available", "Started")), None)
    if active:
        return {
            "state": active.state,
            "expires": active.expires.isoformat(),
            "dungeon_type_id": active.dungeon_type_id,
        }, None

    if len(ops) < 2:
        return None, None

    gaps = [
        (ops[i].first_seen_at - ops[i - 1].first_seen_at).total_seconds()
        for i in range(1, len(ops))
    ]
    avg_gap = sum(gaps) / len(gaps)
    projected = ops[-1].first_seen_at + timedelta(seconds=avg_gap)
    if projected <= datetime.now(timezone.utc):
        return None, None  # overdue vs. the observed average — spawning likely isn't purely periodic

    return None, projected.isoformat()


@router.get("/dens")
async def list_dens():
    async with AsyncSessionLocal() as session:
        dens = (await session.execute(select(MercenaryDen))).scalars().all()
        all_chars = (await session.execute(select(Character))).scalars().all()

        char_name_by_id = {c.id: c.character_name for c in all_chars}
        planet_ids = {d.planet_id for d in dens} | {d.skyhook_planet_id for d in dens if d.skyhook_planet_id}
        corp_ids = {d.skyhook_corporation_id for d in dens if d.skyhook_corporation_id}
        planet_names = await esi.resolve_planet_names(list(planet_ids))
        corp_names = await esi.resolve_names(list(corp_ids))
        type_id_names = type_names(list({d.type_id for d in dens}))

        result = []
        for d in dens:
            development_eta = await _estimate_next_level(
                session, d.den_id, "development_level", "development_amount",
                d.development_level, d.development_amount,
            )
            anarchy_eta = await _estimate_next_level(
                session, d.den_id, "anarchy_level", "anarchy_amount",
                d.anarchy_level, d.anarchy_amount,
            )
            infomorph_rate_range = _INFOMORPH_RATE_BY_LEVEL.get(d.development_level)
            active_op, next_mto_estimate = await _mto_status(session, d.den_id)

            result.append({
                "id": d.id,
                "den_id": d.den_id,
                "character_id": d.character_id,
                "character_name": char_name_by_id.get(d.character_id),
                "planet_id": d.planet_id,
                "planet_name": planet_names.get(d.planet_id),
                "type_id": d.type_id,
                "type_name": type_id_names.get(d.type_id),
                "state": d.state,
                "development_level": d.development_level,
                "development_amount": d.development_amount,
                "development_next_level_at": development_eta.isoformat() if development_eta else None,
                "anarchy_level": d.anarchy_level,
                "anarchy_amount": d.anarchy_amount,
                "anarchy_next_level_at": anarchy_eta.isoformat() if anarchy_eta else None,
                "infomorphs": d.infomorphs,
                "infomorphs_rate_min": infomorph_rate_range[0] if infomorph_rate_range else None,
                "infomorphs_rate_max": infomorph_rate_range[1] if infomorph_rate_range else None,
                "reinforced_until": d.reinforced_until.isoformat() if d.reinforced_until else None,
                "skyhook_id": d.skyhook_id,
                "skyhook_planet_id": d.skyhook_planet_id,
                "skyhook_planet_name": planet_names.get(d.skyhook_planet_id) if d.skyhook_planet_id else None,
                "skyhook_corporation_id": d.skyhook_corporation_id,
                "skyhook_corporation_name": corp_names.get(d.skyhook_corporation_id) if d.skyhook_corporation_id else None,
                "active_operation": active_op,
                "next_mto_estimate_at": next_mto_estimate,
                "last_synced": d.last_synced.isoformat(),
            })

        dungeon_ids = {row["active_operation"]["dungeon_type_id"] for row in result if row["active_operation"]}
        dungeon_names = type_names(list(dungeon_ids))
        for row in result:
            if row["active_operation"]:
                row["active_operation"]["dungeon_name"] = dungeon_names.get(row["active_operation"]["dungeon_type_id"])

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
            "first_seen_at": op.first_seen_at.isoformat(),
            "last_synced": op.last_synced.isoformat(),
        })

    # Stable sort: most-recent first within each group, live operations surfaced above history.
    is_live = lambda r: r["state"] in ("Available", "Started")
    result.sort(key=lambda r: r["first_seen_at"], reverse=True)
    result.sort(key=is_live, reverse=True)
    return result


@router.post("/sync")
async def sync_now():
    from ..mercenary.poller import poll_mercenary
    stats = await poll_mercenary()
    return {"ok": True, "count": stats["count"]}
