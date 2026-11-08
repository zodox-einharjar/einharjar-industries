import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import AppSetting, Character, Location, MarketListing
from .listing_fees import charge_lots, relist_discount, reprice_fee, tracking_start, upfront_rate

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


_FAILED = {"found": 0, "new": 0, "seen": None}


async def _poll_char_orders(char_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return _FAILED
        try:
            token = await get_valid_token(char, session)
            orders = await esi.fetch_all_pages(
                f"/characters/{char.character_id}/orders/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping char orders for %s: %s", char.character_name, e)
            return _FAILED
        except ESIError as e:
            logger.error("ESI error polling char orders for %s: %s", char.character_name, e)
            return _FAILED
        except Exception:
            logger.exception("Unexpected error polling char orders for %s", char.character_name)
            return _FAILED

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
            return _FAILED
        try:
            token = await get_valid_token(char, session)
            orders = await esi.fetch_all_pages(
                f"/corporations/{char.corporation_id}/orders/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping corp orders for %s: %s", char.character_name, e)
            return _FAILED
        except ESIError as e:
            logger.warning(
                "poll_orders: ESI %s for corp %s via %s — check Accountant/Trader role if 403",
                e.status, char.corporation_id, char.character_name,
            )
            return _FAILED
        except Exception:
            logger.exception("Unexpected error polling corp orders for %s", char.character_name)
            return _FAILED

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

    locations: dict[int, Location | None] = {}
    discount = None

    for order in sell_orders:
        oid = order["order_id"]
        issued = datetime.fromisoformat(order["issued"].replace("Z", "+00:00"))
        expires = issued + timedelta(days=order.get("duration", 90))

        if oid in existing_by_id:
            ml = existing_by_id[oid]
            new_price = Decimal(str(order["price"]))
            # A price change resets `issued`. Requiring a newer one ignores an older cached
            # response from the other endpoint (character vs corporation orders).
            if new_price != ml.list_price and issued > ml.issued:
                eve_loc = order["location_id"]
                if eve_loc not in locations:
                    locations[eve_loc] = (await session.execute(
                        select(Location).where(Location.eve_id == eve_loc)
                    )).scalar_one_or_none()
                loc = locations[eve_loc]
                if loc:
                    if discount is None:
                        discount = await relist_discount(session)
                    await charge_lots(
                        session, order_id=oid, kind="reprice", order_issued=issued,
                        type_id=order["type_id"], location_id=loc.id, qty=order["volume_remain"],
                        amount=reprice_fee(float(ml.list_price), float(new_price), order["volume_remain"], upfront_rate(loc), discount),
                    )
            if issued > ml.issued:
                ml.issued = issued
                ml.expires = expires
            ml.qty_remaining = order["volume_remain"]
            ml.list_price = new_price
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

    logger.info("Orders [%s]: %d active, %d new", source_tag, len(sell_orders), new_count)
    return {"found": len(sell_orders), "new": new_count, "seen": esi_order_ids}


async def _poll_targets() -> list[tuple[Character, bool, bool]]:
    """Each character with whether to poll its personal and its corporation's orders."""
    enabled_chars = await _get_enabled_ids("poll_char_orders")
    enabled_corps = await _get_enabled_ids("poll_corp_orders")

    async with AsyncSessionLocal() as session:
        all_chars = (await session.execute(select(Character))).scalars().all()

    targets = []
    for char in all_chars:
        scopes = char.scopes or []
        do_char = _CHAR_SCOPE in scopes if enabled_chars is None else char.character_id in enabled_chars
        do_corp = (
            _CORP_SCOPE in scopes and bool(char.corporation_id)
            if enabled_corps is None else char.character_id in enabled_corps
        )
        if do_char or do_corp:
            targets.append((char, do_char, do_corp))
    return targets


async def poll_character_orders() -> dict:
    totals = {"found": 0, "new": 0, "expired": 0}
    seen: set[int] = set()
    complete: set[int] = set()  # characters whose every poll succeeded

    for char, do_char, do_corp in await _poll_targets():
        results = []
        if do_char:
            results.append(await _poll_char_orders(char.id))
        if do_corp:
            results.append(await _poll_corp_orders(char.id))
        for r in results:
            totals["found"] += r["found"]
            totals["new"] += r["new"]
            seen |= r["seen"] or set()
        if all(r["seen"] is not None for r in results):
            complete.add(char.id)

    # An order is gone only if neither endpoint returned it. Deciding per endpoint would
    # mark personal orders expired whenever the corporation poll ran, and vice versa.
    if complete:
        async with AsyncSessionLocal() as session:
            gone = (await session.execute(
                select(MarketListing)
                .where(MarketListing.status == "active")
                .where(MarketListing.character_id.in_(complete))
                .where(MarketListing.order_id.notin_(seen or {-1}))
            )).scalars().all()
            for ml in gone:
                ml.status = "expired"
            totals["expired"] = len(gone)
            await session.commit()

    return totals


async def _apply_order_history(session, orders: list, start: datetime) -> int:
    """Charge unsold units' upfront fees for orders that ended. Fully sold orders also
    appear in the history, with nothing remaining."""
    closed = [o for o in orders if not o.get("is_buy_order", False) and o.get("state") in ("expired", "cancelled")]
    if not closed:
        return 0

    listings = {ml.order_id: ml for ml in (await session.execute(
        select(MarketListing)
        .where(MarketListing.order_id.in_([o["order_id"] for o in closed]))
        .where(MarketListing.last_synced >= start)
    )).scalars().all()}
    locs = {l.eve_id: l for l in (await session.execute(select(Location))).scalars().all()}

    charged = 0
    for order in closed:
        ml = listings.get(order["order_id"])
        if ml is None:
            continue
        unsold = order["volume_remain"]
        ml.qty_remaining = unsold
        ml.status = order["state"]
        loc = locs.get(order["location_id"])
        if unsold <= 0 or loc is None:
            continue
        issued = datetime.fromisoformat(order["issued"].replace("Z", "+00:00"))
        if await charge_lots(
            session, order_id=order["order_id"], kind="unsold", order_issued=issued,
            type_id=order["type_id"], location_id=loc.id, qty=unsold,
            amount=unsold * float(order["price"]) * upfront_rate(loc),
        ):
            charged += 1
    return charged


async def _poll_history(char_id: int, path_for, label: str) -> None:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return
        try:
            token = await get_valid_token(char, session)
            orders = await esi.fetch_all_pages(path_for(char), token=token)
        except TokenExpiredError as e:
            logger.warning("Skipping %s order history for %s: %s", label, char.character_name, e)
            return
        except ESIError as e:
            logger.warning("ESI %s reading %s order history for %s", e.status, label, char.character_name)
            return
        start = await tracking_start(session)
        charged = await _apply_order_history(session, orders, start)
        await session.commit()
        if charged:
            logger.info("Order history [%s:%s]: charged unsold fees on %d orders", label, char.character_name, charged)


async def poll_order_history() -> None:
    """ESI caches order history for an hour, so this runs hourly."""
    for char, do_char, do_corp in await _poll_targets():
        if do_char:
            await _poll_history(char.id, lambda c: f"/characters/{c.character_id}/orders/history/", "char")
        if do_corp:
            await _poll_history(char.id, lambda c: f"/corporations/{c.corporation_id}/orders/history/", "corp")
