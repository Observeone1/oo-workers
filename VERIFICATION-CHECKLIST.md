# oo-workers manual verification checklist (v1.26.0 → v1.28.1)

Living tracker for the live-update (SSE), Docker-image, and docs work shipped
across v1.26.0–v1.28.1. Replaces the ad-hoc 7-item list — that one was a
summary and missed several behaviors.

Legend: ✅ confirmed live in a browser · 🟡 covered by a green automated test, not eyeballed · ⬜ not verified

## SSE live updates (v1.26.0–v1.26.1, bridge fix v1.28.1)

| #   | Behavior                                                         | Status | Notes                                                                                   |
| --- | ---------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 1   | List view — new row appears live on create elsewhere             | ✅     | split-view, no refresh                                                                  |
| 2   | List view — status/latency updates live when a master check runs | ✅     | was broken since v1.26.0 (list never subscribed to execution); fixed v1.28.2; confirmed |
| 3   | List view — no idle flicker (old 5s repaint gone)                | ✅     | confirmed                                                                               |
| 4   | List view — row removed live on delete elsewhere                 | 🟡     | e2e 4/4, not eyeballed                                                                  |
| 5   | Detail view — new run appears live                               | ✅     | confirmed (always worked — detail subscribes to execution)                              |
| 6   | Detail view — bounces to list on delete elsewhere                | 🟡     | e2e green                                                                               |
| 7   | Heartbeat — flips UP live on first ping                          | ✅     | ping path (ui process) always worked                                                    |
| 8   | Heartbeat — flips OVERDUE live on miss                           | ✅     | the v1.28.1 fix; confirmed + e2e green                                                  |
| 9   | Region badge — online/offline flips live                         | ✅     | proven by `tests/multi-region-e2e` harness — real agent, region online (DB + browser)   |
| 10  | Multi-region — agent probe result appears live on master         | ✅     | proven by harness — regional execution row + detail view shows the run                  |
| 11  | SSE stream pauses when tab hidden, resumes on focus              | ✅     | confirmed via DevTools — connection closes on hide, new one opens on return             |
| 12  | Relative timestamps advance without refresh, no flicker          | ✅     | text-only 5s tick (fixed today)                                                         |

## Docker images (v1.27.0)

| #   | Behavior                                                | Status | Notes                                                                            |
| --- | ------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| 13  | `oo-agent-light` runs probes without Chromium (~360 MB) | ✅     | proven by harness — light image ran a real URL probe, no Chromium present        |
| 14  | `oo-agent-qa` runs QA browser checks                    | 🟡     | `WITH_QA=1` boots the qa image + probes; full QA-check path is a documented TODO |

## Docs (v1.28.0)

| #   | Behavior                                            | Status | Notes                                                               |
| --- | --------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| 15  | `/docs` redirects to `/#/docs` (lands in SPA shell) | 🟡     | server-verified (302), not eyeballed                                |
| 16  | `?`-hint anchors resolve to the right docs section  | 🟡     | server-verified anchors                                             |
| 17  | ~~In-app docs `#cli` + `#resources` (CLI-first)~~   | ❌     | FABRICATED — obs CLI doesn't manage oo-workers; reverted in v1.28.3 |
| 18  | ~~Repo `docs/*.md` "Using the CLI" blocks~~         | ❌     | FABRICATED — reverted in v1.28.3; docs back to dashboard/API        |

## Release status

- **v1.28.1** — shipped. SSE cross-process bridge + timestamp flicker fix (PR #100).
- **v1.28.2** — shipped. List view reacts to check runs live (PR #102).
- **v1.28.3** — shipped. Reverted fabricated CLI docs from v1.28.0 (PR #103).

## What's left

- **14 (partial)** — `oo-agent-qa` boots + probes via `tests/multi-region-e2e` `WITH_QA=1`; the full QA browser-check path is a documented TODO in that harness's README.
- **4, 6, 15, 16 (🟡)** — green in automated tests, just never hand-eyeballed; low value.
- Everything else (1–3, 5, 7–13) is ✅ confirmed; 17/18 were fabricated and reverted.
