import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..discord import notifier
from ..esi.client import ESIError, esi
from ..models import Character, MercenaryDen, MercenaryNotification, MercenaryOperation
from ..sde import type_names

logger = logging.getLogger(__name__)

_DEN_SCOPE = "esi-structures.read_character.v1"
_MTO_SCOPE = "esi-activities.read_character.v1"
_NOTIFICATION_SCOPE = "esi-characters.read_notifications.v1"

_NOTIFICATION_TYPES = {"MercenaryDenAttacked", "MercenaryDenReinforced"}

_MTO_ACTIVE_STATES = ("Available", "Started")


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _level_num(level: str) -> int:
    try:
        return int(level.removeprefix("Level"))
    except ValueError:
        return 0


async def _poll_char_dens(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            listing = await esi.get(
                f"/characters/{char.character_id}/structures/mercenary-dens",
                token=token,
                compat=True,
            )
            dens = []
            for entry in listing["mercenary_dens"]:
                detail = await esi.get(
                    f"/characters/{char.character_id}/structures/mercenary-dens/{entry['id']}",
                    token=token,
                    compat=True,
                )
                dens.append({**entry, **detail})
        except TokenExpiredError as e:
            logger.warning("Skipping mercenary dens for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning("poll_mercenary: ESI %s for char %s (dens)", e.status, char.character_name)
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling mercenary dens for %s", char.character_name)
            return {"count": 0}

        now = datetime.now(timezone.utc)
        seen_ids = [d["id"] for d in dens]

        existing = (await session.execute(
            select(MercenaryDen).where(MercenaryDen.den_id.in_(seen_ids))
        )).scalars().all()
        old_levels_by_den_id = {
            row.den_id: (row.development_level, row.anarchy_level) for row in existing
        }

        level_up_messages: list[str] = []
        for d in dens:
            new_dev_level = d["evolution"]["development"]["level"]
            new_anarchy_level = d["evolution"]["anarchy"]["level"]
            old = old_levels_by_den_id.get(d["id"])
            if old:
                old_dev_level, old_anarchy_level = old
                if _level_num(new_dev_level) > _level_num(old_dev_level):
                    level_up_messages.append(
                        f"**Development level up** — {char.character_name}'s den on planet "
                        f"{d['planet_id']} reached {new_dev_level.replace('Level', 'L')}"
                    )
                if _level_num(new_anarchy_level) > _level_num(old_anarchy_level):
                    level_up_messages.append(
                        f"**Anarchy level up** — {char.character_name}'s den on planet "
                        f"{d['planet_id']} reached {new_anarchy_level.replace('Level', 'L')}"
                    )

        for d in dens:
            timer = d.get("reinforcement_timer")
            skyhook = d["skyhook"]
            stmt = pg_insert(MercenaryDen).values(
                den_id=d["id"],
                character_id=char.id,
                planet_id=d["planet_id"],
                type_id=d["type_id"],
                state=d["state"],
                development_level=d["evolution"]["development"]["level"],
                development_amount=d["evolution"]["development"]["amount"],
                anarchy_level=d["evolution"]["anarchy"]["level"],
                anarchy_amount=d["evolution"]["anarchy"]["amount"],
                infomorphs=d["infomorphs"]["amount"],
                reinforced_until=_parse_dt(timer["end"]) if timer else None,
                skyhook_id=skyhook["id"],
                skyhook_planet_id=skyhook["planet_id"],
                skyhook_corporation_id=skyhook["corporation_id"],
                last_synced=now,
            ).on_conflict_do_update(
                index_elements=["den_id"],
                set_={
                    "state": d["state"],
                    "development_level": d["evolution"]["development"]["level"],
                    "development_amount": d["evolution"]["development"]["amount"],
                    "anarchy_level": d["evolution"]["anarchy"]["level"],
                    "anarchy_amount": d["evolution"]["anarchy"]["amount"],
                    "infomorphs": d["infomorphs"]["amount"],
                    "reinforced_until": _parse_dt(timer["end"]) if timer else None,
                    "last_synced": now,
                },
            )
            await session.execute(stmt)

        await session.execute(
            delete(MercenaryDen).where(
                MercenaryDen.character_id == char.id,
                ~MercenaryDen.den_id.in_(seen_ids),
            )
        )
        await session.commit()
        logger.info("Mercenary dens: %d upserted for %s", len(dens), char.character_name)

        for msg in level_up_messages:
            await notifier.notify(msg)

        return {"count": len(dens)}


async def _poll_char_mtos(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            listing = await esi.get(
                f"/characters/{char.character_id}/mercenary-tactical-operations",
                token=token,
                compat=True,
            )
            operations = []
            for entry in listing["operations"]:
                detail = await esi.get(
                    f"/characters/{char.character_id}/mercenary-tactical-operations/{entry['id']}",
                    token=token,
                    compat=True,
                )
                operations.append(detail)
        except TokenExpiredError as e:
            logger.warning("Skipping mercenary operations for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning("poll_mercenary: ESI %s for char %s (MTOs)", e.status, char.character_name)
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling mercenary operations for %s", char.character_name)
            return {"count": 0}

        now = datetime.now(timezone.utc)

        existing_ops = (await session.execute(
            select(MercenaryOperation).where(
                MercenaryOperation.operation_id.in_([op["id"] for op in operations])
            )
        )).scalars().all()
        old_state_by_op_id = {row.operation_id: row.state for row in existing_ops}

        newly_active = [
            op for op in operations
            if op["state"] in _MTO_ACTIVE_STATES
            and old_state_by_op_id.get(op["id"]) not in _MTO_ACTIVE_STATES
        ]
        active_msg_context: dict = {}
        if newly_active:
            den_rows = (await session.execute(
                select(MercenaryDen.den_id, MercenaryDen.planet_id).where(
                    MercenaryDen.den_id.in_([op["mercenary_den_id"] for op in newly_active])
                )
            )).all()
            planet_by_den_id = {row.den_id: row.planet_id for row in den_rows}
            dungeon_names = type_names([op["dungeon_type_id"] for op in newly_active])
            active_msg_context = {"planets": planet_by_den_id, "dungeons": dungeon_names}

        for op in operations:
            stmt = pg_insert(MercenaryOperation).values(
                operation_id=op["id"],
                character_id=char.id,
                den_id=op["mercenary_den_id"],
                dungeon_type_id=op["dungeon_type_id"],
                state=op["state"],
                expires=_parse_dt(op["expires"]),
                first_seen_at=now,
                last_synced=now,
            ).on_conflict_do_update(
                index_elements=["operation_id"],
                set_={
                    "state": op["state"],
                    "expires": _parse_dt(op["expires"]),
                    "last_synced": now,
                },
            )
            await session.execute(stmt)

        # Deliberately not deleting operations that drop off the live listing —
        # their first_seen_at timestamps are the only signal available for
        # estimating the average gap between MTO spawns per den.
        await session.commit()
        logger.info("Mercenary operations: %d upserted for %s", len(operations), char.character_name)

        for op in newly_active:
            planet_id = active_msg_context["planets"].get(op["mercenary_den_id"])
            dungeon_name = active_msg_context["dungeons"].get(op["dungeon_type_id"]) or f"type {op['dungeon_type_id']}"
            where = f"planet {planet_id}" if planet_id else f"den {op['mercenary_den_id']}"
            await notifier.notify(
                f"**MTO active** — {char.character_name}'s den on {where}: {dungeon_name} ({op['state']})"
            )

        return {"count": len(operations)}


async def _poll_char_notifications(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return {"count": 0}
        try:
            token = await get_valid_token(char, session)
            notifications = await esi.get(
                f"/characters/{char.character_id}/notifications/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping notifications for %s: %s", char.character_name, e)
            return {"count": 0}
        except ESIError as e:
            logger.warning("poll_mercenary: ESI %s for char %s (notifications)", e.status, char.character_name)
            return {"count": 0}
        except Exception:
            logger.exception("Unexpected error polling notifications for %s", char.character_name)
            return {"count": 0}

        relevant = [n for n in notifications if n["type"] in _NOTIFICATION_TYPES]
        inserted = 0
        for n in relevant:
            logger.debug("Mercenary notification raw text for %s: %r", n["type"], n.get("text"))
            stmt = pg_insert(MercenaryNotification).values(
                notification_id=n["notification_id"],
                character_id=char.id,
                type=n["type"],
                timestamp=_parse_dt(n["timestamp"]),
            ).on_conflict_do_nothing(index_elements=["notification_id"])
            result = await session.execute(stmt)
            inserted += result.rowcount
        await session.commit()
        return {"count": inserted}


_ALERT_LABELS = {
    "MercenaryDenAttacked": "attacked",
    "MercenaryDenReinforced": "reinforced",
}


async def _notify_mercenary_events() -> None:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(MercenaryNotification).where(MercenaryNotification.discord_notified.is_(False))
        )
        pending = result.scalars().all()
        if not pending:
            return

        for note in pending:
            char = await session.get(Character, note.character_id)
            char_name = char.character_name if char else f"character:{note.character_id}"

            dens = (
                (await session.execute(
                    select(MercenaryDen).where(MercenaryDen.character_id == note.character_id)
                )).scalars().all()
            )
            label = _ALERT_LABELS.get(note.type, note.type)
            if len(dens) == 1:
                message = f"**Mercenary den {label}** — {char_name}'s den on planet {dens[0].planet_id}"
            else:
                message = f"**Mercenary den {label}** — one of {char_name}'s dens (check the dashboard for which one)"

            await notifier.notify(message)
            note.discord_notified = True

        await session.commit()


async def poll_mercenary() -> dict:
    async with AsyncSessionLocal() as session:
        all_chars = (await session.execute(select(Character))).scalars().all()

    totals = {"count": 0}
    for char in all_chars:
        scopes = char.scopes or []
        if _DEN_SCOPE in scopes:
            stats = await _poll_char_dens(char.id)
            totals["count"] += stats["count"]
        if _MTO_SCOPE in scopes:
            stats = await _poll_char_mtos(char.id)
            totals["count"] += stats["count"]
        if _NOTIFICATION_SCOPE in scopes:
            await _poll_char_notifications(char.id)

    await _notify_mercenary_events()

    return totals
