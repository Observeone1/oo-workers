# Multi-region end-to-end harness

A **one-off, operator/LLM-run** harness that runs the **real published dedicated
agent images** against the locally-running master stack and proves the
multi-region path end to end. It is **not wired into CI** — it needs Docker, the
running `docker compose` master stack, network access to Docker Hub, and ~30–90s
of live agent polling (plus a ~3.5 GB pull for the qa image on first run).

## Why this exists

The unit and integration tests all run **single-process**, so they can never
exercise the actual deployed multi-region topology:

- region-bound monitor jobs are pushed to a **per-region Redis list**
  (`src/scheduler.ts`), not the BullMQ queue;
- a separate **agent process** (`OO_WORKER_ROLE=agent`, `src/agent.ts`)
  long-polls `GET /api/agent/jobs`, runs the work locally with **no master
  DB/Redis access**, and posts results to `POST /api/agent/results` (URL/API/…)
  or `POST /api/agent/qa/executions` (QA);
- the master records it with the agent's `region_id` and surfaces it live.

This harness is the only thing that drives that whole chain with the genuine
second container — and it runs the **actual images CD published**, not a local
rebuild. (Same `feedback_passed_ci_is_not_tested` lesson that bit the SSE bridge:
green single-process CI ≠ the deployed shape works.)

## Run it

Both dedicated images are first-class, selected by a positional arg — **no env
toggles**:

```bash
bash tests/multi-region-e2e/run.sh          # BOTH images
bash tests/multi-region-e2e/run.sh light     # just oo-agent-light  (URL probe)
bash tests/multi-region-e2e/run.sh qa         # just oo-agent-qa    (real Playwright QA check)
```

Each case `docker pull`s its published image and runs **that artifact**. Optional
overrides (sensible defaults, not required): `OO_AGENT_TAG` (default `latest`),
`OO_MASTER_HOST`, `OO_MASTER_NETWORK`, `OO_E2E_API_KEY` (reuse a key instead of
minting one).

## What it asserts

| Item | Image | Proven | How |
|------|-------|--------|-----|
| **9 — region online** | both | ✅ | agent's first poll refreshes `regions.last_seen_at`; asserted at the DB layer **and** in the browser (regions card + navbar badge) |
| **10 — multi-region result on master** | light | ✅ | a `url_monitor_executions` row with `region_id` set; asserted at the DB layer **and** on the monitor detail view |
| **13 — `oo-agent-light` runs probes, no Chromium** | light | ✅ | the published light image runs a real URL probe; harness checks no Chromium is present in the container |
| **14 — `oo-agent-qa` runs QA browser checks** | qa | ✅ | a real Playwright script (goto + assert `h1`) bound to the region; harness waits for a `qa_test_executions` row with `region_id` to reach a **terminal** status (`SUCCESS`/`FAILED`), proving the qa image ran the browser check to completion — not just dispatched it |

## Prerequisites

- Master stack running locally: `docker compose up -d` (ui on `localhost:3010`, network `oo-workers_default`).
- Docker + Docker Hub access (the harness pulls `observeone/oo-agent-light` and `observeone/oo-agent-qa`).
- `bun` + Playwright browsers (`bunx playwright install chromium`) for the browser-layer assertions.

## How it works (per case)

1. Preconditions: master reachable, network exists, mint an admin API key (unless `OO_E2E_API_KEY` set).
2. `docker pull` the published image for this case.
3. (Re)create region `e2e-mr-<variant>` via `scripts/create-region.ts` — parse the printed `OO_AGENT_KEY`.
4. **light:** create a URL monitor; **qa:** create a QA project with a real Playwright test script. Bind it to the region (`PUT /api/monitors/<type>/:id/regions`).
5. `docker run` the agent on `oo-workers_default`, pointed at `http://ui:3001`, with the minted key.
6. Poll the DB until the region is online, then until the regional execution appears (URL row, or QA row at a terminal status).
7. Run `multi-region.e2e.spec.ts` for the browser-visible confirmation (region online; URL detail view for the light case).
8. Teardown: remove the agent container, the monitor, and the region.

## Files

- `run.sh` — orchestrator + data-layer assertions; `light` / `qa` / `both` cases.
- `multi-region.e2e.spec.ts` — browser-layer assertions (region card online, navbar badge, URL detail surfaces the regional run).
- `playwright.config.ts` — extends the root UI config (`baseURL`, `OO_E2E_API_KEY` bearer auth), re-points `testDir` here.

## Notes for a future run (operator or LLM)

- Networking: the agent reaches the master at `http://ui:3001` because it joins
  `oo-workers_default`. From the host, the script talks to `localhost:3010`.
- Idempotent: deletes any existing `e2e-mr-<variant>` region before recreating;
  force-removes a stale `oo-agent-e2e-<variant>` container.
- The images are the published artifacts — if a publish is stale, re-run CD
  first, or set `OO_AGENT_TAG` to a specific version.
- Real machinery it leans on (verify these still exist before trusting it):
  `scripts/create-region.ts`, `scripts/create-api-key.ts`, `src/agent.ts`,
  `src/routes/agent.ts` (`/api/agent/jobs`, `/api/agent/results`,
  `/api/agent/qa/executions`), `src/scheduler.ts` (regional Redis-list dispatch),
  `docker-compose.agent.yml`.
