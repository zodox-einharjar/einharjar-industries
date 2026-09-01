from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..auth.tokens import get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import esi, ESIError
from ..models import Character, IndustryJob
from ..sde import station_name, system_name, type_names, type_group_ids, type_volumes
from . import pi_constants

router = APIRouter(prefix="/character", dependencies=[Depends(get_current_character)])

# Same activity_id groupings as industry_jobs/router.py's _ACTIVITY_LABELS.
_MANUFACTURING_ACTIVITY = 1
_REACTION_ACTIVITY = 9
_SCIENCE_ACTIVITIES = {3, 4, 5, 7, 8}
# A "ready" job is complete but not yet collected — it still occupies the slot in-game.
_SLOT_OCCUPYING_STATUSES = ("active", "paused", "ready")

_LOCATION_SCOPES = ["esi-location.read_location.v1"]
_SHIP_SCOPES = ["esi-location.read_ship_type.v1"]
_IMPLANTS_SCOPES = ["esi-clones.read_implants.v1"]
_SKILLS_SCOPES = ["esi-skills.read_skills.v1"]
_SKILLQUEUE_SCOPES = ["esi-skills.read_skillqueue.v1"]
_PLANETS_SCOPES = ["esi-planets.manage_planets.v1"]
_STRUCTURE_NAME_SCOPES = ["esi-universe.read_structures.v1"]


def _missing(char: Character, required: list[str]) -> list[str]:
    have = set(char.scopes or [])
    return [s for s in required if s not in have]


def _slot_bucket(levels: dict[int, int], skill_ids: list[int]) -> int:
    return 1 + sum(levels.get(sid, 0) for sid in skill_ids)


@router.get("/overview")
async def overview(char: Character = Depends(get_current_character)):
    async with AsyncSessionLocal() as session:
        token = await get_valid_token(char, session)
    cid = char.character_id

    missing_scopes: list[str] = []

    wallet = await esi.get(f"/characters/{cid}/wallet/", token=token)

    location_name: str | None = None
    system: str | None = None
    location_missing = _missing(char, _LOCATION_SCOPES)
    if location_missing:
        missing_scopes += location_missing
    else:
        loc = await esi.get(f"/characters/{cid}/location/", token=token)
        system = system_name(loc.get("solar_system_id"))
        if loc.get("station_id"):
            location_name = station_name(loc["station_id"])
        elif loc.get("structure_id"):
            structure_missing = _missing(char, _STRUCTURE_NAME_SCOPES)
            if structure_missing:
                missing_scopes += structure_missing
                location_name = f"Structure {loc['structure_id']}"
            else:
                try:
                    struct = await esi.get(f"/universe/structures/{loc['structure_id']}/", token=token)
                    location_name = struct.get("name")
                except ESIError:
                    location_name = f"Structure {loc['structure_id']}"
        else:
            location_name = None  # in space

    ship_type_id: int | None = None
    ship_name: str | None = None
    ship_missing = _missing(char, _SHIP_SCOPES)
    if ship_missing:
        missing_scopes += ship_missing
    else:
        ship = await esi.get(f"/characters/{cid}/ship/", token=token)
        ship_type_id = ship.get("ship_type_id")
        if ship_type_id:
            ship_name = type_names([ship_type_id]).get(ship_type_id)

    implants: list[dict] = []
    implants_missing = _missing(char, _IMPLANTS_SCOPES)
    if implants_missing:
        missing_scopes += implants_missing
    else:
        implant_ids = await esi.get(f"/characters/{cid}/implants/", token=token)
        names = type_names(implant_ids)
        implants = [{"type_id": tid, "name": names.get(tid)} for tid in implant_ids]

    slots = {
        "manufacturing": {"in_use": 0, "total": None},
        "reactions": {"in_use": 0, "total": None},
        "science": {"in_use": 0, "total": None},
    }
    skills_missing = _missing(char, _SKILLS_SCOPES)
    if skills_missing:
        missing_scopes += skills_missing
    else:
        skills_data = await esi.get(f"/characters/{cid}/skills/", token=token)
        levels = {s["skill_id"]: s["active_skill_level"] for s in skills_data.get("skills", [])}
        slots["manufacturing"]["total"] = _slot_bucket(levels, pi_constants.MANUFACTURING_SKILLS)
        slots["reactions"]["total"] = _slot_bucket(levels, pi_constants.REACTION_SKILLS)
        slots["science"]["total"] = _slot_bucket(levels, pi_constants.SCIENCE_SKILLS)

    async with AsyncSessionLocal() as session:
        active_jobs = (await session.execute(
            select(IndustryJob).where(
                IndustryJob.installer_id == cid,
                IndustryJob.status.in_(_SLOT_OCCUPYING_STATUSES),
            )
        )).scalars().all()
    for j in active_jobs:
        if j.activity_id == _MANUFACTURING_ACTIVITY:
            slots["manufacturing"]["in_use"] += 1
        elif j.activity_id == _REACTION_ACTIVITY:
            slots["reactions"]["in_use"] += 1
        elif j.activity_id in _SCIENCE_ACTIVITIES:
            slots["science"]["in_use"] += 1

    return {
        "wallet_balance": wallet,
        "system_name": system,
        "location_name": location_name,
        "ship_type_id": ship_type_id,
        "ship_name": ship_name,
        "implants": implants,
        "slots": slots,
        "missing_scopes": sorted(set(missing_scopes)),
    }


@router.get("/skills")
async def skills(char: Character = Depends(get_current_character)):
    async with AsyncSessionLocal() as session:
        token = await get_valid_token(char, session)
    cid = char.character_id

    missing_scopes = _missing(char, _SKILLQUEUE_SCOPES)
    if missing_scopes:
        return {"training": None, "missing_scopes": missing_scopes}

    queue = await esi.get(f"/characters/{cid}/skillqueue/", token=token)
    current = next((q for q in queue if q.get("start_date") and q.get("finish_date")), None)
    if not current:
        return {"training": None, "missing_scopes": []}

    name = type_names([current["skill_id"]]).get(current["skill_id"])

    now = datetime.now(timezone.utc)
    start = datetime.fromisoformat(current["start_date"].replace("Z", "+00:00"))
    finish = datetime.fromisoformat(current["finish_date"].replace("Z", "+00:00"))
    level_start_sp = current.get("level_start_sp", 0)
    level_end_sp = current.get("level_end_sp", 0)
    training_start_sp = current.get("training_start_sp", level_start_sp)

    total_duration = (finish - start).total_seconds()
    elapsed = max(0.0, min(total_duration, (now - start).total_seconds()))
    progress_pct = (elapsed / total_duration * 100) if total_duration > 0 else 100.0

    return {
        "training": {
            "skill_id": current["skill_id"],
            "skill_name": name,
            "finished_level": current.get("finished_level"),
            "start_date": current["start_date"],
            "finish_date": current["finish_date"],
            "level_start_sp": level_start_sp,
            "level_end_sp": level_end_sp,
            "training_start_sp": training_start_sp,
            "progress_pct": round(progress_pct, 1),
        },
        "queue_length": len(queue),
        "missing_scopes": [],
    }


@router.get("/planets")
async def planets(char: Character = Depends(get_current_character)):
    async with AsyncSessionLocal() as session:
        token = await get_valid_token(char, session)
    cid = char.character_id

    missing_scopes = _missing(char, _PLANETS_SCOPES)
    if missing_scopes:
        return {"planets": [], "missing_scopes": missing_scopes}

    planet_list = await esi.get(f"/characters/{cid}/planets/", token=token)

    result = []
    now = datetime.now(timezone.utc)
    for p in planet_list:
        pid = p["planet_id"]
        try:
            detail = await esi.get(f"/characters/{cid}/planets/{pid}/", token=token)
        except ESIError:
            continue

        pins = detail.get("pins", [])
        pin_type_ids = list({pin["type_id"] for pin in pins})
        groups = type_group_ids(pin_type_ids)

        # Soonest extractor expiry across this planet's extraction heads.
        expiry_times = [
            datetime.fromisoformat(pin["expiry_time"].replace("Z", "+00:00"))
            for pin in pins
            if pin.get("expiry_time")
        ]
        soonest_expiry = min(expiry_times) if expiry_times else None
        extractors_idle = soonest_expiry is not None and soonest_expiry <= now

        # Storage fill % across storage-capable pins (Command Center, Storage
        # Facility, Launchpad) — content volume vs. hardcoded capacity.
        content_type_ids = list({
            item["type_id"] for pin in pins for item in pin.get("contents", [])
        })
        volumes = type_volumes(content_type_ids)

        used_m3 = 0.0
        capacity_m3 = 0.0
        for pin in pins:
            group_id = groups.get(pin["type_id"])
            capacity = pi_constants.PI_STORAGE_CAPACITY_M3.get(group_id)
            if capacity is None:
                continue
            capacity_m3 += capacity
            for item in pin.get("contents", []):
                used_m3 += volumes.get(item["type_id"], 0.0) * item["amount"]

        storage_fill_pct = round(used_m3 / capacity_m3 * 100, 1) if capacity_m3 > 0 else None

        result.append({
            "planet_id": pid,
            "solar_system_id": p.get("solar_system_id"),
            "system_name": system_name(p.get("solar_system_id")),
            "planet_type": p.get("planet_type"),
            "upgrade_level": p.get("upgrade_level"),
            "num_pins": p.get("num_pins"),
            "last_update": p.get("last_update"),
            "extractor_expiry_at": soonest_expiry.isoformat() if soonest_expiry else None,
            "extractors_idle": extractors_idle,
            "storage_used_m3": round(used_m3, 1),
            "storage_capacity_m3": capacity_m3 or None,
            "storage_fill_pct": storage_fill_pct,
        })

    return {"planets": result, "missing_scopes": []}
