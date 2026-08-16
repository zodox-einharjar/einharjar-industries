from datetime import datetime, timezone
from decimal import Decimal

from ..models import InventoryLot


def save_lots(session, items, location_id: int, source: str) -> int:
    """Create InventoryLot rows for a batch of items (each with .type_id, .item_name,
    .qty, .unit_price attributes). Caller is responsible for committing the session."""
    now = datetime.now(timezone.utc)
    for item in items:
        session.add(InventoryLot(
            type_id=item.type_id,
            item_name=item.item_name,
            location_id=location_id,
            qty_original=item.qty,
            qty_remaining=item.qty,
            unit_cost=Decimal(str(item.unit_price)),
            purchased_at=now,
            source=source,
        ))
    return len(items)
