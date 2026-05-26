# Changelog

All notable changes to this project will be documented in this file.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Docker Hub publishes every `v*` tag as `:<version>`, `:<major>.<minor>`, and `:latest`.

## [1.25.0] - 2026-05-26

### Changed (behavior change)

- **All `/api/*` endpoints now require authentication.** Previously, `GET` on `/api/monitors`, `/api/channels`, `/api/regions`, `/api/status-pages`, `/api/availability` (and a few others) returned full operator config to anyone who could reach the dashboard port. For a self-host product whose value is "monitor my private services," that's the wrong default — the moment the UI is bound to a public IP, the inventory leaks. Now every `/api/*` path requires either a Bearer API key or a dashboard session cookie. ([#83])

  **Public surfaces left intentionally unauthed:**
  - `GET /status/<slug>` — public status pages (operators curate which monitors appear)
  - `POST /heartbeat/:token` — heartbeat ingest (the token is the auth)
  - Static UI assets, `/api/auth/setup-status`, login/setup bootstrap endpoints

  **Impact on existing scripts.** Anyone scripting against the previously-public reads (e.g. a Grafana scraper hitting `/api/monitors` without a key) will get 401 after upgrading. The fix is one line: add `-H "Authorization: Bearer oo_..."`. The previous behavior was a description in the README, not a documented API contract.

### Internal

- `requireAuth('read')` is now wired in `server.ts` as `methodScoped` middleware. Read endpoints accept both `read` and `write` scopes (write implies read).

[#83]: https://github.com/Observeone1/oo-workers/pull/83

---

## [1.24.2] - 2026-05-26

### Added

- **Favicon** — `src/ui/favicon.svg` matches the in-app brand-mark (rounded green square with a dark inner square). Wired through `build:ui`, served at `/favicon.svg`, linked from `index.html` and `docs.html`. Replaces the browser's default globe icon. ([#81])

### Fixed

- **`scripts/setup.sh` next-steps hint** — the printed instructions used to tell first-time operators to paste an API key into the login screen, which predates the v1.3.0 email/password wizard. Now points to `http://localhost:3001` for the wizard, with a separate hint for the programmatic API-key path. ([#81])
- **README** — version examples in §Releases bumped from `:1.6.0` to `:1.24.1` so the snippet reflects current state. ([#81])

### CI / infra

- **Integration tests now gate every PR.** New `integration` job in `ci.yml` runs `bun run test:integration` (testcontainers Postgres + Redis, ~90s). Would have caught the v1.24.0 colon-count regression. ([#81])
- **`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`** set on `ci.yml` and `cd.yml`. GitHub flips this default on 2026-06-02; setting it now keeps behaviour identical across the cutover. ([#81])

[#81]: https://github.com/Observeone1/oo-workers/pull/81

---

## [1.24.1] - 2026-05-26

### Fixed

- **CRITICAL: scheduler tick broken on master path in v1.24.0.** The boot-nonce work (#79) joined `:${BOOT_NONCE}` onto the job ID, producing 4 colon-separated segments. BullMQ rejects custom IDs containing `:` unless they split into exactly 3 parts — so every master-path `queue.add()` threw `Custom Id cannot contain :`, the scheduler caught it, and no monitor was ever dispatched. Fresh installs of `:latest` showed every monitor stuck PENDING. Fix: switch the nonce separator from `:` to `-`. New format `url:${id}:${bucket}-${nonce}-r${regionId}` keeps the per-boot uniqueness but stays at 2 colons. Unit spec now asserts `colon count === 2` as an explicit regression guard. ([#83])

### Test gap

The `scheduler.it.spec.ts` integration test would have caught this — it inserts a real monitor row, runs the actual scheduler, and expects executions to flip to SUCCESS. It didn't catch it because **CI doesn't run the integration suite**, only typecheck/lint/format/knip. Adding integration tests to CI gating is queued as a follow-up — out of scope for this hotfix.

---

## [1.24.0] - 2026-05-25

### Added

- **Edit monitors** — pencil icon on every list row and an _Edit_ button on the detail page open the add-monitor dialog pre-populated with the existing values. Submit updates in place; the list refreshes and the detail page reloads with the new data. All eight monitor types supported. ([#79])

### Fixed

- **API key revoke hardening** — `validateKey()` now checks `revokedAt` on every cache hit. If a row was written with `revokedAt: null` and was later revoked before its 30 s TTL expired, the eviction that fires on revoke ensures the entry is gone; this second check closes any theoretical race window. ([#79])
- **Monitor name placeholder per type** — the name input in the add-monitor dialog now shows a type-appropriate placeholder ("My website" for URL, "Payment API" for API, "Postgres 5432" for TCP, etc.) instead of always showing "API gateway". ([#79])
- **Dialog scroll reset** — the add-monitor dialog now reliably opens at the top. The `scrollTop = 0` reset was moved to after `showModal()` inside `requestAnimationFrame` so the browser layout pass no longer undoes it. ([#79])
- **Stale PENDING on status pages** — a PENDING execution older than 2× the monitor's `interval_seconds` now shows as _down_ (not _unknown_) on public status pages, matching the existing projection behaviour on the admin detail page. ([#79])
- **BullMQ startup drain** — all seven queues are drained (waiting jobs removed) before the first scheduler tick on every restart. Without this, stale job IDs from a previous boot would permanently block re-enqueue of the same monitors via BullMQ's dedup key. ([#79])
- **BullMQ boot nonce** — every job ID now includes a 4-char random boot nonce as a fourth colon-separated segment (`url:1:28975612:ab3f`). Even when two boots land in the same wall-clock minute bucket, their IDs never collide and dedup never silently skips a dispatch. ([#79])

### Tests

- `src/scheduler.unit.spec.ts` — pure unit tests for nonce format and job ID structure (no DB required).
- `tests/integration/scheduler-drain.it.spec.ts` — pre-seeds stale jobs, starts the scheduler, asserts the IDs are gone post-drain.
- `tests/ui/edit-monitor.e2e.spec.ts` — Playwright e2e for both edit paths (list-row pencil and detail-page Edit button).

[#79]: https://github.com/Observeone1/oo-workers/pull/79

---

## [1.23.0] - 2026-05-21

### Code-quality + correctness pass (audit cleanup, 2026-05-21)

Three-pass audit recorded at `observeone-context/audit/2026-05-21-*.md`. Findings shipped across 14 PRs merged to main on the same day.

#### Fixed

- **`restoreTar` artifact memory** - multi-GB `.oodump.tar.gz` restores no longer OOM the worker. Artifacts now stream entry-by-entry: meta + dump buffered, then each artifact body uploaded to S3 and discarded before reading the next tar entry. Memory ceiling drops from `dump + sum(all artifacts)` to `max(dump, single largest artifact)`. ([#57])
- **`/api/import` atomicity** - bulk import now runs inside a single `db.transaction`. A mid-import crash (process kill, OOM, dropped DB connection) rolls back cleanly; operators can re-run without manually unwinding partial state. ([#58])
- **Heartbeat ingest hardening** - `POST /heartbeat/:token` debounces sub-second pings (a leaked token can no longer flood the DB with SELECT+UPDATE pairs), disabled heartbeats look identical to unknown tokens (no info disclosure), and `GET /heartbeat/:token` is read-only (Slack/iMessage/Discord pre-fetch no longer triggers pings). ([#56])
- **`tcp-probe` banner accumulation** - multi-packet SMTP/IMAP banners no longer FAIL on the first chunk. The probe now waits until the buffer either contains the expected string, hits the 256B cap without matching, or the socket times out. ([#55])
- **List query bounds** - `incidentRepo.listForPage`, `statusPageRepo.list`, and `apiKeyRepo.list` cap at 500 rows. A long-lived public status page that accumulates incidents no longer OOMs the listing endpoint. ([#59])
- **Scheduler tick-failure surfacing** - a persistent DB or Redis outage used to log one error per tick and let operators discover hours later that no monitor had been dispatched. New per-tick counter + escalating `🚨 SCHEDULER STALLED` log at 3, 6, 12, ... consecutive failures, plus a recovery log on the first green tick. ([#61])
- **Channel-ref dedup on import** - a malformed export bundle with duplicate `channelRefs` no longer aborts the whole `/api/import` transaction via composite-PK violation. ([#58])

#### Changed

- **`server.ts` split into per-resource routes** - 1769 lines → 150-line orchestrator + 14 `src/routes/*.ts` files (auth, api-keys, artifacts, monitors, import, backup, regions, channels, status-pages, incidents, heartbeat-public, status-public, agent, static-ui). Handlers moved verbatim. ([#64])
- **`settings.ts` split into per-section** - 874 → 145-line rail + router + `src/ui/settings/{profile,security,api-keys,backup}.ts`. ([#65])
- **`backup.ts` split into export/restore/shared** - 713 → 39-line re-export shim + `backup-shared.ts` (types + `TABLES`) + `backup-export.ts` (export streamers) + `backup-restore.ts` (restore reader). ([#66])
- **`dialogs.ts` split** - 567 → 117-line primitives only + `dialogs/{add-monitor-dialog,import-dialog}.ts`. ([#67])
- **`incidents.ts` split** - 529 → 73-line router + `incidents/{state,list,editor}.ts`. ([#68])
- **`findAllWithLatest` factored** - 7 monitor repos (url, api, tcp, udp, db, tls, qa) now share `_with-latest.ts:projectLatest()` for the staleness-projected `latest` shape. The SQL stays inline per repo. ([#54])
- **`/api/import` refactored** - extracted from a 320-line wall in `server.ts` to a per-type adapter layer in `services/import.ts`. ([#58])
- **Test convention** - replaced `await page.waitForTimeout(200)` in `heartbeat.e2e.spec.ts` with a deterministic `getByTestId('add-monitor-regions-row').toBeHidden()` assertion. ([#63])

#### Docs

- README: added "QA scripts run with the worker's env" warning under Security & deployment. Operators should not accept QA test scripts from untrusted sources without a sandboxed runner - the script inherits the worker process's full env. ([#60])

#### Hygiene

- Em-dash sweep on operator-facing prose in `src/ui/settings.ts`, `regions.ts`, `detail.ts`. Single-char `'—'` placeholders for missing values were intentionally left. ([#62])

[#54]: https://github.com/Observeone1/oo-workers/pull/54
[#55]: https://github.com/Observeone1/oo-workers/pull/55
[#56]: https://github.com/Observeone1/oo-workers/pull/56
[#57]: https://github.com/Observeone1/oo-workers/pull/57
[#58]: https://github.com/Observeone1/oo-workers/pull/58
[#59]: https://github.com/Observeone1/oo-workers/pull/59
[#60]: https://github.com/Observeone1/oo-workers/pull/60
[#61]: https://github.com/Observeone1/oo-workers/pull/61
[#62]: https://github.com/Observeone1/oo-workers/pull/62
[#63]: https://github.com/Observeone1/oo-workers/pull/63
[#64]: https://github.com/Observeone1/oo-workers/pull/64
[#65]: https://github.com/Observeone1/oo-workers/pull/65
[#66]: https://github.com/Observeone1/oo-workers/pull/66
[#67]: https://github.com/Observeone1/oo-workers/pull/67
[#68]: https://github.com/Observeone1/oo-workers/pull/68

## [1.22.0] - 2026-05-21

Heartbeat monitors now migrate from a SaaS export with their ping URL preserved. `/api/import` ingests a `heartbeats` block; the SaaS adapter maps `period` / `grace_period` / `ping_key` → `periodSeconds` / `graceSeconds` / `token`. A new live-server gating test (`scripts/import-heartbeat-e2e-test.ts`) covers the round-trip including a POST to the preserved ping URL.

## [1.21.0] - 2026-05-21

Backup with artifacts. The `.oodump.tar.gz` envelope bundles every object in the S3 bucket alongside the NDJSON dump; restore re-uploads artifacts and runs `runBackfill()` so QA suites are runnable end-to-end on a fresh host. UI Backup dialog gets an "Include browser run artifacts" checkbox (default on) + size estimate. Magic-byte dispatch keeps v1.7.0 legacy `.oodump.gz` restorable forever. CLI test + 9-case UI e2e (including a destructive round-trip with RustFS byte equality) gate the format.

## [1.20.1] - 2026-05-20

Heartbeat / DB / TLS hash routes - `#/heartbeat/<id>`, `#/db/<id>`, `#/tls/<id>` now resolve to the correct detail views. Plus a workers-landing screenshot tour (e2e capture used to refresh the marketing site images).

## [1.20.0] - 2026-05-20

Cookie-session realign across the v2 settings panel; faithful `enabled` state across every monitor type (the v2 redesign normalised the field); version-skew warning banner in the dashboard when an agent reports a different build than master.

## [1.19.0] - 2026-05-20

Heartbeat dashboard UI. Tile in the add-monitor dialog, detail view with the public ping URL + copy button + curl example + status / last-ping age, list-view tab with active vs OVERDUE counts. Backend shipped in v1.18.0.

## [1.18.0] - 2026-05-20

Heartbeat monitor type (Roadmap item 8). Inverted-direction: services POST to `/heartbeat/:token`, the scheduler sweeps for overdue rows. Schema migration `0019_heartbeats.sql`, repo + scheduler tick + alert dispatch, idempotent UP → OVERDUE transition so a single outage fires one alert.

## [1.17.0] - 2026-05-20

Import surrogate-id remap (Roadmap item 3.3). `/api/import` reconstructs monitor ↔ channel and status-page ↔ monitor bindings across SaaS / self-host id spaces using bundle-local id anchors from CLI v1.25.0+. Integration test exercises a v1.25.0 bundle, a pre-1.25.0 fallback, and a dangling-ref bundle.

## [1.16.0] - 2026-05-20

V2 dashboard redesign (PR #45). Fixed navbar, sectioned add-monitor dialog, slide-over create flows, Settings page (Profile / Security / API keys / Backup), docs TOC, incidents card list + editor, dashboard active-incidents widget + fleet-availability sparkline, brand-icon alert channels, login/setup reskin. Two follow-up PRs added a Settings nav link and an anti-vacuous auth-profile gating test.

## Older

Releases prior to v1.16.0 (the v2 dashboard cut) are summarised in `observeone-context/progress/2026-W21.md` and the per-tag git log. The notable predecessors:

- **1.15.0** (2026-05-19) - Multi-region setup-friction leftovers: `OO_AGENT_TLS_INSECURE` opt-in for the agent → master link (loud warnings + hourly drift reminder), `scripts/agent-tls-test.ts` gating, agent-version reporting + master-side skew detection.
- **1.14.0** (2026-05-19) - TLS chain/hostname assertions: opt-in `verify_chain`, `verify_hostname`, `expect_cn_regex` columns; save-time regex validation; new `tls-assertions.e2e` spec.
- **1.13.0 / 1.13.1** (2026-05-19) - SaaS `alert_channels` import (secret-safe by construction) + live `obs.json` → `/api/import` e2e against Mailpit + webhook catch-all.
- **1.12.0** (2026-05-19) - SaaS `suites[]` import → `qaProjects` (with inline scripts).
- **1.10.0 / 1.11.0** - QA-monitor alerting; status-page incident timeline.
- **1.7.0 / 1.7.1** (2026-05-18) - Full logical backup & restore (DB-only, the v1.21.0 base).
- **1.3.0** (2026-05-17) - Email/password auth + first-visit setup wizard.
