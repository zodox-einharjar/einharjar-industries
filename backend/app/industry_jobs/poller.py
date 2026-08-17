import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..industry.job_matching import relink_project_jobs, unlink_stale_project_jobs
from ..models import AppSetting, Character, IndustryJob

logger = logging.getLogger(__name__)

_CHAR_SCOPE = "esi-industry.read_character_jobs.v1"
_CORP_SCOPE = "esi-industry.read_corporation_jobs.v1"


async def _get_enabled_ids(key: str) -> list[int] | None:
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, key)
    if setting is None:
        return None
    return [int(x) for x in setting.value.split(",") if x.strip()]


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _to_decimal(v: float | None) -> Decimal | None:
    if v is None:
        return None
    return Decimal(str(v))


async def _upsert_jobs(session, character_id: int, jobs: list, source_tag: str) -> dict:
    now = datetime.now(timezone.utc)
    for j in jobs:
        stmt = pg_insert(IndustryJob).values(
            job_id=j["job_id"],
            character_id=character_id,
            source=source_tag,
            installer_id=j["installer_id"],
            activity_id=j["activity_id"],
            blueprint_id=j["blueprint_id"],
            blueprint_type_id=j["blueprint_type_id"],
            blueprint_location_id=j["blueprint_location_id"],
            output_location_id=j["output_location_id"],
            facility_id=j["facility_id"],
            runs=j["runs"],
            licensed_runs=j.get("licensed_runs"),
            cost=_to_decimal(j.get("cost")),
            probability=j.get("probability"),
            product_type_id=j.get("product_type_id"),
            successful_runs=j.get("successful_runs"),
            status=j["status"],
            duration=j["duration"],
            start_date=_parse_dt(j["start_date"]),
            end_date=_parse_dt(j["end_date"]),
            pause_date=_parse_dt(j.get("pause_date")),
            completed_date=_parse_dt(j.get("completed_date")),
            completed_character_id=j.get("completed_character_id"),
            last_synced=now,
        ).on_conflict_do_update(
            index_elements=["job_id"],
            set_={
                "status": j["status"],
                "pause_date": _parse_dt(j.get("pause_date")),
                "completed_date": _parse_dt(j.get("completed_date")),
                "completed_character_id": j.get("completed_character_id"),
                "successful_runs": j.get("successful_runs"),
                "last_synced": now,
            }
        )
        await session.execute(stmt)

    logger.info("Industry jobs [%s]: %d upserted", source_tag, len(jobs))
    return {"count": len(jobs)}


async def _poll_char_jobs(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            jobs = await esi.get(
                f"/characters/{char.character_id}/industry/jobs/",
                token=token,
                params={"include_completed": True},
            )
        except TokenExpiredError as e:
            logger.warning("Skipping char industry jobs for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning(
                "poll_industry_jobs: ESI %s for char %s", e.status, char.character_name,
            )
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling char industry jobs for %s", char.character_name)
            return {"count": 0}

        stats = await _upsert_jobs(session, char.id, jobs, source_tag="char")
        await session.commit()
        return stats


async def _poll_corp_jobs(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char or not char.corporation_id:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            jobs = await esi.fetch_all_pages(
                f"/corporations/{char.corporation_id}/industry/jobs/",
                token=token,
                params={"include_completed": True},
            )
        except TokenExpiredError as e:
            logger.warning("Skipping corp industry jobs for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning(
                "poll_industry_jobs: ESI %s for corp %s via %s — check Director/Factory Manager role if 403",
                e.status, char.corporation_id, char.character_name,
            )
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling corp industry jobs for %s", char.character_name)
            return {"count": 0}

        stats = await _upsert_jobs(session, char.id, jobs, source_tag="corp")
        await session.commit()
        return stats


async def poll_industry_jobs() -> dict:
    enabled_chars = await _get_enabled_ids("poll_char_industry_jobs")
    enabled_corps = await _get_enabled_ids("poll_corp_industry_jobs")

    async with AsyncSessionLocal() as session:
        all_chars = (await session.execute(select(Character))).scalars().all()

    totals = {"count": 0}

    # Track which corporation_ids we've already polled to avoid duplicate fetches
    # when multiple characters belong to the same corp.
    polled_corps: set[int] = set()

    for char in all_chars:
        scopes = char.scopes or []

        if enabled_chars is None:
            if _CHAR_SCOPE in scopes:
                stats = await _poll_char_jobs(char.id)
                totals["count"] += stats["count"]
        elif char.character_id in enabled_chars:
            stats = await _poll_char_jobs(char.id)
            totals["count"] += stats["count"]

        if not char.corporation_id or char.corporation_id in polled_corps:
            continue

        if enabled_corps is None:
            if _CORP_SCOPE in scopes:
                stats = await _poll_corp_jobs(char.id)
                totals["count"] += stats["count"]
                polled_corps.add(char.corporation_id)
        elif char.character_id in enabled_corps:
            stats = await _poll_corp_jobs(char.id)
            totals["count"] += stats["count"]
            polled_corps.add(char.corporation_id)

    async with AsyncSessionLocal() as session:
        await unlink_stale_project_jobs(session)
        await relink_project_jobs(session)

    return totals
