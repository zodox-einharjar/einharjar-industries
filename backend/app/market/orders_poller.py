import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import AppSetting, Character, MarketListing

logger = logging.getLogger(__name__)

_CHAR_SCOPE = "esi-markets.read_character_orders.v1"
_CORP_SCOPE = "esi-markets.read_corporation_orders.v1"


async def _get_enabled_ids(key: str) -> list[int] | None:
    """Return list of character_ids from setting, or None if not configured (→ use all with scope)."""
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, key)
    if setting is None:
        return None
    return [int(x) for x in setting.value.split(",") if x.strip()]


_ZERO = {"found": 0, "new": 0, "expired": 0}


async def _poll_char_orders(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return _ZERO
        try:
            token = await get_valid_token(char, session)
            orders = await esi.fetch_all_pages(
                f"/characters/{char.character_id}/orders/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping char orders for %s: %s", char.character_name, e)
            return _ZERO
        except ESIError as e:
            logger.error("ESI error polling char orders for %s: %s", char.character_name, e)
            return _ZERO
        except Exception:
            logger.exception("Unexpected error polling char orders for %s", char.character_name)
            return _ZERO

        try:
            if esi.last_page_expires is not None:
                setting = await session.get(AppSetting, "orders_esi_expires")
                if setting:
                    setting.value = esi.last_page_expires.isoformat()
                else:
                    session.add(AppSetting(key="orders_esi_expires", value=esi.last_page_expires.isoformat()))
        except Exception:
            logger.exception("Failed to save orders_esi_expires setting")

        stats = await _upsert_listings(session, char.id, orders, source_tag=f"char:{char.character_name}")
        await session.commit()
        return stats


async def _poll_corp_orders(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char or not char.corporation_id:
            return _ZERO
        try:
            token = await get_valid_token(char, session)
            orders = await esi.fetch_all_pages(
                f"/corporations/{char.corporation_id}/orders/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping corp orders for %s: %s", char.character_name, e)
            return _ZERO
        except ESIError as e:
            logger.warning(
                "poll_orders: ESI %s for corp %s via %s — check Accountant/Trader role if 403",
                e.status, char.corporation_id, char.character_name,
            )
            return _ZERO
        except Exception:
            logger.exception("Unexpected error polling corp orders for %s", char.character_name)
            return _ZERO

        stats = await _upsert_listings(session, char.id, orders, source_tag=f"corp:{char.corporation_name}")
        await session.commit()
        return stats


async def _upsert_listings(session, character_id: int, orders: list, source_tag: str) -> dict:
    sell_orders = [o for o in orders if not o.get("is_buy_order", False)]
    esi_order_ids = {o["order_id"] for o in sell_orders}

    existing = (await session.execute(
        select(MarketListing)
        .where(MarketListing.character_id == character_id)
        .where(MarketListing.status == "active")
    )).scalars().all()
    existing_by_id = {ml.order_id: ml for ml in existing}

    now = datetime.now(timezone.utc)
    new_count = 0

    for order in sell_orders:
        oid = order["order_id"]
        issued = datetime.fromisoformat(order["issued"].replace("Z", "+00:00"))
        expires = issued + timedelta(days=order.get("duration", 90))

        if oid in existing_by_id:
            ml = existing_by_id[oid]
            ml.qty_remaining = order["volume_remain"]
            ml.list_price = Decimal(str(order["price"]))
            ml.last_synced = now
        else:
            new_count += 1
            stmt = pg_insert(MarketListing).values(
                order_id=oid,
                character_id=character_id,
                type_id=order["type_id"],
                eve_location_id=order["location_id"],
                qty_total=order["volume_total"],
                qty_remaining=order["volume_remain"],
                list_price=Decimal(str(order["price"])),
                issued=issued,
                expires=expires,
                status="active",
                last_synced=now,
            ).on_conflict_do_update(
                index_elements=["order_id"],
                set_={
                    "qty_remaining": order["volume_remain"],
                    "list_price": Decimal(str(order["price"])),
                    "last_synced": now,
                    "status": "active",
                }
            )
            await session.execute(stmt)

    expired_count = 0
    for oid, ml in existing_by_id.items():
        if oid not in esi_order_ids:
            ml.status = "expired"
            expired_count += 1

    logger.info(
        "Orders [%s]: %d active, %d new, %d expired",
        source_tag, len(sell_orders), new_count, expired_count,
    )
    return {"found": len(sell_orders), "new": new_count, "expired": expired_count}


async def poll_character_orders() -> dict:
    enabled_chars = await _get_enabled_ids("poll_char_orders")
    enabled_corps = await _get_enabled_ids("poll_corp_orders")

    async with AsyncSessionLocal() as session:
        all_chars = (await session.execute(select(Character))).scalars().all()

    totals = {"found": 0, "new": 0, "expired": 0}

    def _add(s: dict) -> None:
        for k in totals:
            totals[k] += s.get(k, 0)

    for char in all_chars:
        scopes = char.scopes or []
        has_char_scope = _CHAR_SCOPE in scopes
        has_corp_scope = _CORP_SCOPE in scopes

        if enabled_chars is None:
            if has_char_scope:
                _add(await _poll_char_orders(char.id))
        elif char.character_id in enabled_chars:
            _add(await _poll_char_orders(char.id))

        if enabled_corps is None:
            if has_corp_scope and char.corporation_id:
                _add(await _poll_corp_orders(char.id))
        elif char.character_id in enabled_corps:
            _add(await _poll_corp_orders(char.id))

    return totals
