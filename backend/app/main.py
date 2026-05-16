from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .db import create_tables
from .esi.client import esi
from .auth.router import router as auth_router
from .contracts.router import router as contracts_router
from .doctrines.router import router as doctrines_router
from .industry.router import router as industry_router
from .inventory.router import router as inventory_router
from .market_listings.router import router as market_listings_router
from .settings.router import router as settings_router
from .scheduler.jobs import start_scheduler, stop_scheduler
from .templates import templates


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_tables()
    await start_scheduler()
    yield
    await stop_scheduler()
    await esi.close()


app = FastAPI(title="Einharjar Industries", lifespan=lifespan, debug=settings.debug)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    max_age=86400 * 7,
    https_only=False,   # set True when HTTPS is configured
    same_site="lax",
)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.include_router(auth_router)
app.include_router(contracts_router)
app.include_router(doctrines_router)
app.include_router(industry_router)
app.include_router(inventory_router)
app.include_router(market_listings_router)
app.include_router(settings_router)



@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/")
async def index(request: Request):
    from sqlalchemy import select
    from .db import AsyncSessionLocal
    from .models import Character

    owner_hash = request.session.get("character_owner_hash")
    character = None
    if owner_hash:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Character).where(Character.character_owner_hash == owner_hash)
            )
            character = result.scalar_one_or_none()

    return templates.TemplateResponse(request=request, name="index.html", context={"character": character})
