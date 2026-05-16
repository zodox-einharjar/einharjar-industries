import asyncio
import bz2
import os
import tempfile
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


_FUZZWORK_BZ2 = "https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2"


@router.get("/sde-status")
async def sde_status():
    async with AsyncSessionLocal() as session:
        installed_setting = await session.get(AppSetting, "sde_installed_at")
        remote_setting = await session.get(AppSetting, "sde_remote_modified")

    installed_at = None
    if installed_setting:
        installed_at = installed_setting.value
    else:
        sde_path = Path(app_settings.sde_path)
        if sde_path.exists():
            mtime = sde_path.stat().st_mtime
            installed_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    return {
        "installed_at": installed_at,
        "remote_last_modified": remote_setting.value if remote_setting else None,
    }


@router.get("/sde-check")
async def sde_check():
    async with AsyncSessionLocal() as session:
        remote_setting = await session.get(AppSetting, "sde_remote_modified")
    stored_remote = remote_setting.value if remote_setting else None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.head(_FUZZWORK_BZ2)
        remote_last_modified = resp.headers.get("Last-Modified")
    except Exception:
        return {"remote_last_modified": None, "update_available": None}

    if not remote_last_modified:
        return {"remote_last_modified": None, "update_available": None}

    update_available = stored_remote is None or remote_last_modified != stored_remote
    return {
        "remote_last_modified": remote_last_modified,
        "update_available": update_available,
    }


@router.post("/update-sde")
async def update_sde():
    sde_path = Path(app_settings.sde_path)
    sde_dir = sde_path.parent
    sde_dir.mkdir(parents=True, exist_ok=True)

    tmp_bz2: str | None = None
    tmp_sqlite: str | None = None
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, read=300.0)
        ) as client:
            head_resp = await client.head(_FUZZWORK_BZ2)
            remote_last_modified = head_resp.headers.get("Last-Modified")

            fd, tmp_bz2 = tempfile.mkstemp(dir=sde_dir, suffix=".bz2.tmp")
            os.close(fd)
            async with client.stream("GET", _FUZZWORK_BZ2) as resp:
                if not resp.is_success:
                    raise HTTPException(502, f"Fuzzwork returned {resp.status_code}")
                with open(tmp_bz2, "wb") as f:
                    async for chunk in resp.aiter_bytes(65536):
                        f.write(chunk)

        fd2, tmp_sqlite = tempfile.mkstemp(dir=sde_dir, suffix=".sqlite.tmp")
        os.close(fd2)

        def _decompress() -> None:
            with bz2.open(tmp_bz2, "rb") as src, open(tmp_sqlite, "wb") as dst:  # type: ignore[arg-type]
                while chunk := src.read(65536):
                    dst.write(chunk)

        await asyncio.get_running_loop().run_in_executor(None, _decompress)

        os.replace(tmp_sqlite, str(sde_path))
        tmp_sqlite = None

        get_sde.cache_clear()

        now = datetime.now(timezone.utc).isoformat()
        async with AsyncSessionLocal() as session:
            for key, value in (
                ("sde_installed_at", now),
                ("sde_remote_modified", remote_last_modified or ""),
            ):
                setting = await session.get(AppSetting, key)
                if setting:
                    setting.value = value
                else:
                    session.add(AppSetting(key=key, value=value))
            await session.commit()

        return {"ok": True, "installed_at": now, "remote_last_modified": remote_last_modified}

    finally:
        for f in (tmp_bz2, tmp_sqlite):
            if f and os.path.exists(f):
                try:
                    os.unlink(f)
                except OSError:
                    pass
