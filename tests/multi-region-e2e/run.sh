#!/usr/bin/env bash
#
# Multi-region end-to-end harness.
#
# Stands up the REAL published dedicated agent images against the locally-running
# master stack and proves the full multi-region path that no unit/integration
# test can (those run single-process): a region-bound job is dispatched to the
# agent over HTTP long-poll, the agent runs the work locally with no master
# DB/Redis access, posts the result back, and the master surfaces it.
#
# Both dedicated images are first-class, run as explicit cases — no env toggles:
#
#   bash tests/multi-region-e2e/run.sh          # BOTH: oo-agent-light + oo-agent-qa
#   bash tests/multi-region-e2e/run.sh light     # just oo-agent-light  (URL probe)
#   bash tests/multi-region-e2e/run.sh qa         # just oo-agent-qa    (real Playwright QA check)
#
# Each case pulls its published image from Docker Hub and runs THAT artifact.
# The qa image is ~3.5 GB — the first `qa`/both run pulls it.
#
# One-off, operator/LLM-run — NOT wired into CI. See README.md.
#
set -euo pipefail
cd "$(dirname "$0")/../.."

WHICH="${1:-both}"
case "$WHICH" in light | qa | both) ;; *) echo "usage: run.sh [light|qa|both]"; exit 2 ;; esac

HOST_API="${OO_MASTER_HOST:-http://localhost:3010}"       # script -> master, from host
AGENT_MASTER_URL="${OO_AGENT_MASTER_URL:-http://ui:3001}" # agent container -> master, in-network
NETWORK="${OO_MASTER_NETWORK:-oo-workers_default}"
LIGHT_IMAGE="observeone/oo-agent-light:${OO_AGENT_TAG:-latest}"
QA_IMAGE="observeone/oo-agent-qa:${OO_AGENT_TAG:-latest}"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok() { printf '   \033[1;32m✓ %s\033[0m\n' "$*"; }
fail() {
  printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2
  exit 1
}
psql_q() { docker compose exec -T postgres psql -U oo -d oo_workers -tAc "$1" | tr -d '[:space:]'; }
apidel() { curl -fsS -X DELETE -H "Authorization: Bearer $API_KEY" "$1" >/dev/null 2>&1 || true; }
apipost() { curl -fsS -X POST -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' -d "$2" "$1" >/dev/null; }
apiput() { curl -fsS -X PUT -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' -d "$2" "$1" >/dev/null; }

CONTAINERS=()
REGION_IDS=()
cleanup() {
  log "Teardown"
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  [ -n "${LIGHT_MON:-}" ] && apidel "$HOST_API/api/monitors/url/$LIGHT_MON"
  [ -n "${QA_MON:-}" ] && apidel "$HOST_API/api/monitors/qa/$QA_MON"
  for r in "${REGION_IDS[@]:-}"; do [ -n "$r" ] && apidel "$HOST_API/api/regions/$r"; done
  echo "removed agent containers, e2e monitors, and e2e regions"
}
trap cleanup EXIT

# ---- preconditions + API key ----
log "Checking master stack + network"
curl -fsS "$HOST_API/" -o /dev/null || fail "master not reachable at $HOST_API (is the stack up?)"
docker network inspect "$NETWORK" >/dev/null 2>&1 || fail "docker network '$NETWORK' not found"
if [ -n "${OO_E2E_API_KEY:-}" ]; then
  API_KEY="$OO_E2E_API_KEY"
else
  API_KEY=$(docker compose exec -T worker bun scripts/create-api-key.ts --name mr-e2e 2>/dev/null | grep -oE 'oo_[A-Za-z0-9_-]+' | tail -1)
fi
[ -n "${API_KEY:-}" ] || fail "no API key"

# Start a region + agent for a case. $1=variant $2=image. Sets REGION_ID/SLUG/CONTAINER.
start_agent() {
  local variant="$1" image="$2"
  SLUG="e2e-mr-$variant"
  CONTAINER="oo-agent-e2e-$variant"

  # Default: pull the published artifact (the whole point of this harness — see
  # README). Opt-in OO_AGENT_USE_LOCAL=1 uses a locally-built image instead, to
  # validate a slim/candidate build BEFORE it is published. Without the opt-in we
  # always pull, so a stale same-tagged local image can never silently shadow the
  # real published one.
  if [ "${OO_AGENT_USE_LOCAL:-0}" = "1" ] && docker image inspect "$image" >/dev/null 2>&1; then
    log "[$variant] Using local image $image (OO_AGENT_USE_LOCAL=1, skipping pull)"
  else
    log "[$variant] Pulling $image"
    docker pull "$image" >/dev/null || fail "could not pull $image"
  fi

  log "[$variant] Creating region '$SLUG'"
  local exist
  exist=$(psql_q "SELECT id FROM regions WHERE slug='$SLUG'")
  [ -n "$exist" ] && apidel "$HOST_API/api/regions/$exist"
  local out
  out=$(docker compose exec -T worker bun scripts/create-region.ts --slug "$SLUG" --label "MR E2E $variant")
  AGENT_KEY=$(echo "$out" | grep -oE 'OO_AGENT_KEY=[A-Za-z0-9_-]+' | cut -d= -f2)
  REGION_ID=$(psql_q "SELECT id FROM regions WHERE slug='$SLUG'")
  [ -n "$AGENT_KEY" ] && [ -n "$REGION_ID" ] || {
    echo "$out"
    fail "[$variant] region/key creation failed"
  }
  REGION_IDS+=("$REGION_ID")

  log "[$variant] Starting agent ($image) on $NETWORK -> $AGENT_MASTER_URL"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --network "$NETWORK" \
    -e OO_WORKER_ROLE=agent -e OO_MASTER_URL="$AGENT_MASTER_URL" \
    -e OO_AGENT_KEY="$AGENT_KEY" -e OO_REGION_SLUG="$SLUG" -e OO_AGENT_POLL_WAIT_SEC=10 \
    "$image" bun src/index.ts >/dev/null
  CONTAINERS+=("$CONTAINER")

  log "[$variant] Waiting for region online"
  local online=
  for _ in $(seq 1 24); do
    online=$(psql_q "SELECT (last_seen_at > now() - interval '90 seconds') FROM regions WHERE id=$REGION_ID")
    [ "$online" = "t" ] && break
    sleep 5
  done
  [ "$online" = "t" ] || {
    docker logs "$CONTAINER" 2>&1 | tail -20
    fail "[$variant] region never came online"
  }
  ok "region '$SLUG' online (item 9)"
}

run_browser() {
  log "[$1] Browser assertions"
  OO_E2E_API_KEY="$API_KEY" OO_E2E_REGION_SLUG="e2e-mr-$1" OO_E2E_MON_ID="${2:-}" OO_E2E_MON_TYPE="${3:-}" \
    DATABASE_URL=postgres://oo:oo@localhost:5442/oo_workers REDIS_URL=redis://localhost:6479 \
    bunx playwright test --config=tests/multi-region-e2e/playwright.config.ts || fail "[$1] browser assertions failed"
}

# ============================ LIGHT ============================
if [ "$WHICH" = "light" ] || [ "$WHICH" = "both" ]; then
  start_agent light "$LIGHT_IMAGE"
  log "[light] Creating URL monitor + binding to region"
  apipost "$HOST_API/api/monitors/url" '{"name":"mr-e2e-light","url":"https://example.com","intervalSeconds":30,"assertions":[{"operator":"equals","statusCode":200}]}'
  LIGHT_MON=$(psql_q "SELECT id FROM url_monitors WHERE name='mr-e2e-light' ORDER BY id DESC LIMIT 1")
  apiput "$HOST_API/api/monitors/url/$LIGHT_MON/regions" "{\"regionIds\":[$REGION_ID]}"
  log "[light] Waiting for a URL probe result from the agent"
  cnt=0
  for _ in $(seq 1 30); do
    cnt=$(psql_q "SELECT count(*) FROM url_monitor_executions WHERE url_monitor_id=$LIGHT_MON AND region_id=$REGION_ID")
    [ "${cnt:-0}" -ge 1 ] && break
    sleep 5
  done
  [ "${cnt:-0}" -ge 1 ] || {
    docker logs "oo-agent-e2e-light" 2>&1 | tail -20
    fail "[light] no regional URL execution"
  }
  ok "regional URL execution recorded (item 10)"
  if docker exec oo-agent-e2e-light sh -c 'command -v chromium || command -v chromium-browser || ls /root/.cache/ms-playwright' >/dev/null 2>&1; then
    echo "   NOTE: Chromium present in light image (unexpected)"
  else
    ok "oo-agent-light has NO Chromium (item 13)"
  fi
  run_browser light "$LIGHT_MON" url
fi

# ============================= QA ==============================
if [ "$WHICH" = "qa" ] || [ "$WHICH" = "both" ]; then
  start_agent qa "$QA_IMAGE"
  log "[qa] Creating QA project (real Playwright script) + binding to region"
  QA_SCRIPT=$'import { test, expect } from \'@playwright/test\';\ntest(\'mr e2e qa check\', async ({ page }) => {\n  await page.goto(\'https://example.com\');\n  await expect(page.locator(\'h1\')).toBeVisible();\n});\n'
  # JSON-encode the script via the shell -> python-free: escape backslash, quote, newline.
  QA_JSON=$(printf '%s' "$QA_SCRIPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}')
  apipost "$HOST_API/api/monitors/qa" "{\"name\":\"mr-e2e-qa\",\"targetUrl\":\"https://example.com\",\"tests\":[{\"name\":\"loads-h1\",\"script\":\"$QA_JSON\"}]}"
  QA_MON=$(psql_q "SELECT id FROM qa_projects WHERE name='mr-e2e-qa' ORDER BY id DESC LIMIT 1")
  [ -n "$QA_MON" ] || fail "[qa] QA project not created"
  apiput "$HOST_API/api/monitors/qa/$QA_MON/regions" "{\"regionIds\":[$REGION_ID]}"
  log "[qa] Waiting for the QA browser-check to RUN TO COMPLETION (Playwright ~10-40s)"
  status=
  for _ in $(seq 1 48); do
    status=$(psql_q "SELECT status FROM qa_test_executions WHERE project_id=$QA_MON AND region_id=$REGION_ID ORDER BY id DESC LIMIT 1")
    case "$status" in SUCCESS | FAILED) break ;; esac
    sleep 5
  done
  case "$status" in
    SUCCESS) ok "regional QA browser-check COMPLETED status=SUCCESS — oo-agent-qa ran Playwright to a passing terminal state (item 14)" ;;
    FAILED) ok "regional QA browser-check COMPLETED status=FAILED — agent ran Playwright to completion (script asserts h1 on example.com; investigate if unexpected) (item 14)" ;;
    *)
      docker logs "oo-agent-e2e-qa" 2>&1 | tail -25
      fail "[qa] QA execution never reached a terminal status (got '${status:-none}') — qa image did not complete the browser check"
      ;;
  esac
  run_browser qa "" qa
fi

log "ALL PASS ($WHICH)"
