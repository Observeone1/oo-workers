#!/usr/bin/env sh
# Run the full integration suite locally. Requires Postgres + Redis reachable.
# Used by `bun run test:integration` and the Husky pre-push hook.
set -e

# Load .env if present so the hook works without manual env exports.
# Fall back to docker-compose defaults if .env is missing.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER:-oo}:${POSTGRES_PASSWORD:-oo}@localhost:${POSTGRES_PORT:-5442}/${POSTGRES_DB:-oo_workers}}"
export REDIS_URL="${REDIS_URL:-redis://:${REDIS_PASSWORD:-}@localhost:${REDIS_PORT:-6379}}"

bun src/db/migrate.ts

LOG_LEVEL=warn bun src/index.ts &
WORKER_PID=$!
trap "kill $WORKER_PID 2>/dev/null || true" EXIT

sleep 3
bun scripts/smoke.ts
bun scripts/scheduler-test.ts
bun scripts/load.ts
# Backup/restore round-trip — provisions its own oo_br_* sibling DBs from
# DATABASE_URL and drops them; never touches the integration DB.
bun scripts/backup-restore-test.ts
# SaaS→self-host adapter contract — pure (no DB/server); guards the
# snake_case/camelCase drift that silently imported zero rows.
bun scripts/import-from-saas-test.ts
