from datetime import datetime, timezone

from .history import get_history

WINDOW_DAYS = 30  # velocity is averaged over the most recent N days of ESI history


async def daily_velocity(region_id: int, type_id: int, cache: dict[tuple[int, int], list[dict]]) -> float:
    """Average units/day traded over the last WINDOW_DAYS calendar days.

    ESI omits no-trade days entirely rather than returning zero-volume rows, so this
    filters by actual calendar age and divides by the fixed window — not by the count
    of rows returned, which would silently skip gaps and inflate the average.
    `cache` is shared across calls by the caller (keyed by (region_id, type_id)) so
    repeated lookups for the same item don't re-fetch from ESI.
    """
    key = (region_id, type_id)
    if key not in cache:
        cache[key] = await get_history(region_id, type_id)
    today = datetime.now(timezone.utc).date()
    total = 0
    for r in cache[key]:
        age = (today - datetime.strptime(r["date"], "%Y-%m-%d").date()).days
        if 0 <= age <= WINDOW_DAYS:
            total += r.get("volume", 0)
    return total / WINDOW_DAYS
