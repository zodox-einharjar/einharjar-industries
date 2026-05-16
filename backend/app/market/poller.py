import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import delete, select

from ..auth.tokens import TokenExpiredError, get_char_with_scope, get_valid_token
from ..db import AsyncSessionLocal
from ..esi.client import ESIError, esi
from ..models import Location, MarketOrder

logger = logging.getLogger(__name__)


async def poll_location(location_id: int) -> None:
    async with AsyncSessionLocal() as session:
        loc = await session.get(Location, location_id)
        if not loc:
            return
        try:
            if loc.location_type == "structure":
                char = await get_char_with_scope(session, "esi-markets.structure_markets.v1")
                if not char:
                    logger.warning("No character with structure_markets scope for %s", loc.name)
                    return
                token = await get_valid_token(char, session)
                orders = await esi.fetch_all_pages(
                    f"/markets/structures/{loc.eve_id}/",
                    token=token,
                )
            else:
                all_orders = await esi.fetch_all_pages(
                    f"/markets/{loc.region_id}/orders/",
                    params={"order_type": "all"},
                )
                orders = [o for o in all_orders if o.get("location_id") == loc.eve_id]

            now = datetime.now(timezone.utc)
            await session.execute(delete(MarketOrder).where(MarketOrder.location_id == location_id))
            for o in orders:
                session.add(MarketOrder(
                    order_id=o["order_id"],
                    location_id=location_id,
                    type_id=o["type_id"],
                    price=Decimal(str(o["price"])),
                    volume_remain=o["volume_remain"],
                    is_buy=o.get("is_buy_order", False),
                    fetched_at=now,
                ))
            await session.commit()
            sells = sum(1 for o in orders if not o.get("is_buy_order"))
            buys = len(orders) - sells
            logger.info("Polled %d sell + %d buy orders for %s", sells, buys, loc.name)

        except TokenExpiredError as e:
            logger.warning("Skipping %s: %s", loc.name, e)
        except ESIError as e:
            logger.error("ESI error polling %s: %s", loc.name, e)
        except Exception:
            logger.exception("Unexpected error polling location %d", location_id)


async def poll_all_locations() -> None:
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Location))
        location_ids = [loc.id for loc in result.scalars()]
    for lid in location_ids:
        await poll_location(lid)
