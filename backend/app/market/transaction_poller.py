import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import AppSetting, Character, InventoryLot, InventorySale, Location, MarketListing

logger = logging.getLogger(__name__)

_CHAR_SCOPE = "esi-wallet.read_character_wallet.v1"
_CORP_SCOPE = "esi-wallet.read_corporation_wallets.v1"
_CORP_DIVISION = 1  # Master wallet


async def _get_enabled_ids(key: str) -> list[int] | None:
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, key)
    if setting is None:
        return None
    return [int(x) for x in setting.value.split(",") if x.strip()]


def _char_watermark_key(character_id: int) -> str:
    return f"last_tx_id_{character_id}"


def _corp_watermark_key(corporation_id: int) -> str:
    return f"last_corp_tx_id_{corporation_id}_{_CORP_DIVISION}"


async def _process_transactions(
    session,
    txs: list,
    watermark: int | None,
    char_name: str,
) -> int | None:
    """
    Process sell transactions newer than watermark.
    Returns the new max transaction_id seen (None if no transactions).
    On first run (watermark is None), sets the watermark and processes nothing.
    """
    if not txs:
        return watermark

    max_tx_id = max(t["transaction_id"] for t in txs)

    if watermark is None:
        logger.info("Transaction watermark initialised for %s at %d", char_name, max_tx_id)
        return max_tx_id

    new_txs = [
        t for t in txs
        if t["transaction_id"] > watermark and not t.get("is_buy", True)
    ]
    new_txs.sort(key=lambda t: t["transaction_id"])

    processed = 0
    for tx in new_txs:
        tx_id = tx["transaction_id"]

        existing_sale = (await session.execute(
            select(InventorySale).where(InventorySale.esi_transaction_id == tx_id)
        )).scalar_one_or_none()
        if existing_sale:
            continue

        loc = (await session.execute(
            select(Location).where(Location.eve_id == tx["location_id"])
        )).scalar_one_or_none()
        if not loc:
            continue

        lots = (await session.execute(
            select(InventoryLot)
            .where(InventoryLot.type_id == tx["type_id"])
            .where(InventoryLot.location_id == loc.id)
            .where(InventoryLot.qty_remaining > 0)
            .order_by(InventoryLot.purchased_at)
        )).scalars().all()
        if not lots:
            continue

        sold_at = datetime.fromisoformat(tx["date"].replace("Z", "+00:00"))
        unit_price = Decimal(str(tx["unit_price"]))
        qty_remaining = tx["quantity"]
        first_sale = True

        for lot in lots:
            if qty_remaining <= 0:
                break
            take = min(qty_remaining, lot.qty_remaining)
            lot.qty_remaining -= take
            session.add(InventorySale(
                lot_id=lot.id,
                qty=take,
                unit_sell_price=unit_price,
                sold_at=sold_at,
                source="market",
                esi_transaction_id=tx_id if first_sale else None,
                character_name=char_name,
            ))
            first_sale = False
            qty_remaining -= take

        # Update matching active listing
        listing = (await session.execute(
            select(MarketListing)
            .where(MarketListing.type_id == tx["type_id"])
            .where(MarketListing.eve_location_id == tx["location_id"])
            .where(MarketListing.status == "active")
        )).scalar_one_or_none()
        if listing:
            qty_sold = tx["quantity"] - qty_remaining
            listing.qty_remaining = max(0, listing.qty_remaining - qty_sold)

        processed += 1

    if processed:
        logger.info("Processed %d new sell transactions for %s", processed, char_name)

    return max(max_tx_id, watermark)


async def _poll_char_wallet(char_id: int) -> None:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char:
            return

        wkey = _char_watermark_key(char.character_id)
        setting = await session.get(AppSetting, wkey)
        watermark = int(setting.value) if setting else None

        try:
            token = await get_valid_token(char, session)
            txs = await esi.fetch_all_pages(
                f"/characters/{char.character_id}/wallet/transactions/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping char wallet for %s: %s", char.character_name, e)
            return
        except ESIError as e:
            logger.error("ESI error polling char wallet for %s: %s", char.character_name, e)
            return
        except Exception:
            logger.exception("Unexpected error polling char wallet for %s", char.character_name)
            return

        new_watermark = await _process_transactions(session, txs, watermark, char.character_name)
        if new_watermark is not None:
            await session.merge(AppSetting(key=wkey, value=str(new_watermark)))
        await session.commit()


async def _poll_corp_wallet(char_id: int) -> None:
    async with AsyncSessionLocal() as session:
        char = await session.get(Character, char_id)
        if not char or not char.corporation_id:
            return

        corp_id = char.corporation_id
        wkey = _corp_watermark_key(corp_id)
        setting = await session.get(AppSetting, wkey)
        watermark = int(setting.value) if setting else None

        try:
            token = await get_valid_token(char, session)
            txs = await esi.fetch_all_pages(
                f"/corporations/{corp_id}/wallets/{_CORP_DIVISION}/transactions/",
                token=token,
            )
        except TokenExpiredError as e:
            logger.warning("Skipping corp wallet for %s: %s", char.character_name, e)
            return
        except ESIError as e:
            logger.error("ESI error polling corp wallet for %s: %s", char.character_name, e)
            return
        except Exception:
            logger.exception("Unexpected error polling corp wallet for %s", char.character_name)
            return

        label = f"{char.character_name} (corp)"
        new_watermark = await _process_transactions(session, txs, watermark, label)
        if new_watermark is not None:
            await session.merge(AppSetting(key=wkey, value=str(new_watermark)))
        await session.commit()


async def poll_wallet_transactions() -> None:
    enabled_chars = await _get_enabled_ids("poll_char_wallet")
    enabled_corps = await _get_enabled_ids("poll_corp_wallet")

    async with AsyncSessionLocal() as session:
        all_chars = (await session.execute(select(Character))).scalars().all()

    for char in all_chars:
        if enabled_chars is None:
            if _CHAR_SCOPE in (char.scopes or []):
                await _poll_char_wallet(char.id)
        elif char.character_id in enabled_chars:
            await _poll_char_wallet(char.id)

        if enabled_corps is None:
            if _CORP_SCOPE in (char.scopes or []) and char.corporation_id:
                await _poll_corp_wallet(char.id)
        elif char.character_id in enabled_corps:
            await _poll_corp_wallet(char.id)
