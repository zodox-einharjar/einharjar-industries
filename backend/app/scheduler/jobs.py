from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

_scheduler = AsyncIOScheduler(timezone="UTC")


async def start_scheduler() -> None:
    from ..market.poller import poll_all_locations
    from ..market.orders_poller import poll_character_orders
    from ..market.transaction_poller import poll_wallet_transactions
    from ..contracts.poller import poll_contracts
    from ..industry_jobs.poller import poll_industry_jobs
    from ..mercenary.poller import poll_mercenary
    from ..wallet.poller import poll_wallets
    from ..db import AsyncSessionLocal
    from sqlalchemy import func, select
    from ..models import AppSetting, MarketOrder

    interval = 5
    async with AsyncSessionLocal() as session:
        setting = await session.get(AppSetting, "poll_interval_minutes")
        if setting:
            try:
                interval = max(1, min(60, int(setting.value)))
            except ValueError:
                pass
        last_poll = (await session.execute(select(func.max(MarketOrder.fetched_at)))).scalar_one_or_none()

    # Continue the cycle from the last poll instead of restarting it: an interval job
    # otherwise first fires a full interval after startup, so every restart (a deploy,
    # or each reload in dev) would push the next market poll back by that much.
    now = datetime.now(timezone.utc)
    due = last_poll + timedelta(minutes=interval) if last_poll else now
    first_run = max(due, now + timedelta(seconds=30))

    _scheduler.add_job(
        poll_all_locations, "interval", minutes=interval, id="poll_markets",
        replace_existing=True, next_run_time=first_run,
    )
    _scheduler.add_job(poll_character_orders, "interval", minutes=5, id="poll_orders", replace_existing=True)
    _scheduler.add_job(poll_wallet_transactions, "interval", minutes=5, id="poll_transactions", replace_existing=True)
    _scheduler.add_job(poll_contracts, "interval", minutes=5, id="poll_contracts", replace_existing=True)
    _scheduler.add_job(poll_industry_jobs, "interval", minutes=5, id="poll_industry_jobs", replace_existing=True)
    _scheduler.add_job(poll_mercenary, "interval", minutes=5, id="poll_mercenary", replace_existing=True)
    _scheduler.add_job(
        poll_wallets, "interval", minutes=15, id="poll_wallets", replace_existing=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=45),
    )
    _scheduler.start()


def reschedule_poll(minutes: int) -> None:
    _scheduler.reschedule_job("poll_markets", trigger="interval", minutes=minutes)


async def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


def get_scheduler() -> AsyncIOScheduler:
    return _scheduler
