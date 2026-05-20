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
# TCP banner/probe-read — probes the integration Redis (PING→PONG); pure
# (no DB/HTTP), anti-vacuous (mismatch must FAIL).
bun scripts/tcp-banner-test.ts
# TLS cert-expiry — openssl-generated certs against a throwaway local
# tls.createServer; pure (no DB/HTTP/egress), anti-vacuous (in-window
# cert must FAIL).
bun scripts/tls-cert-test.ts
# OO_AGENT_TLS_INSECURE gate — real agent pollJob vs a self-signed
# HTTPS master; pure, anti-vacuous by construction (off→reject MUST
# throw, on→204 MUST succeed).
bun scripts/agent-tls-test.ts
# QA-project alerting — webhook channel bound to a throwaway QA project,
# local catch-all server, full transition table; anti-vacuous (noop
# rows must NOT alert, transition rows must). Mutates the integration
# DB with unique names + finally cleanup.
bun scripts/qa-alerting-test.ts
# Incident markdown→HTML safety — the only path that emits operator text
# onto the public unauthenticated status page; pure, anti-vacuous (XSS
# corpus must be neutralised AND the safe subset must still work).
bun scripts/incident-render-test.ts
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
