from ..esi.client import ESIError, esi


async def get_history(region_id: int, type_id: int) -> list[dict]:
    """Daily region market history (date/average/highest/lowest/volume/order_count) for a type_id."""
    try:
        return await esi.get(f"/markets/{region_id}/history/", params={"type_id": type_id})
    except ESIError:
        return []
