import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel as _Base
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..config import settings as app_settings
from ..db import AsyncSessionLocal
from ..models import AppSetting
from ..scheduler.jobs import reschedule_poll
from ..sde import get_sde
from scripts.update_sde import convert as _sde_convert

router = APIRouter(prefix="/settings", dependencies=[Depends(get_current_character)])

_POLL_KEYS = ("poll_char_orders", "poll_corp_orders", "poll_char_wallet", "poll_corp_wallet", "poll_corp_contracts")

_DEFAULTS: dict[str, str] = {
    "poll_interval_minutes": "5",
}


def _parse_id_list(value: str) -> list[int]:
    return [int(x) for x in value.split(",") if x.strip()]


def _fmt_id_list(ids: list[int]) -> str:
    return ",".join(str(i) for i in ids)


async def _load_settings() -> dict:
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(select(AppSetting))).scalars().all()
    result = dict(_DEFAULTS)
    for row in rows:
        result[row.key] = row.value
    out: dict = {}
    for k, v in result.items():
        if k in _POLL_KEYS:
            out[k] = _parse_id_list(v) if v else []
        elif k == "main_character_id":
            out[k] = int(v) if v else None
        elif v.lstrip("-").isdigit():
            out[k] = int(v)
        else:
            out[k] = v
    return out


async def _save(key: str, value: str) -> None:
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, key)
        if setting:
            setting.value = value
        else:
            session.add(AppSetting(key=key, value=value))
        await session.commit()


@router.get("")
async def get_settings():
    return await _load_settings()


class SettingsUpdate(_Base):
    poll_interval_minutes: int | None = None
    main_character_id: int | None = None
    poll_char_orders: list[int] | None = None
    poll_corp_orders: list[int] | None = None
    poll_char_wallet: list[int] | None = None
    poll_corp_wallet: list[int] | None = None
    poll_corp_contracts: list[int] | None = None


@router.patch("")
async def update_settings(body: SettingsUpdate):
    if body.poll_interval_minutes is not None:
        interval = max(1, min(60, body.poll_interval_minutes))
        await _save("poll_interval_minutes", str(interval))
        reschedule_poll(interval)

    if body.main_character_id is not None:
        await _save("main_character_id", str(body.main_character_id))

    for key, value in (
        ("poll_char_orders", body.poll_char_orders),
        ("poll_corp_orders", body.poll_corp_orders),
        ("poll_char_wallet", body.poll_char_wallet),
        ("poll_corp_wallet", body.poll_corp_wallet),
        ("poll_corp_contracts", body.poll_corp_contracts),
    ):
        if value is not None:
            await _save(key, _fmt_id_list(value))

    return await _load_settings()


_CCP_LATEST = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
_CCP_ZIP = "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-{build}-yaml.zip"


async def _fetch_ccp_build(client: httpx.AsyncClient) -> tuple[str, str]:
    """Returns (build_number, release_date_iso) from CCP's latest.jsonl."""
    resp = await client.get(_CCP_LATEST, timeout=10.0)
    resp.raise_for_status()
    for line in resp.text.strip().splitlines():
        try:
            obj = json.loads(line)
            if obj.get("_key") == "sde":
                return str(obj["buildNumber"]), str(obj.get("releaseDate", ""))
        except (json.JSONDecodeError, KeyError):
            continue
    raise ValueError("Could not parse build number from CCP latest.jsonl")


@router.get("/sde-status")
async def sde_status():
    sde_path = Path(app_settings.sde_path)
    async with AsyncSessionLocal() as session:
        installed_setting = await session.get(AppSetting, "sde_installed_at")
        remote_setting = await session.get(AppSetting, "sde_remote_modified")

    installed_at = None
    if installed_setting:
        installed_at = installed_setting.value
    elif sde_path.exists():
        mtime = sde_path.stat().st_mtime
        installed_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    return {
        "installed_at": installed_at,
        "remote_last_modified": remote_setting.value if remote_setting else None,
    }


@router.get("/sde-check")
async def sde_check():
    sde_path = Path(app_settings.sde_path)
    build_path = sde_path.with_name("sde_build.txt")
    stored_build = build_path.read_text().strip() if build_path.exists() else None

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            build, release_date = await _fetch_ccp_build(client)
    except Exception:
        return {"remote_last_modified": None, "update_available": None}

    update_available = stored_build != build or not sde_path.exists()
    return {
        "remote_last_modified": release_date,
        "update_available": update_available,
    }


@router.post("/update-sde")
async def update_sde():
    sde_path = Path(app_settings.sde_path)
    sde_path.parent.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(10.0, read=600.0),
    ) as client:
        try:
            build, release_date = await _fetch_ccp_build(client)
        except Exception as e:
            raise HTTPException(502, f"Could not reach CCP SDE endpoint: {e}")

        url = _CCP_ZIP.format(build=build)
        chunks: list[bytes] = []
        async with client.stream("GET", url) as resp:
            if not resp.is_success:
                raise HTTPException(502, f"CCP SDE returned {resp.status_code}")
            async for chunk in resp.aiter_bytes(65536):
                chunks.append(chunk)

    zip_data = b"".join(chunks)

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: _sde_convert(zip_data, sde_path))

    sde_path.with_name("sde_build.txt").write_text(build)
    get_sde.cache_clear()

    now = datetime.now(timezone.utc).isoformat()
    async with AsyncSessionLocal() as session:
        for key, value in (("sde_installed_at", now), ("sde_remote_modified", release_date)):
            setting = await session.get(AppSetting, key)
            if setting:
                setting.value = value
            else:
                session.add(AppSetting(key=key, value=value))
        await session.commit()

    return {"ok": True, "installed_at": now, "remote_last_modified": release_date}
