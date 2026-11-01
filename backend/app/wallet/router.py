import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..models import Character, WalletSnapshot
from .poller import (
    CHAR_SCOPE, CORP_SCOPE, char_source, corp_source, failure, load_sources, poll_wallets, save_sources,
)

router = APIRouter(prefix="/wallet", dependencies=[Depends(get_current_character)])
_background: set[asyncio.Task] = set()


def _division_label(d: int) -> str:
    return "Division 1 (master wallet)" if d == 1 else f"Division {d}"


@router.get("/sources")
async def sources():
    """Which wallets count toward the dashboard total, and which could."""
    selected = await load_sources()
    async with AsyncSessionLocal() as session:
        chars = (await session.execute(select(Character).order_by(Character.character_name))).scalars().all()

    corps: dict[int, dict] = {}
    for c in chars:
        if c.corporation_id:
            corp = corps.setdefault(c.corporation_id, {
                "corporation_id": c.corporation_id, "name": c.corporation_name or f"Corporation {c.corporation_id}",
                "access_via": None,
            })
            if corp["access_via"] is None and CORP_SCOPE in (c.scopes or []) and c.refresh_token:
                corp["access_via"] = c.character_name

    return {
        "characters": [
            {
                "character_id": c.character_id, "name": c.character_name,
                "has_access": CHAR_SCOPE in (c.scopes or []) and bool(c.refresh_token),
                "selected": c.character_id in selected["characters"],
                "error": failure(char_source(c.character_id)),
            }
            for c in chars
        ],
        "corporations": [
            {
                **corp,
                "divisions": [
                    {
                        "division": d, "label": _division_label(d),
                        "selected": d in selected["corps"].get(cid, []),
                        "error": failure(corp_source(cid, d)),
                    }
                    for d in range(1, 8)
                ],
            }
            for cid, corp in sorted(corps.items(), key=lambda kv: kv[1]["name"])
            # Only corps we hold ESI access for — plus any already chosen, so a corp
            # that lost access still shows (with its error) and can be unticked.
            if corp["access_via"] or selected["corps"].get(cid)
        ],
    }


class SourcesUpdate(BaseModel):
    characters: list[int] = []
    corps: dict[int, list[int]] = {}


@router.put("/sources")
async def update_sources(body: SourcesUpdate):
    await save_sources(body.characters, body.corps)
    # Fetch balances (and history for newly added wallets) right away rather than
    # waiting for the next scheduled poll.
    task = asyncio.create_task(poll_wallets())
    _background.add(task)
    task.add_done_callback(_background.discard)
    return await sources()


@router.get("/summary")
async def summary(days: int = 30):
    """Current total across the selected wallets, each wallet's balance, and the total
    over time (hourly) for the dashboard chart."""
    days = max(1, min(days, 90))
    selected = await load_sources()
    keys = [char_source(c) for c in selected["characters"]] + [
        corp_source(corp, d) for corp, divs in selected["corps"].items() for d in divs
    ]
    if not keys:
        return {"configured": False, "total": None, "wallets": [], "series": []}

    since = datetime.now(timezone.utc) - timedelta(days=days)
    async with AsyncSessionLocal() as session:
        chars = {c.character_id: c for c in (await session.execute(select(Character))).scalars()}
        rows = (await session.execute(
            select(WalletSnapshot.source, WalletSnapshot.ts, WalletSnapshot.balance)
            .where(WalletSnapshot.source.in_(keys), WalletSnapshot.ts >= since)
            .order_by(WalletSnapshot.ts)
        )).all()
        # The last balance before the window, so each line starts at the right level.
        before = {
            src: float(bal) for src, bal in (await session.execute(
                select(WalletSnapshot.source, WalletSnapshot.balance)
                .distinct(WalletSnapshot.source)
                .where(WalletSnapshot.source.in_(keys), WalletSnapshot.ts < since)
                .order_by(WalletSnapshot.source, WalletSnapshot.ts.desc())
            )).all()
        }

    corp_names = {c.corporation_id: c.corporation_name for c in chars.values() if c.corporation_id}

    def label(src: str) -> str:
        parts = src.split(":")
        if parts[0] == "char":
            c = chars.get(int(parts[1]))
            return c.character_name if c else f"Character {parts[1]}"
        return f"{corp_names.get(int(parts[1])) or 'Corporation'}, {_division_label(int(parts[2])).lower()}"

    latest: dict[str, float] = dict(before)
    first_seen: dict[str, float] = {}
    for src, _, bal in rows:
        first_seen.setdefault(src, float(bal))

    # Hourly series: each wallet carries its last known balance forward; before a
    # wallet's first data point it's assumed flat at that first value.
    series = []
    current = {k: latest.get(k, first_seen.get(k)) for k in keys}
    i = 0
    hour = since.replace(minute=0, second=0, microsecond=0)
    end = datetime.now(timezone.utc)
    while hour <= end:
        bucket_end = hour + timedelta(hours=1)
        while i < len(rows) and rows[i][1] < bucket_end:
            current[rows[i][0]] = float(rows[i][2])
            i += 1
        known = [v for v in current.values() if v is not None]
        if known:
            series.append({"t": bucket_end.isoformat(), "total": round(sum(known), 2)})
        hour = bucket_end

    wallets = [
        {"source": k, "label": label(k), "balance": current.get(k), "error": failure(k)}
        for k in keys
    ]
    total = sum(w["balance"] for w in wallets if w["balance"] is not None)
    return {
        "configured": True,
        "total": total,
        "change": total - series[0]["total"] if series else None,
        "wallets": sorted(wallets, key=lambda w: -(w["balance"] or 0)),
        "series": series,
    }
