from apscheduler.schedulers.asyncio import AsyncIOScheduler

_scheduler = AsyncIOScheduler(timezone="UTC")


async def start_scheduler() -> None:
    from ..market.poller import poll_all_locations
    from ..market.orders_poller import poll_character_orders
    from ..market.transaction_poller import poll_wallet_transactions
    from ..contracts.poller import poll_contracts
    from ..db import AsyncSessionLocal
    from ..models import AppSetting

    interval = 5
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, "poll_interval_minutes")
        if setting:
            try:
                interval = max(1, min(60, int(setting.value)))
            except ValueError:
                pass

    _scheduler.add_job(poll_all_locations, "interval", minutes=interval, id="poll_markets", replace_existing=True)
    _scheduler.add_job(poll_character_orders, "interval", minutes=5, id="poll_orders", replace_existing=True)
    _scheduler.add_job(poll_wallet_transactions, "interval", minutes=5, id="poll_transactions", replace_existing=True)
    _scheduler.add_job(poll_contracts, "interval", minutes=5, id="poll_contracts", replace_existing=True)
    _scheduler.start()


def reschedule_poll(minutes: int) -> None:
    _scheduler.reschedule_job("poll_markets", trigger="interval", minutes=minutes)


async def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


def get_scheduler() -> AsyncIOScheduler:
    return _scheduler
