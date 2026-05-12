#!/usr/bin/env sh
# Run the full integration suite locally. Requires Postgres + Redis reachable.
# Used by `bun run test:integration` and the Husky pre-push hook.
set -e

bun src/db/migrate.ts

LOG_LEVEL=warn bun src/index.ts &
WORKER_PID=$!
trap "kill $WORKER_PID 2>/dev/null || true" EXIT

sleep 3
bun scripts/smoke.ts
bun scripts/scheduler-test.ts
bun scripts/load.ts
