import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import AppSetting, Character, Contract

logger = logging.getLogger(__name__)

_CHAR_SCOPE = "esi-contracts.read_character_contracts.v1"
_CORP_SCOPE = "esi-contracts.read_corporation_contracts.v1"


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


def _nonzero(v: int | None) -> int | None:
    return None if (v is None or v == 0) else v


async def _upsert_contracts(session, character_id: int, contracts: list, source_tag: str) -> dict:
    now = datetime.now(timezone.utc)
    for c in contracts:
        stmt = pg_insert(Contract).values(
            contract_id=c["contract_id"],
            character_id=character_id,
            source=source_tag,
            issuer_id=c["issuer_id"],
            issuer_corporation_id=c["issuer_corporation_id"],
            assignee_id=_nonzero(c.get("assignee_id")),
            acceptor_id=_nonzero(c.get("acceptor_id")),
            type=c["type"],
            status=c["status"],
            title=c.get("title") or None,
            for_corporation=c.get("for_corporation", False),
            availability=c.get("availability", "public"),
            date_issued=_parse_dt(c["date_issued"]),
            date_expired=_parse_dt(c["date_expired"]),
            date_accepted=_parse_dt(c.get("date_accepted")),
            date_completed=_parse_dt(c.get("date_completed")),
            days_to_complete=c.get("days_to_complete"),
            price=_to_decimal(c.get("price")),
            reward=_to_decimal(c.get("reward")),
            collateral=_to_decimal(c.get("collateral")),
            buyout=_to_decimal(c.get("buyout")),
            volume=c.get("volume"),
            start_location_id=c.get("start_location_id"),
            end_location_id=c.get("end_location_id"),
            last_synced=now,
        ).on_conflict_do_update(
            index_elements=["contract_id"],
            set_={
                "status": c["status"],
                "acceptor_id": _nonzero(c.get("acceptor_id")),
                "date_accepted": _parse_dt(c.get("date_accepted")),
                "date_completed": _parse_dt(c.get("date_completed")),
                "last_synced": now,
            }
        )
        await session.execute(stmt)

    logger.info("Contracts [%s]: %d upserted", source_tag, len(contracts))
    return {"count": len(contracts)}


async def _poll_corp_contracts(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char or not char.corporation_id:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            contracts = await esi.fetch_all_pages(
                f"/corporations/{char.corporation_id}/contracts/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping corp contracts for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning(
                "poll_contracts: ESI %s for corp %s via %s — check Director role if 403",
                e.status, char.corporation_id, char.character_name,
            )
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling corp contracts for %s", char.character_name)
            return {"count": 0}

        corp_id = char.corporation_id
        relevant = [
            c for c in contracts
            if c.get("issuer_corporation_id") == corp_id
            or c.get("assignee_id") == corp_id
        ]
        stats = await _upsert_contracts(session, char.id, relevant, source_tag="corp")
        await session.commit()
        return stats


async def _poll_char_contracts(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            contracts = await esi.fetch_all_pages(
                f"/characters/{char.character_id}/contracts/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping char contracts for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning(
                "poll_contracts: ESI %s for char %s", e.status, char.character_name,
            )
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling char contracts for %s", char.character_name)
            return {"count": 0}

        stats = await _upsert_contracts(session, char.id, contracts, source_tag="char")
        await session.commit()
        return stats


async def poll_contracts() -> dict:
    enabled_chars = await _get_enabled_ids("poll_char_contracts")
    enabled_corps = await _get_enabled_ids("poll_corp_contracts")

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
                stats = await _poll_char_contracts(char.id)
                totals["count"] += stats["count"]
        elif char.character_id in enabled_chars:
            stats = await _poll_char_contracts(char.id)
            totals["count"] += stats["count"]

        if not char.corporation_id or char.corporation_id in polled_corps:
            continue

        if enabled_corps is None:
            if _CORP_SCOPE in scopes:
                stats = await _poll_corp_contracts(char.id)
                totals["count"] += stats["count"]
                polled_corps.add(char.corporation_id)
        elif char.character_id in enabled_corps:
            stats = await _poll_corp_contracts(char.id)
            totals["count"] += stats["count"]
            polled_corps.add(char.corporation_id)

    return totals
