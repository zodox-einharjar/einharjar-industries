from fastapi import HTTPException, Request
from sqlalchemy import select

from ..db import AsyncSessionLocal
from ..models import Character


async def get_current_character(request: Request) -> Character:
    owner_hash = request.session.get("character_owner_hash")
    if not owner_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Character).where(Character.character_owner_hash == owner_hash)
        )
        char = result.scalar_one_or_none()
    if not char:
        raise HTTPException(status_code=401, detail="Character not found")
    return char
