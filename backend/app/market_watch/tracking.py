from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..models import TrackedItem


async def track_items(session, type_ids: Iterable[int], source: str = "doctrine") -> None:
    """Insert-if-missing so existing rows (manual or doctrine) are never overwritten."""
    ids = {tid for tid in type_ids if tid}
    if not ids:
        return
    now = datetime.now(timezone.utc)
    stmt = pg_insert(TrackedItem).values([
        {"type_id": tid, "source": source, "added_at": now} for tid in ids
    ]).on_conflict_do_nothing(index_elements=["type_id"])
    await session.execute(stmt)
