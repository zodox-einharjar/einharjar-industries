# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo Layout

```
eve-app/
├── backend/       FastAPI app (Python)
├── frontend/      Next.js 14 app (TypeScript / Tailwind)
├── docker-compose.yml
├── nginx.conf
└── .env           Root env file — used by docker-compose and local backend dev
```

## Dev Commands

### Docker (recommended)

```bash
# First run: register http://localhost/auth/callback in your EVE developer app
docker compose up --build
# App is at http://localhost — nginx routes /auth/* + /api/* to backend, rest to Next.js
```

### SDE update (run once, then whenever CCP patches)

```bash
cd backend && python -m scripts.update_sde
# Downloads the official CCP SDE, converts to SQLite at data/sqlite-latest.sqlite.
# Skips download automatically if the build number hasn't changed.
```

### Backend (local, no Docker)

```bash
# .env must exist in backend/ — symlink it: ln -s ../.env backend/.env
cd backend && .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Manually invoke DB table creation (tables are auto-created on startup)
cd backend && python -c "import asyncio; from app.db import create_tables; asyncio.run(create_tables())"
```

### Frontend (local, no Docker)

```bash
cd frontend && npm install && npm run dev   # http://localhost:3000
```

There are no tests, no linter, and no Alembic migrations configured. Tables are created via `create_tables()` in the FastAPI lifespan — there is no rollback mechanism.

## Architecture

**Stack:** FastAPI (async) · SQLAlchemy asyncpg · PostgreSQL · Next.js 14 (App Router) · Tailwind · APScheduler · EVE SSO (OAuth2)

**Migration in progress:** FastAPI routes are being converted from Jinja2+HTMX HTML responses to JSON. New pages are built in `frontend/`. Nginx routes `/api/*` (strips prefix before forwarding) and `/auth/*` to FastAPI; everything else goes to Next.js.

**Static game data** (item names, volumes, station names, solar systems) comes exclusively from the official CCP SDE SQLite at `data/sqlite-latest.sqlite` via `app/sde.py`. Never use ESI for static data.

### Module Map

All backend source lives under `backend/`.

| Module | Responsibility |
|---|---|
| `backend/app/main.py` | App factory, router registration, lifespan |
| `backend/app/config.py` | `Settings` via pydantic-settings, reads `.env` |
| `backend/app/db.py` | Async engine, `AsyncSessionLocal`, `create_tables()` |
| `backend/app/models.py` | All ORM models (see below) |
| `backend/app/sde.py` | LRU-cached SQLite connection; `type_name`, `type_names`, `type_volume`, `type_volumes`, `station_name` |
| `backend/app/templates.py` | Single `Jinja2Templates` instance + `isk`/`iska` filters — import this, never instantiate a second one |
| `backend/app/auth/` | EVE SSO flow, session cookie, `get_current_character` dependency |
| `backend/app/esi/client.py` | `ESIClient` with DB-backed 5-min cache and error-budget backoff |
| `backend/app/scheduler/jobs.py` | APScheduler; runs `poll_all_locations` every 5 min |
| `backend/app/market/poller.py` | Fetches ESI market orders per location, replaces rows in `market_orders` |
| `backend/app/doctrines/router.py` | CRUD for locations, freight routes, fits, doctrines |
| `backend/app/doctrines/eft.py` | Parses EFT fit strings → `{ship_type_id, name, items: {type_id: qty}}` |
| `backend/app/doctrines/availability.py` | `calculate()` — returns per-fit availability + ISK comparison |

### Data Models

```
Location ──< MarketOrder
Location ──< FreightRoute (from/to)

Fit ──< FitItem (type_id + quantity)
Fit ──< DoctrineFit

Doctrine ──< DoctrineFit >── Fit

Character          (EVE SSO session, one per character)
ESICache           (generic ESI response cache)
```

`DoctrineFit.target_qty` is the goal stock level. Availability is `floor(min_available_per_item / qty_per_fit)` across all items.

### Auth Flow

- Session cookie holds `character_owner_hash` (not `character_id` — IDs can transfer between accounts).
- `get_current_character` dependency raises 401 if the hash isn't in the DB.
- Token refresh is handled in `auth/tokens.py`; call `get_valid_token(char, session)` before any authenticated ESI call.
- All doctrine/fit/location routes require this dependency.

### Jinja2 Filters

- `{{ value | isk(decimals=0) }}` → comma-formatted ISK string (`1,234,567`)
- `{{ value | iska }}` → abbreviated (`1.23b`, `980.5m`, `50k`)

Both handle `None` → `"—"`. Import `templates` from `app/templates`, never create a new `Jinja2Templates` instance.

### ESI Compliance (mandatory — violations can result in a ban)

- **Cache:** Always respect the `Expires` header. `ESIClient.get()` caches in `esi_cache` table; use it. Use `fetch_all_pages()` only for paginated endpoints (it bypasses cache by design).
- **Error budget:** Track `X-ESI-Error-Limit-Remain`/`X-ESI-Error-Limit-Reset`. The client backs off when remain < 20. Do not suppress this.
- **User-Agent:** All ESI requests must include `User-Agent` with app name + email (configured via `ESI_USER_AGENT` env var).
- **Static data:** Never call ESI for item names, volumes, station names, or solar system info — use `app/sde.py`.
- **Discovery abuse:** Never iterate ESI search endpoints to enumerate structures or characters.

### Freight Cost Model

`FreightRoute`: `isk_per_m3` (flat) + `value_pct` (fraction 0–1 of item value).

Import cost per item = `jita_price + (volume_m3 * isk_per_m3) + (jita_price * value_pct)`

Availability calc compares staging sell price vs import cost and highlights cheaper option.

## Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `SECRET_KEY` | `changeme` | Session signing — change in prod |
| `DEBUG` | `false` | FastAPI debug mode |
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/eve_app` | |
| `EVE_CLIENT_ID` | — | From developers.eveonline.com |
| `EVE_CLIENT_SECRET` | — | |
| `EVE_CALLBACK_URL` | `http://localhost:8000/auth/callback` | |
| `ESI_BASE_URL` | `https://esi.evetech.net/latest` | |
| `ESI_USER_AGENT` | `einharjar-industries/1.0 (your-email@example.com)` | Must include contact email |
| `SDE_PATH` | `data/sqlite-latest.sqlite` | Official CCP SDE SQLite (built by `scripts/update_sde.py`) |
