import httpx
from datetime import datetime, timezone, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..config import settings
from ..models import Character


class TokenExpiredError(Exception):
    """Raised when EVE SSO rejects a refresh token (token revoked or expired >90 days)."""
    def __init__(self, character_id: int):
        self.character_id = character_id
        super().__init__(f"Refresh token invalid for character {character_id} — re-auth required")


async def get_valid_token(char: Character, session: AsyncSession) -> str:
    """Return a valid access token, refreshing from EVE SSO if near expiry."""
    if char.token_expires > datetime.now(timezone.utc) + timedelta(minutes=5):
        return char.access_token

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://login.eveonline.com/v2/oauth/token",
            data={"grant_type": "refresh_token", "refresh_token": char.refresh_token},
            auth=(settings.eve_client_id, settings.eve_client_secret),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        if e.response.status_code in (400, 401):
            raise TokenExpiredError(char.character_id) from e
        raise
    tokens = resp.json()

    char.access_token = tokens["access_token"]
    char.refresh_token = tokens["refresh_token"]
    char.token_expires = datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 1200))
    session.add(char)
    await session.commit()
    return char.access_token


async def get_char_with_scope(session: AsyncSession, scope: str) -> Character | None:
    """Return the first character that holds a given ESI scope."""
    result = await session.execute(select(Character))
    for char in result.scalars():
        if scope in (char.scopes or []):
            return char
    return None
