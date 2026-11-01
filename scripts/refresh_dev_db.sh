#!/usr/bin/env bash
# Replace the dev database with a fresh copy of the live one.
#
#   scripts/refresh_dev_db.sh        # asks before dropping the dev DB
#   scripts/refresh_dev_db.sh -y     # no prompt
#
# Source = DATABASE_URL in .env (live), target = DATABASE_URL in .env.dev.
# The live database is only ever read (pg_dump). EVE tokens are blanked in the
# copy so the local app can never refresh production's tokens — log in locally
# with the dev EVE app afterwards. Stop the local backend first (or it reconnects
# mid-restore); pg_dump/psql run inside the postgres:18 image, nothing to install.

set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }

[[ -f .env ]] || die ".env (live config) not found"
[[ -f .env.dev ]] || die ".env.dev not found — copy .env.dev.example"

url() { grep -E '^DATABASE_URL=' "$1" | cut -d= -f2- | sed 's#^postgresql+asyncpg://#postgresql://#'; }
dbname() { local tail="${1##*/}"; echo "${tail%%\?*}"; }

LIVE_URL=$(url .env)
DEV_URL=$(url .env.dev)
LIVE_DB=$(dbname "$LIVE_URL")
DEV_DB=$(dbname "$DEV_URL")

[[ -n "$LIVE_DB" && -n "$DEV_DB" ]] || die "couldn't read DATABASE_URL from .env / .env.dev"
[[ "$DEV_DB" == *_dev ]] || die "dev database name must end in _dev (got '$DEV_DB') — refusing to drop it"
[[ "$DEV_DB" != "$LIVE_DB" ]] || die ".env.dev points at the live database — refusing"

if [[ "${1:-}" != "-y" ]]; then
  read -r -p "Drop '$DEV_DB' and replace it with a copy of '$LIVE_DB'? [y/N] " answer
  [[ "$answer" == [yY]* ]] || exit 1
fi

# Pass credentials via an env file rather than the command line (keeps them out of `ps`).
envfile=$(mktemp)
trap 'rm -f "$envfile"' EXIT
chmod 600 "$envfile"
{
  echo "LIVE_URL=$LIVE_URL"
  echo "DEV_URL=$DEV_URL"
  echo "ADMIN_URL=${DEV_URL%/*}/postgres"
  echo "DEV_DB=$DEV_DB"
} > "$envfile"

echo "Copying $LIVE_DB → $DEV_DB …"
docker run --rm -i --env-file "$envfile" postgres:18 bash -euo pipefail -s <<'IN_CONTAINER'
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DEV_DB\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DEV_DB\""
pg_dump --format=custom --no-owner --no-privileges "$LIVE_URL" \
  | pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DEV_URL"
psql "$DEV_URL" -q -v ON_ERROR_STOP=1 \
  -c "UPDATE characters SET access_token = '', refresh_token = '', token_expires = 'epoch'"
IN_CONTAINER

echo "Done. $DEV_DB now mirrors $LIVE_DB (EVE tokens blanked — log in again locally)."
