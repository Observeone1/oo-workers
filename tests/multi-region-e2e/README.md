# Multi-region end-to-end harness

A **one-off, operator/LLM-run** harness that stands up a *real* regional agent
container against the locally-running master stack and proves the multi-region
path end to end. It is **not wired into CI** — it needs Docker, the running
`docker compose` master stack, and ~30–90s of live agent polling.

## Why this exists

The unit and integration tests all run **single-process**, so they can never
exercise the actual deployed multi-region topology:

- region-bound monitor jobs are pushed to a **per-region Redis list**
  (`src/scheduler.ts`), not the BullMQ queue;
- a separate **agent process** (`OO_WORKER_ROLE=agent`, `src/agent.ts`)
  long-polls `GET /api/agent/jobs`, runs the probe locally with **no master
  DB/Redis access**, and posts the result to `POST /api/agent/results`;
- the master records it with the agent's `region_id` and the dashboard surfaces
  it live.

This harness is the only thing that drives that whole chain with a genuine
second container. (The same `feedback_passed_ci_is_not_tested` lesson that bit
the SSE bridge: green single-process CI ≠ the deployed shape works.)

## What it asserts

| Item | Proven | How |
|------|--------|-----|
| **9 — region online** | ✅ | agent's first poll refreshes `regions.last_seen_at`; asserted at the DB layer **and** in the browser (regions page card + navbar badge) |
| **10 — multi-region result on master** | ✅ | a `url_monitor_executions` row with `region_id` set (the agent's posted result); asserted at the DB layer **and** on the monitor detail view |
| **13 — `oo-agent-light` runs probes, no Chromium** | ✅ | the light image runs a real URL probe; harness also checks no Chromium is present in the container |
| **14 — `oo-agent-qa`** | ⚠️ partial | `WITH_QA=1` swaps to the qa image and confirms it boots + runs the agent loop, but does **not** yet exercise a real Playwright QA browser check (that needs a QA project + script bound to the region — a documented TODO below) |

## Prerequisites

- The master stack running locally: `docker compose up -d` (ui on `localhost:3010`, network `oo-workers_default`).
- Docker (the harness builds the agent image from source via `--target agent-light`).
- `bun` + Playwright browsers installed (`bunx playwright install chromium`) for the browser layer.

## Run it

```bash
# Default: light image, items 9/10/13, data + browser layers, auto-teardown
bash tests/multi-region-e2e/run.sh

# Useful knobs:
KEEP=1          bash tests/multi-region-e2e/run.sh   # leave region/monitor/agent up to inspect
SKIP_BROWSER=1  bash tests/multi-region-e2e/run.sh   # data layer only (no Playwright)
WITH_QA=1       bash tests/multi-region-e2e/run.sh   # use oo-agent-qa (~3.5GB build), item 14 (partial)
REBUILD=1       bash tests/multi-region-e2e/run.sh   # force-rebuild the agent image from current source
OO_E2E_API_KEY=oo_… bash tests/multi-region-e2e/run.sh   # reuse a key instead of minting one
```

Expected tail on success: `DATA-LAYER PASS`, then `3 passed` (Playwright), then `ALL PASS`.

## How it works (step by step)

1. Preconditions: master reachable at `localhost:3010`, network `oo-workers_default` exists.
2. Mint an admin API key (`scripts/create-api-key.ts`) unless `OO_E2E_API_KEY` is set.
3. Build the agent image from current source (`docker build --target agent-light`).
4. (Re)create region `e2e-mr` via `scripts/create-region.ts` — parses the printed `OO_AGENT_KEY`.
5. Create a URL monitor and bind it to the region (`PUT /api/monitors/url/:id/regions`).
6. `docker run` the agent on `oo-workers_default`, pointed at `http://ui:3001` (in-network) with the minted key.
7. Poll the DB until the region is online (`last_seen_at` fresh).
8. Poll the DB until a `url_monitor_executions` row with the region's `region_id` appears.
9. Run the Playwright spec (`multi-region.e2e.spec.ts`) for the browser-visible confirmation.
10. Teardown (unless `KEEP=1`): remove the agent container, delete the monitor and region.

## Files

- `run.sh` — the orchestrator + data-layer assertions.
- `multi-region.e2e.spec.ts` — browser-layer assertions (region online, regional run on detail).
- `playwright.config.ts` — extends the root UI config (`baseURL`, `OO_E2E_API_KEY` bearer auth), re-points `testDir` here.

## Notes for a future run (operator or LLM)

- Networking: the agent reaches the master at `http://ui:3001` because it joins
  `oo-workers_default`. If the master compose project is renamed, override
  `OO_MASTER_NETWORK`. From the host, the script talks to `localhost:3010`.
- Idempotent: it deletes any existing `e2e-mr` region before recreating, so
  reruns are clean. A crashed run leaves an `oo-agent-e2e` container — the next
  run force-removes it.
- The real machinery it leans on (verify these still exist before trusting it):
  `scripts/create-region.ts`, `scripts/create-api-key.ts`, `src/agent.ts`,
  `src/routes/agent.ts` (`/api/agent/jobs`, `/api/agent/results`),
  `src/scheduler.ts` (regional Redis-list dispatch), `docker-compose.agent.yml`.

### TODO — fully close item 14

`WITH_QA=1` proves the qa image *boots and probes*, but a true QA browser-check
assertion needs: create a QA project (`POST /api/monitors/qa`), attach a small
Playwright test script, bind it to the region, then assert a `qa` execution with
`region_id` is recorded. Left out for now to keep the default run fast and
because it requires a script fixture.
