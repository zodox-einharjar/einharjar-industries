import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

logger = logging.getLogger(__name__)
from sqlalchemy import select, delete
from sqlalchemy.dialects.postgresql import insert

from ..config import settings
from ..db import AsyncSessionLocal
from ..models import ESICache


class ESIError(Exception):
    def __init__(self, status: int, path: str):
        self.status = status
        super().__init__(f"ESI {status}: {path}")


class ESIClient:
    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            base_url=settings.esi_base_url,
            headers={
                "User-Agent": settings.esi_user_agent,
                "Accept": "application/json",
            },
            timeout=30.0,
        )
        self._error_remain: int = 100
        self._error_reset_at: datetime = datetime.now(timezone.utc)
        self.last_page_expires: datetime | None = None

    def _update_error_budget(self, response: httpx.Response) -> None:
        remain = response.headers.get("X-ESI-Error-Limit-Remain")
        reset = response.headers.get("X-ESI-Error-Limit-Reset")
        if remain is not None:
            self._error_remain = int(remain)
        if reset is not None:
            self._error_reset_at = datetime.now(timezone.utc) + timedelta(seconds=int(reset))

    async def _wait_if_budget_low(self) -> None:
        if self._error_remain >= 20:
            return
        now = datetime.now(timezone.utc)
        if now < self._error_reset_at:
            wait = (self._error_reset_at - now).total_seconds()
            await asyncio.sleep(min(wait, 60))

    def _cache_key(self, path: str, params: dict | None) -> str:
        return f"{path}:{json.dumps(sorted((params or {}).items()))}"

    async def _raw_get(
        self,
        path: str,
        *,
        token: str | None = None,
        params: dict | None = None,
    ) -> httpx.Response:
        """Single GET with error-budget wait and one 429 retry."""
        await self._wait_if_budget_low()
        headers: dict[str, str] = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = await self._http.get(path, params=params, headers=headers)
        self._update_error_budget(response)
        if response.status_code == 429:
            retry_after = int(response.headers.get("Retry-After", 60))
            await asyncio.sleep(retry_after)
            response = await self._http.get(path, params=params, headers=headers)
            self._update_error_budget(response)
        return response

    async def get(
        self,
        path: str,
        *,
        token: str | None = None,
        params: dict | None = None,
    ) -> Any:
        key = self._cache_key(path, params)

        async with AsyncSessionLocal() as session:
            cached = await session.get(ESICache, key)
            if cached and cached.expires_at > datetime.now(timezone.utc):
                return cached.data

        response = await self._raw_get(path, token=token, params=params)

        if not response.is_success:
            raise ESIError(response.status_code, path)

        data = response.json()

        expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        expires_header = response.headers.get("Expires")
        if expires_header:
            try:
                expires_at = parsedate_to_datetime(expires_header)
            except Exception:
                pass

        async with AsyncSessionLocal() as session:
            stmt = insert(ESICache).values(key=key, data=data, expires_at=expires_at)
            stmt = stmt.on_conflict_do_update(
                index_elements=["key"],
                set_={"data": data, "expires_at": expires_at},
            )
            await session.execute(stmt)
            await session.commit()

        return data

    async def fetch_all_pages(
        self,
        path: str,
        *,
        token: str | None = None,
        params: dict | None = None,
    ) -> list[Any]:
        """Fetch all pages of a paginated ESI endpoint. Does not use the ESI cache."""
        all_items: list[Any] = []
        page = 1
        while True:
            response = await self._raw_get(
                path, token=token, params={**(params or {}), "page": page}
            )
            if not response.is_success:
                raise ESIError(response.status_code, path)
            data = response.json()
            expires_header = response.headers.get("Expires")
            if expires_header:
                try:
                    self.last_page_expires = parsedate_to_datetime(expires_header)
                except Exception:
                    pass
            if not data:
                break
            all_items.extend(data)
            total_pages = int(response.headers.get("X-Pages", 1))
            if page >= total_pages:
                break
            page += 1
        return all_items

    async def resolve_names(self, ids: list[int]) -> dict[int, str]:
        """Bulk-resolve EVE entity IDs to names via /universe/names/.
        Results are cached per-ID in ESICache with a 24-hour TTL."""
        if not ids:
            return {}

        result: dict[int, str] = {}
        missing: list[int] = []

        async with AsyncSessionLocal() as session:
            for entity_id in ids:
                cached = await session.get(ESICache, f"name:{entity_id}")
                if cached and cached.expires_at > datetime.now(timezone.utc):
                    result[entity_id] = cached.data
                else:
                    missing.append(entity_id)

        for i in range(0, len(missing), 1000):
            chunk = missing[i:i + 1000]
            await self._wait_if_budget_low()
            response = await self._http.post("/universe/names/", json=chunk)
            self._update_error_budget(response)
            if not response.is_success:
                logger.warning("resolve_names chunk failed with %s — %d IDs unresolved", response.status_code, len(chunk))
                continue

            expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
            async with AsyncSessionLocal() as session:
                for item in response.json():
                    eid, name = item["id"], item["name"]
                    result[eid] = name
                    stmt = insert(ESICache).values(
                        key=f"name:{eid}", data=name, expires_at=expires_at
                    ).on_conflict_do_update(
                        index_elements=["key"],
                        set_={"data": name, "expires_at": expires_at},
                    )
                    await session.execute(stmt)
                await session.commit()

        return result

    async def purge_expired_cache(self) -> None:
        async with AsyncSessionLocal() as session:
            await session.execute(
                delete(ESICache).where(ESICache.expires_at <= datetime.now(timezone.utc))
            )
            await session.commit()

    async def close(self) -> None:
        await self._http.aclose()


esi = ESIClient()
