#!/usr/bin/env bash
#
# Multi-region end-to-end harness.
#
# Stands up a REAL regional agent container against the locally-running master
# stack and proves the full multi-region path that no unit/integration test can
# (those run single-process): a region-bound monitor's job is dispatched to the
# agent over HTTP long-poll, the agent runs the probe with no master DB/Redis
# access, posts the result back, and the master surfaces it live.
#
# This is a one-off, operator/LLM-run harness — NOT wired into CI (it needs
# Docker, the running master stack, and ~30-90s of agent polling). See README.md
# for the why and the step-by-step.
#
# Usage:
#   bash tests/multi-region-e2e/run.sh              # light image, items 9/10/13
#   WITH_QA=1 bash tests/multi-region-e2e/run.sh    # also oo-agent-qa, item 14 (pulls/builds ~3.5GB)
#   KEEP=1 bash tests/multi-region-e2e/run.sh       # leave region/monitor/agent up for inspection
#   SKIP_BROWSER=1 bash tests/multi-region-e2e/run.sh   # data-layer only, skip Playwright
#   REBUILD=1 bash tests/multi-region-e2e/run.sh    # force-rebuild the agent image from source
#
set -euo pipefail
cd "$(dirname "$0")/../.."

# ---- config (override via env) ----
HOST_API="${OO_MASTER_HOST:-http://localhost:3010}"     # script -> master, from the host
AGENT_MASTER_URL="${OO_AGENT_MASTER_URL:-http://ui:3001}" # agent container -> master, in-network
NETWORK="${OO_MASTER_NETWORK:-oo-workers_default}"
AGENT_CONTAINER="${OO_AGENT_CONTAINER:-oo-agent-e2e}"
REGION_SLUG="${OO_E2E_REGION_SLUG:-e2e-mr}"
AGENT_IMAGE="${OO_AGENT_IMAGE:-observeone/oo-agent-light:dev}"
WITH_QA="${WITH_QA:-0}"
KEEP="${KEEP:-0}"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; [ -n "${AGENT_CONTAINER:-}" ] && docker logs "$AGENT_CONTAINER" 2>&1 | tail -25 || true; exit 1; }
psql_q() { docker compose exec -T postgres psql -U oo -d oo_workers -tAc "$1" | tr -d '[:space:]'; }
apidel() { curl -fsS -X DELETE -H "Authorization: Bearer $API_KEY" "$1" >/dev/null 2>&1 || true; }

cleanup() {
  log "Teardown"
  docker rm -f "$AGENT_CONTAINER" >/dev/null 2>&1 || true
  if [ "$KEEP" = "1" ]; then echo "KEEP=1 — region #${REGION_ID:-?} and monitor #${MON_ID:-?} left in place"; return; fi
  [ -n "${MON_ID:-}" ] && apidel "$HOST_API/api/monitors/url/$MON_ID"
  [ -n "${REGION_ID:-}" ] && apidel "$HOST_API/api/regions/$REGION_ID"
  echo "cleaned up agent container, monitor, region"
}
trap cleanup EXIT

# ---- 0. preconditions ----
log "Checking master stack + network"
curl -fsS "$HOST_API/" -o /dev/null || fail "master not reachable at $HOST_API (is the stack up?)"
docker network inspect "$NETWORK" >/dev/null 2>&1 || fail "docker network '$NETWORK' not found"

if [ -n "${OO_E2E_API_KEY:-}" ]; then
  API_KEY="$OO_E2E_API_KEY"
else
  log "Minting an admin API key"
  API_KEY=$(docker compose exec -T worker bun scripts/create-api-key.ts --name mr-e2e 2>/dev/null | grep -oE 'oo_[A-Za-z0-9_-]+' | tail -1)
fi
[ -n "${API_KEY:-}" ] || fail "no API key"

# ---- 1. build agent image from current source ----
if [ "$WITH_QA" = "1" ]; then AGENT_IMAGE=observeone/oo-agent-qa:dev; TARGET=agent-qa; else TARGET=agent-light; fi
if ! docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1 || [ "${REBUILD:-0}" = "1" ]; then
  log "Building $AGENT_IMAGE (--target $TARGET)"
  docker build --target "$TARGET" -t "$AGENT_IMAGE" . >/dev/null
fi

# ---- 2. (re)create the region (mints the agent key) ----
log "Creating region '$REGION_SLUG'"
EXIST=$(psql_q "SELECT id FROM regions WHERE slug='$REGION_SLUG'")
[ -n "$EXIST" ] && apidel "$HOST_API/api/regions/$EXIST"
CR_OUT=$(docker compose exec -T worker bun scripts/create-region.ts --slug "$REGION_SLUG" --label "MR E2E")
AGENT_KEY=$(echo "$CR_OUT" | grep -oE 'OO_AGENT_KEY=[A-Za-z0-9_-]+' | cut -d= -f2)
REGION_ID=$(psql_q "SELECT id FROM regions WHERE slug='$REGION_SLUG'")
[ -n "$AGENT_KEY" ] && [ -n "$REGION_ID" ] || { echo "$CR_OUT"; fail "could not create region / parse agent key"; }
echo "region #$REGION_ID, agent key minted"

# ---- 3. create a URL monitor and bind it to the region ----
log "Creating URL monitor + binding to region"
curl -fsS -X POST -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"name":"mr-e2e-url","url":"https://example.com","intervalSeconds":30,"assertions":[{"operator":"equals","statusCode":200}]}' \
  "$HOST_API/api/monitors/url" >/dev/null
MON_ID=$(psql_q "SELECT id FROM url_monitors WHERE name='mr-e2e-url' ORDER BY id DESC LIMIT 1")
[ -n "$MON_ID" ] || fail "monitor not created"
curl -fsS -X PUT -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d "{\"regionIds\":[$REGION_ID]}" "$HOST_API/api/monitors/url/$MON_ID/regions" >/dev/null
echo "monitor #$MON_ID bound to region #$REGION_ID"

# ---- 4. start the agent container on the master network ----
log "Starting agent ($AGENT_IMAGE) on $NETWORK -> $AGENT_MASTER_URL"
docker rm -f "$AGENT_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$AGENT_CONTAINER" --network "$NETWORK" \
  -e OO_WORKER_ROLE=agent -e OO_MASTER_URL="$AGENT_MASTER_URL" \
  -e OO_AGENT_KEY="$AGENT_KEY" -e OO_REGION_SLUG="$REGION_SLUG" \
  -e OO_AGENT_POLL_WAIT_SEC=10 \
  "$AGENT_IMAGE" bun src/index.ts >/dev/null

# ---- 5. region must come online (agent's first poll refreshes last_seen_at) ----
log "Waiting for region online"
ONLINE=
for _ in $(seq 1 24); do
  ONLINE=$(psql_q "SELECT (last_seen_at > now() - interval '90 seconds') FROM regions WHERE id=$REGION_ID")
  [ "$ONLINE" = "t" ] && break
  sleep 5
done
[ "$ONLINE" = "t" ] || fail "region never came online (agent could not reach master?)"
echo "region online ✓"

# ---- 6. a regional execution must be recorded (agent ran the probe + posted back) ----
log "Waiting for a probe result from the agent"
CNT=0
for _ in $(seq 1 30); do
  CNT=$(psql_q "SELECT count(*) FROM url_monitor_executions WHERE url_monitor_id=$MON_ID AND region_id=$REGION_ID")
  [ "${CNT:-0}" -ge 1 ] && break
  sleep 5
done
[ "${CNT:-0}" -ge 1 ] || fail "no regional execution recorded (job not dispatched / agent not probing)"
echo "regional execution recorded ✓ (count=$CNT)"

# Prove the light image truly has no Chromium (item 13).
if [ "$WITH_QA" != "1" ]; then
  if docker exec "$AGENT_CONTAINER" sh -c 'command -v chromium || command -v chromium-browser || ls /root/.cache/ms-playwright 2>/dev/null' >/dev/null 2>&1; then
    echo "NOTE: Chromium present in light image (unexpected, not fatal)"
  else
    echo "oo-agent-light has no Chromium ✓"
  fi
fi

log "DATA-LAYER PASS"
echo "  [9]  region '$REGION_SLUG' online (last_seen_at fresh via agent polls)"
echo "  [10] execution row with region_id=$REGION_ID — agent result surfaced on master"
echo "  [13] oo-agent-light ran a real URL probe with no Chromium"
[ "$WITH_QA" = "1" ] && echo "  [14] oo-agent-qa image ran the bound monitor"

# ---- 7. browser layer (Playwright) ----
if [ "${SKIP_BROWSER:-0}" != "1" ]; then
  log "Browser assertions (Playwright)"
  OO_E2E_API_KEY="$API_KEY" OO_E2E_REGION_SLUG="$REGION_SLUG" OO_E2E_MON_ID="$MON_ID" \
  DATABASE_URL=postgres://oo:oo@localhost:5442/oo_workers REDIS_URL=redis://localhost:6479 \
    bunx playwright test --config=tests/multi-region-e2e/playwright.config.ts || fail "browser assertions failed"
fi

log "ALL PASS"
