#!/usr/bin/env bash
# Run the full integration suite locally. Requires Postgres + Redis reachable.
# Used by `bun run test:integration` and the Husky pre-push hook.
# Uses bash for the /dev/tcp probe below (not available in POSIX sh / dash).
set -e

# Load .env if present so the hook works without manual env exports.
# Fall back to docker-compose defaults if .env is missing.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER:-oo}:${POSTGRES_PASSWORD:-oo}@localhost:${POSTGRES_PORT:-5442}/${POSTGRES_DB:-oo_workers}}"
# Test Redis runs on its own port (default 6479) under a dedicated container
# name so it doesn't clash with other local stacks that already publish a
# redis on 6379 (e.g. observeone-frontend). Override via REDIS_PORT in .env.
export REDIS_URL="${REDIS_URL:-redis://:${REDIS_PASSWORD:-}@localhost:${REDIS_PORT:-6479}}"

PG_PORT="${POSTGRES_PORT:-5442}"
REDIS_PORT_PROBE="${REDIS_PORT:-6479}"
probe() { (echo > "/dev/tcp/localhost/$1") 2>/dev/null; }

# Postgres comes from the user's existing compose stack — if it's down,
# fail with a clear message rather than starting one behind their back.
if ! probe "$PG_PORT"; then
  echo "[run-integration] Postgres not reachable on localhost:$PG_PORT." >&2
  echo "                  Start your oo-workers postgres container, then re-run." >&2
  exit 1
fi

# Redis: this script owns the test-redis container outright. If it's not
# running, start a dedicated `oo-workers-test-redis` on REDIS_PORT (6479),
# isolated from any other redis on the host. Idempotent: re-uses a stopped
# container with the same name.
if ! probe "$REDIS_PORT_PROBE"; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[run-integration] Redis not reachable on localhost:$REDIS_PORT_PROBE and docker is unavailable." >&2
    echo "                  Start a redis on that port manually, then re-run." >&2
    exit 1
  fi
  REDIS_CTR="oo-workers-test-redis"
  echo "[run-integration] Starting $REDIS_CTR on localhost:$REDIS_PORT_PROBE..."
  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CTR"; then
    docker start "$REDIS_CTR" >/dev/null
  else
    docker run -d --name "$REDIS_CTR" -p "$REDIS_PORT_PROBE:6379" redis:8-alpine >/dev/null
  fi
  for i in $(seq 1 30); do
    probe "$REDIS_PORT_PROBE" && break
    sleep 1
  done
  if ! probe "$REDIS_PORT_PROBE"; then
    echo "[run-integration] $REDIS_CTR didn't accept connections within 30s." >&2
    echo "                  Check 'docker logs $REDIS_CTR'." >&2
    exit 1
  fi
fi

bun src/db/migrate.ts

LOG_LEVEL=warn bun src/index.ts &
WORKER_PID=$!
trap "kill $WORKER_PID 2>/dev/null || true" EXIT

sleep 3

# ── Pure scripts (no DB/Redis mutation) run in parallel ───────────────
# Each spins up its own local fixture (a node:net or tls.createServer)
# or runs against the integration Redis read-only. None touches the
# integration Postgres, so they can race safely. Net wall-clock saving
# on the full suite: ~60-90s vs the previous serial run.
#
# - import-from-saas-test: adapter-contract test, no DB/HTTP.
# - tcp-banner-test: probes the integration Redis (PING→PONG only).
# - tls-cert-test: openssl-generated certs against a throwaway local tls.createServer.
# - agent-tls-test: OO_AGENT_TLS_INSECURE gate via a self-signed HTTPS master.
# - incident-render-test: pure markdown→HTML XSS test, no I/O.
echo "[run-integration] launching pure suites in parallel"
PARALLEL_PIDS=()
LOG_DIR=$(mktemp -d)
for suite in import-from-saas-test tcp-banner-test tls-cert-test agent-tls-test incident-render-test; do
  bun "scripts/$suite.ts" > "$LOG_DIR/$suite.log" 2>&1 &
  PARALLEL_PIDS+=($!)
done
PARALLEL_OK=1
for pid in "${PARALLEL_PIDS[@]}"; do
  if ! wait "$pid"; then PARALLEL_OK=0; fi
done
for suite in import-from-saas-test tcp-banner-test tls-cert-test agent-tls-test incident-render-test; do
  if [ "$PARALLEL_OK" -eq 0 ]; then
    echo "─── $suite ──"
    cat "$LOG_DIR/$suite.log"
  else
    # Just print the final summary line so the run log isn't noisy.
    tail -1 "$LOG_DIR/$suite.log"
  fi
done
rm -rf "$LOG_DIR"
[ "$PARALLEL_OK" -eq 1 ] || { echo "[run-integration] one or more pure suites failed"; exit 1; }

# ── DB-mutating scripts must run serially ──────────────────────────────
# These share the integration Postgres; running them in parallel would
# step on each other's seeded rows. Order matters: smoke + scheduler-test
# first (they're the broadest sanity check), then the rest. Each script
# cleans up its own prefix-namespaced rows in a finally block.
bun scripts/smoke.ts
bun scripts/scheduler-test.ts
# Backup/restore round-trip — provisions its own oo_br_* sibling DBs from
# DATABASE_URL and drops them; never touches the integration DB.
bun scripts/backup-restore-test.ts
# QA-project alerting — webhook channel bound to a throwaway QA project,
# local catch-all server, full transition table; anti-vacuous (noop
# rows must NOT alert, transition rows must). Mutates the integration
# DB with unique names + finally cleanup.
bun scripts/qa-alerting-test.ts
# Self-service account endpoints (profile / password change, v2 UI).
# Boots the real Hono app, drives the routes over HTTP; anti-vacuous
# (wrong-current-password negative control must reject AND leave the
# password unchanged). Mutates the integration DB with a throwaway
# user + finally cleanup.
bun scripts/auth-profile-test.ts
# Surrogate-id remap on /api/import (Roadmap 3.3). Boots the real Hono
# app, POSTs three crafted bundles (v1.25.0 / pre-1.25.0 / dangling), and
# reads the resulting monitor_alert_channels + status_page_monitors rows
# back from Postgres. Anti-vacuous: a handler that always wires bindings
# fails the back-compat case; one that never wires them fails the
# positive case. Cleans its own prefix-namespaced rows in finally.
bun scripts/import-remap-test.ts
# Heartbeat monitors (Roadmap 8). Inverted-direction; the service pings
# /heartbeat/:token, scheduler flips status OVERDUE when ping is late.
# Anti-vacuous: idempotent OVERDUE transition prevents double-alerts;
# wasOverdue=true ONLY on recovery (proven by negative I-check).
bun scripts/heartbeat-test.ts
# /api/import heartbeat round-trip (Roadmap 8 follow-up). Proves CLI v1.26.0
# ping_key carries through as the self-host token so public ping URLs
# survive a SaaS→self-host migration. Anti-vacuous: separate "supplied" vs
# "generated" assertions guard against a handler that always picks one
# branch.
bun scripts/import-heartbeat-e2e-test.ts

# Load test is opt-in. Originally ran in pre-push but it's a stress test,
# not a correctness gate — pre-push wants quick signal. Run via
# `bun run test:load` when stress-testing a release candidate or after
# touching scheduler concurrency knobs.
# bun scripts/load.ts
