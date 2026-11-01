"""Settings support: an at-a-glance health check, and finding locations to add by name."""

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from ..auth.deps import get_current_character
from ..auth.tokens import TokenExpiredError, get_char_with_scope, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import (
    AppSetting, Character, Contract, IndustryJob, Location, MarketListing, MarketOrder, MercenaryDen,
)
from ..scheduler.jobs import get_scheduler
from ..sde import region_id_for_system, search_stations, system_name

router = APIRouter(prefix="/settings", dependencies=[Depends(get_current_character)])

_NPC_STATION_MAX = 1_000_000_000
_STRUCTURE_MARKETS = "esi-markets.structure_markets.v1"
_READ_STRUCTURES = "esi-universe.read_structures.v1"

# Poll toggles in Settings → the scope each one needs (corp ones also need a corp).
_POLL_SCOPES = {
    "poll_char_orders": ("Character orders", "esi-markets.read_character_orders.v1", False),
    "poll_corp_orders": ("Corp orders", "esi-markets.read_corporation_orders.v1", True),
    "poll_char_wallet": ("Character wallet", "esi-wallet.read_character_wallet.v1", False),
    "poll_corp_wallet": ("Corp wallet", "esi-wallet.read_corporation_wallets.v1", True),
    "poll_char_contracts": ("Character contracts", "esi-contracts.read_character_contracts.v1", False),
    "poll_corp_contracts": ("Corp contracts", "esi-contracts.read_corporation_contracts.v1", True),
    "poll_char_industry_jobs": ("Character industry jobs", "esi-industry.read_character_jobs.v1", False),
    "poll_corp_industry_jobs": ("Corp industry jobs", "esi-industry.read_corporation_jobs.v1", True),
}


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


@router.get("/health")
async def health():
    """Everything that can quietly stop working: market polling per location, the
    background syncs, and characters whose sign-in no longer covers what they're
    set to poll. Each problem comes with a plain-language issue for the summary."""
    now = datetime.now(timezone.utc)
    issues: list[dict] = []

    async with AsyncSessionLocal() as session:
        settings = {s.key: s.value for s in (await session.execute(select(AppSetting))).scalars()}
        chars = (await session.execute(select(Character).order_by(Character.character_name))).scalars().all()
        locs = (await session.execute(select(Location).order_by(Location.name))).scalars().all()
        fetched = {
            loc_id: (ts, n) for loc_id, ts, n in (await session.execute(
                select(MarketOrder.location_id, func.max(MarketOrder.fetched_at), func.count())
                .group_by(MarketOrder.location_id)
            )).all()
        }
        synced = {}
        for key, model in (("orders", MarketListing), ("contracts", Contract), ("industry_jobs", IndustryJob), ("mercenary", MercenaryDen)):
            synced[key] = (await session.execute(select(func.max(model.last_synced)))).scalar_one_or_none()

    interval = int(settings.get("poll_interval_minutes", "5") or 5)
    job = get_scheduler().get_job("poll_markets")
    stale_after = timedelta(minutes=interval * 2 + 5)
    has_structure_char = any(_STRUCTURE_MARKETS in (c.scopes or []) and c.refresh_token for c in chars)

    locations = []
    for loc in locs:
        ts, n = fetched.get(loc.id, (None, 0))
        problem = None
        if loc.location_type == "structure" and not has_structure_char:
            problem = "No signed-in character can read structure markets"
        elif ts is None:
            problem = "Never polled"
        elif now - ts > stale_after:
            problem = "Market data is out of date"
        locations.append({
            "id": loc.id, "name": loc.name, "type": loc.location_type,
            "last_fetched": _iso(ts), "orders": n, "problem": problem,
        })
        if problem:
            issues.append({"severity": "warn", "area": "markets", "text": f"{loc.name}: {problem.lower()}"})

    enabled = {k: [int(x) for x in settings.get(k, "").split(",") if x.strip()] for k in _POLL_SCOPES}
    char_out = []
    for c in chars:
        blocked = []
        for key, (label, scope, corp) in _POLL_SCOPES.items():
            if c.character_id not in enabled[key]:
                continue
            if not c.refresh_token:
                blocked.append(f"{label}: not signed in")
            elif scope not in (c.scopes or []):
                blocked.append(f"{label}: missing access")
            elif corp and not c.corporation_id:
                blocked.append(f"{label}: corporation unknown")
        char_out.append({
            "character_id": c.character_id, "name": c.character_name, "corp_name": c.corporation_name,
            "signed_in": bool(c.refresh_token),
            "polling": [label for key, (label, _, _) in _POLL_SCOPES.items() if c.character_id in enabled[key]],
            "blocked": blocked,
            "can_read_structures": _STRUCTURE_MARKETS in (c.scopes or []),
        })
        if blocked:
            issues.append({
                "severity": "danger", "area": "characters",
                "text": f"{c.character_name} is set to poll {', '.join(b.split(':')[0].lower() for b in blocked)} but can't: sign in again",
            })

    sync_labels = {"orders": "Your market orders", "contracts": "Contracts", "industry_jobs": "Industry jobs", "mercenary": "Mercenary dens"}
    syncs = []
    for key, ts in synced.items():
        stale = ts is not None and now - ts > timedelta(minutes=30)
        syncs.append({"key": key, "label": sync_labels[key], "last_synced": _iso(ts), "stale": stale})
        if stale:
            issues.append({"severity": "warn", "area": "syncs", "text": f"{sync_labels[key]} haven't synced in over 30 minutes"})

    return {
        "issues": issues,
        "markets": {
            "interval_minutes": interval,
            "next_poll": _iso(job.next_run_time) if job else None,
            "last_poll": _iso(max((ts for ts, _ in fetched.values()), default=None)),
            "locations": locations,
        },
        "syncs": syncs,
        "characters": char_out,
        "esi": {"error_budget_remaining": esi._error_remain},
    }


@router.get("/location-search")
async def location_search(q: str = ""):
    """NPC stations from the static data, matched by name."""
    q = q.strip()
    if len(q) < 2:
        return []
    async with AsyncSessionLocal() as session:
        existing = set((await session.execute(select(Location.eve_id))).scalars())
    return [
        {**s, "type": "station", "system_name": system_name(s["system_id"]), "added": s["eve_id"] in existing}
        for s in search_stations(q)
    ]


# Structure lookups that failed (usually no docking access → ESI 403). Remembered so
# they aren't retried: every ESI error counts against the error budget.
_structure_failures: dict[int, datetime] = {}


@router.get("/structure-candidates")
async def structure_candidates():
    """Player structures your own data has already referenced (contracts, industry
    jobs, market orders) that aren't added as locations yet, with names resolved via
    ESI. Only IDs we already hold are looked up — no searching or enumerating."""
    async with AsyncSessionLocal() as session:
        ids: set[int] = set()
        for col in (Contract.start_location_id, Contract.end_location_id, IndustryJob.facility_id,
                    IndustryJob.output_location_id, MarketListing.eve_location_id):
            ids |= {i for i in (await session.execute(select(col).distinct())).scalars() if i and i > _NPC_STATION_MAX}
        ids -= set((await session.execute(select(Location.eve_id))).scalars())
        char = await get_char_with_scope(session, _READ_STRUCTURES)
        token = None
        if char is not None:
            try:
                token = await get_valid_token(char, session)
            except TokenExpiredError:
                token = None

    out = []
    now = datetime.now(timezone.utc)
    for sid in sorted(ids):
        info = None
        failed_at = _structure_failures.get(sid)
        if token and not (failed_at and now - failed_at < timedelta(hours=12)):
            try:
                info = await esi.get(f"/universe/structures/{sid}/", token=token)
            except ESIError:
                _structure_failures[sid] = now
        system_id = info.get("solar_system_id") if info else None
        out.append({
            "eve_id": sid, "type": "structure",
            "name": info.get("name") if info else None,
            "system_id": system_id,
            "system_name": system_name(system_id) if system_id else None,
            "region_id": region_id_for_system(system_id) if system_id else None,
        })
    out.sort(key=lambda s: (s["name"] is None, s["name"] or ""))
    return {"can_resolve": token is not None, "structures": out}
