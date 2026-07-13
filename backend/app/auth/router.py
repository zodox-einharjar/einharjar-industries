import secrets
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from .deps import get_current_character
from jose import jwt, JWTError
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from ..config import settings
from ..db import AsyncSessionLocal
from ..models import AppSetting, Character

router = APIRouter(prefix="/auth", tags=["auth"])

EVE_SSO_AUTH   = "https://login.eveonline.com/v2/oauth/authorize"
EVE_SSO_TOKEN  = "https://login.eveonline.com/v2/oauth/token"
EVE_SSO_META   = "https://login.eveonline.com/.well-known/oauth-authorization-server"
EVE_SSO_REVOKE = "https://login.eveonline.com/v2/oauth/revoke"

_CHAR_SCOPES = [
    "esi-assets.read_assets.v1",
    "esi-markets.structure_markets.v1",
    "esi-markets.read_character_orders.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-contracts.read_character_contracts.v1",
]

_CORP_SCOPES = [
    "esi-assets.read_corporation_assets.v1",
    "esi-markets.structure_markets.v1",
    "esi-markets.read_corporation_orders.v1",
    "esi-wallet.read_corporation_wallets.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-contracts.read_corporation_contracts.v1",
]

# Union of both — one auth covers everything
_ALL_SCOPES = list(dict.fromkeys(_CHAR_SCOPES + _CORP_SCOPES))

_jwks_cache: dict | None = None


async def _get_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache is None:
        async with httpx.AsyncClient() as client:
            meta = (await client.get(EVE_SSO_META)).json()
            jwks = (await client.get(meta["jwks_uri"])).json()
            _jwks_cache = jwks
    return _jwks_cache


@router.get("/login")
async def login(request: Request, type: str = "character") -> RedirectResponse:
    scopes = _ALL_SCOPES if type == "corporation" else _CHAR_SCOPES
    state = secrets.token_urlsafe(32)
    request.session["oauth_state"] = state
    qs = urlencode({
        "response_type": "code",
        "client_id": settings.eve_client_id,
        "redirect_uri": settings.eve_callback_url,
        "scope": " ".join(scopes),
        "state": state,
    })
    return RedirectResponse(f"{EVE_SSO_AUTH}?{qs}")


@router.get("/callback")
async def callback(request: Request, code: str, state: str) -> RedirectResponse:
    if state != request.session.pop("oauth_state", None):
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            EVE_SSO_TOKEN,
            data={"grant_type": "authorization_code", "code": code},
            auth=(settings.eve_client_id, settings.eve_client_secret),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if not resp.is_success:
        raise HTTPException(status_code=502, detail="Token exchange failed")

    tokens = resp.json()
    access_token: str = tokens["access_token"]
    refresh_token: str = tokens["refresh_token"]
    expires_in: int = tokens.get("expires_in", 1200)

    jwks = await _get_jwks()
    try:
        payload = jwt.decode(
            access_token,
            jwks,
            algorithms=["RS256"],
            audience=settings.eve_client_id,
        )
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"JWT validation failed: {exc}")

    if payload.get("iss") not in ("https://login.eveonline.com", "https://login.eveonline.com/"):
        raise HTTPException(status_code=401, detail="Invalid token issuer")
    if "EVE Online" not in payload.get("aud", []):
        raise HTTPException(status_code=401, detail="Invalid token audience")

    character_id = int(payload["sub"].split(":")[-1])
    character_name: str = payload["name"]
    owner_hash: str = payload["owner"]
    scopes = payload.get("scp", [])
    if isinstance(scopes, str):
        scopes = scopes.split()

    token_expires = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    # Fetch corporation info from ESI (public endpoint, no token needed)
    corporation_id: int | None = None
    corporation_name: str | None = None
    try:
        from ..esi.client import esi as _esi
        char_info = await _esi.get(f"/characters/{character_id}/")
        corporation_id = char_info.get("corporation_id")
        if corporation_id:
            corp_info = await _esi.get(f"/corporations/{corporation_id}/")
            corporation_name = corp_info.get("name")
    except Exception:
        pass  # Non-fatal — corp info is cosmetic

    async with AsyncSessionLocal() as session:
        existing = (await session.execute(
            select(Character).where(Character.character_owner_hash == owner_hash)
        )).scalar_one_or_none()

        merged_scopes = list(set((existing.scopes or []) + scopes)) if existing else scopes

        stmt = insert(Character).values(
            character_id=character_id,
            character_name=character_name,
            character_owner_hash=owner_hash,
            corporation_id=corporation_id,
            corporation_name=corporation_name,
            access_token=access_token,
            refresh_token=refresh_token,
            token_expires=token_expires,
            scopes=merged_scopes,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["character_owner_hash"],
            set_={
                "character_id": character_id,
                "character_name": character_name,
                "corporation_id": corporation_id,
                "corporation_name": corporation_name,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_expires": token_expires,
                "scopes": merged_scopes,
            },
        )
        await session.execute(stmt)
        await session.commit()

    request.session["character_owner_hash"] = owner_hash
    return RedirectResponse("/")


@router.get("/logout")
async def logout(request: Request) -> RedirectResponse:
    request.session.clear()
    return RedirectResponse("/")


def _portrait_url(character_id: int, size: int = 64) -> str:
    return f"https://images.evetech.net/characters/{character_id}/portrait?size={size}"


@router.get("/me")
async def me(char: Character = Depends(get_current_character)):
    # Return the designated main character, falling back to the logged-in character
    async with AsyncSessionLocal() as session:
        main_setting = await session.get(AppSetting, "main_character_id")
        display_char = char
        if main_setting:
            try:
                main_cid = int(main_setting.value)
                result = await session.execute(
                    select(Character).where(Character.character_id == main_cid)
                )
                found = result.scalar_one_or_none()
                if found:
                    display_char = found
            except (ValueError, Exception):
                pass
    return {
        "character_id": display_char.character_id,
        "character_name": display_char.character_name,
        "corp_name": display_char.corporation_name,
        "portrait_url": _portrait_url(display_char.character_id),
    }


@router.get("/characters")
async def list_characters(_: Character = Depends(get_current_character)):
    async with AsyncSessionLocal() as session:
        chars = (await session.execute(select(Character))).scalars().all()
    now = datetime.now(timezone.utc)
    return [
        {
            "character_id": c.character_id,
            "character_name": c.character_name,
            "corporation_id": c.corporation_id,
            "corp_name": c.corporation_name,
            "portrait_url": _portrait_url(c.character_id),
            "token_valid": c.token_expires > now,
            "expires_at": c.token_expires.isoformat(),
            "scopes": c.scopes,
        }
        for c in chars
    ]


@router.delete("/characters/{character_id}", status_code=204)
async def revoke_character(character_id: int, _: Character = Depends(get_current_character)):
    async with AsyncSessionLocal() as session:
        char = (await session.execute(
            select(Character).where(Character.character_id == character_id)
        )).scalar_one_or_none()
        if char and char.refresh_token:
            try:
                async with httpx.AsyncClient() as client:
                    await client.post(
                        EVE_SSO_REVOKE,
                        data={"token": char.refresh_token, "token_type_hint": "refresh_token"},
                        auth=(settings.eve_client_id, settings.eve_client_secret),
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
            except Exception:
                pass  # non-fatal — token may already be expired
        await session.execute(delete(Character).where(Character.character_id == character_id))
        await session.commit()


@router.get("/corporations")
async def list_corporations(_: Character = Depends(get_current_character)):
    return []  # corporation auth not yet implemented


@router.delete("/corporations/{corporation_id}", status_code=204)
async def revoke_corporation(corporation_id: int, _: Character = Depends(get_current_character)):
    raise HTTPException(status_code=501, detail="Corporation auth not yet implemented")
