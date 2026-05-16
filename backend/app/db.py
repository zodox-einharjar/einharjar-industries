from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings

engine = create_async_engine(settings.database_url, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def create_tables() -> None:
    from . import models  # noqa: F401 — ensure models are registered
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add columns introduced after initial table creation
        for sql in _COLUMN_MIGRATIONS:
            await conn.execute(_text(sql))


from sqlalchemy import text as _text

_COLUMN_MIGRATIONS = [
    "ALTER TABLE project_jobs ADD COLUMN IF NOT EXISTS is_done BOOLEAN NOT NULL DEFAULT false",
    "ALTER TABLE project_jobs DROP COLUMN IF EXISTS me",
    "ALTER TABLE industry_projects DROP COLUMN IF EXISTS manufacturing_cost",
    "ALTER TABLE characters ADD COLUMN IF NOT EXISTS corporation_id BIGINT",
    "ALTER TABLE characters ADD COLUMN IF NOT EXISTS corporation_name TEXT",
    "ALTER TABLE industry_projects ADD COLUMN IF NOT EXISTS frozen_material_cost NUMERIC(20,2)",
    "ALTER TABLE locations ADD COLUMN IF NOT EXISTS system_id BIGINT",
    "ALTER TABLE inventory_lots ALTER COLUMN location_id DROP NOT NULL",
    "ALTER TABLE inventory_lots DROP CONSTRAINT IF EXISTS inventory_lots_location_id_fkey",
    "ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lots_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL",
]
