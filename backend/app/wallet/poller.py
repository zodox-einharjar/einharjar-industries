"""Wallet balances for the dashboard: which wallets count, polling their balance, and
a one-off backfill of recent history from each wallet's journal."""

import json
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from ..auth.tokens import TokenExpiredError, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import AppSetting, Character, WalletSnapshot

logger = logging.getLogger(__name__)

CHAR_SCOPE = "esi-wallet.read_character_wallet.v1"
CORP_SCOPE = "esi-wallet.read_corporation_wallets.v1"
SOURCES_KEY = "wallet_sources"

# A source that failed (no role, revoked token, ...) is left alone for a while, so a
# misconfigured wallet doesn't burn ESI's error budget on every poll.
_RETRY_AFTER = timedelta(hours=6)
_failed: dict[str, tuple[datetime, str]] = {}


def char_source(character_id: int) -> str:
    return f"char:{character_id}"


def corp_source(corporation_id: int, division: int) -> str:
    return f"corp:{corporation_id}:{division}"


async def load_sources() -> dict:
    """{"characters": [character_id, ...], "corps": {corporation_id: [division, ...]}}"""
    async with AsyncSessionLocal() as session:
        row = await session.get(AppSetting, SOURCES_KEY)
    if row is None:
        return {"characters": [], "corps": {}}
    data = json.loads(row.value)
    return {
        "characters": [int(c) for c in data.get("characters", [])],
        "corps": {int(k): sorted({int(d) for d in v if 1 <= int(d) <= 7}) for k, v in data.get("corps", {}).items()},
    }


async def save_sources(characters: list[int], corps: dict[int, list[int]]) -> None:
    value = json.dumps({"characters": sorted(set(characters)), "corps": {str(k): sorted(set(v)) for k, v in corps.items() if v}})
    async with AsyncSessionLocal() as session:
        stmt = insert(AppSetting).values(key=SOURCES_KEY, value=value)
        await session.execute(stmt.on_conflict_do_update(index_elements=["key"], set_={"value": value}))
        await session.commit()


def failure(source: str) -> str | None:
    hit = _failed.get(source)
    return hit[1] if hit and datetime.now(timezone.utc) - hit[0] < _RETRY_AFTER else None


def _fail(source: str, reason: str) -> None:
    _failed[source] = (datetime.now(timezone.utc), reason)
    logger.warning("Wallet %s: %s", source, reason)


async def _store(session, rows: list[tuple[str, datetime, float]]) -> None:
    if not rows:
        return
    stmt = insert(WalletSnapshot).values([{"source": s, "ts": t, "balance": Decimal(str(b))} for s, t, b in rows])
    await session.execute(stmt.on_conflict_do_nothing(index_elements=["source", "ts"]))


async def _backfill(session, source: str, path: str, token: str) -> None:
    """First time a wallet is seen, fill ~30 days of history from its journal."""
    has_history = (await session.execute(
        select(func.count()).select_from(WalletSnapshot).where(WalletSnapshot.source == source)
    )).scalar_one()
    if has_history:
        return
    try:
        entries = await esi.fetch_all_pages(path, token=token)
    except ESIError as e:
        logger.info("Wallet %s: no journal history (%s)", source, e)
        return
    await _store(session, [
        (source, datetime.fromisoformat(e["date"].replace("Z", "+00:00")), e["balance"])
        for e in entries if e.get("balance") is not None
    ])


def _corp_char(chars: list[Character], corporation_id: int) -> Character | None:
    for c in chars:
        if c.corporation_id == corporation_id and CORP_SCOPE in (c.scopes or []) and c.refresh_token:
            return c
    return None


async def poll_wallets() -> None:
    sources = await load_sources()
    if not sources["characters"] and not sources["corps"]:
        return
    now = datetime.now(timezone.utc).replace(microsecond=0)

    async with AsyncSessionLocal() as session:
        chars = (await session.execute(select(Character).order_by(Character.id))).scalars().all()
        by_id = {c.character_id: c for c in chars}

        for cid in sources["characters"]:
            src = char_source(cid)
            char = by_id.get(cid)
            if failure(src):
                continue
            if char is None or not char.refresh_token or CHAR_SCOPE not in (char.scopes or []):
                _fail(src, "character not signed in with wallet access")
                continue
            try:
                token = await get_valid_token(char, session)
                balance = await esi.get(f"/characters/{cid}/wallet/", token=token)
                await _backfill(session, src, f"/characters/{cid}/wallet/journal/", token)
                await _store(session, [(src, now, float(balance))])
                _failed.pop(src, None)
            except (TokenExpiredError, ESIError) as e:
                _fail(src, str(e))

        for corp_id, divisions in sources["corps"].items():
            srcs = [corp_source(corp_id, d) for d in divisions]
            if all(failure(s) for s in srcs):
                continue
            char = _corp_char(chars, corp_id)
            if char is None:
                for s in srcs:
                    _fail(s, "no character in this corporation signed in with corp wallet access")
                continue
            try:
                token = await get_valid_token(char, session)
                wallets = await esi.get(f"/corporations/{corp_id}/wallets/", token=token)
            except (TokenExpiredError, ESIError) as e:
                for s in srcs:
                    _fail(s, f"{e} (needs the Accountant or Junior Accountant role in game)")
                continue
            balances = {w["division"]: w["balance"] for w in wallets}
            for d in divisions:
                src = corp_source(corp_id, d)
                if d not in balances:
                    continue
                await _backfill(session, src, f"/corporations/{corp_id}/wallets/{d}/journal/", token)
                await _store(session, [(src, now, float(balances[d]))])
                _failed.pop(src, None)

        await session.commit()
