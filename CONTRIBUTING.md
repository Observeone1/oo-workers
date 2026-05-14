# Contributing to oo-workers

Welcome. This doc covers what you need to hack on the codebase. End-user setup lives in the [README](README.md); deeper guides live in [docs/](docs/).

## Develop without Docker

```bash
bun install

# Point at your own Postgres + Redis.
export DATABASE_URL=postgres://oo:oo@localhost:5432/oo_workers
export REDIS_URL=redis://localhost:6379

bun src/db/migrate.ts

# In one shell — worker process (BullMQ + scheduler, no HTTP).
bun --watch src/index.ts

# In another shell — UI server (Hono + serves dashboard on $PORT).
bun --watch src/ui-server.ts
```

The two processes share the same Postgres + Redis; restart either independently while iterating.

## Develop against Docker

If you want the full stack but with your local source baked in:

```bash
# Build the local source as :dev
docker build -t observeone/oo-workers:dev .

# Recreate the worker + ui from the :dev tag (postgres + redis untouched)
OO_WORKERS_TAG=dev docker compose up -d --force-recreate worker ui
```

Postgres + Redis ports default to `5442` and `6379` on the host so you can connect from a host shell.

## Running tests

```bash
# Integration suite — runs the full worker + scheduler, fires monitors of every
# type, verifies expected counts. Needs Postgres + Redis up.
bun run test:integration

# Playwright e2e against a live UI server (must be reachable at UI_BASE_URL).
# OO_E2E_API_KEY is injected as the Bearer header.
UI_BASE_URL=http://localhost:3010 OO_E2E_API_KEY=oo_... bun run test:ui:e2e

# Type-check, lint, format-check, knip — CI runs all four.
bun run tsc --noEmit
bun run lint
bun run format:check
bun run knip
```

The Husky `pre-push` hook also runs `bun run test:integration` and blocks the push on failure. If you're pushing a docs-only change and the integration suite is flaky against your local Postgres, `git push --no-verify` is acceptable (but check with the maintainer first — we generally want CI to be the only gate that catches breakage).

## Project layout

```
src/
├── index.ts                       # entrypoint — branches on OO_WORKER_ROLE (master | agent)
├── ui-server.ts                   # UI entrypoint (Hono + serves dashboard)
├── server.ts                      # REST API + static UI route handlers
├── scheduler.ts                   # interval-based job dispatch (BullMQ + regional Redis list)
├── agent.ts                       # long-poll loop for OO_WORKER_ROLE=agent
├── config/db.ts                   # postgres-js + drizzle client
├── db/
│   ├── migrate.ts                 # plain .sql runner, schema_migrations tracking
│   ├── schema.ts                  # Drizzle table definitions
│   └── repositories/              # one repo per domain (api-key, region, url-monitor, …)
├── middleware/
│   └── auth.ts                    # requireAuth (Bearer / cookie) + requireAgent (region-bound)
├── processors/                    # one per monitor type — consumed by BullMQ workers on master
│   ├── url-monitor.processor.ts
│   ├── api-check.processor.ts
│   ├── tcp-monitor.processor.ts
│   ├── udp-monitor.processor.ts
│   └── qa-project.processor.ts
├── services/                      # pure functions — reused by master processors AND agent loop
│   ├── url-assertion.ts
│   ├── api-assertion.ts
│   ├── tcp-probe.ts
│   ├── udp-probe.ts
│   ├── playwright.service.ts
│   ├── agent-dispatch.ts          # master-side popJobForRegion + writeAgentResult
│   ├── region-admin.ts            # transactional create/rotate/delete region
│   └── exec-projection.ts         # lazy projection of stalled regional execs
├── ui/                            # plain HTML + TS bundled by `bun build`
│   ├── index.html, docs.html      # static shells
│   ├── app.ts, login.ts, regions.ts, list.ts, detail.ts, dialogs.ts
│   ├── api.ts, helpers.ts, types.ts, icons.ts, theme.ts
│   └── tokens.css, dashboard.css, docs.css
└── utils/
    ├── logger.ts
    └── fetch-errors.ts            # classify fetch failures into human-readable strings
migrations/
├── 0001_init.sql                  # url + api + qa core tables
├── 0002_scheduler.sql             # interval_seconds + enabled
├── 0003_tcp.sql                   # tcp_monitors + tcp_executions
├── 0004_udp.sql                   # udp_monitors + udp_executions
├── 0005_auth.sql                  # api_keys (argon2id, prefix lookup, scopes)
└── 0006_multi_region.sql          # regions + monitor_regions + region_id on 5 exec tables
scripts/
├── smoke.ts                       # end-to-end multi-monitor smoke
├── load.ts                        # concurrency + failure modes + assertion breadth
├── scheduler-test.ts              # scheduler tick verification
├── create-api-key.ts              # bootstrap a write key
├── create-region.ts               # provision a region + agent key
└── rotate-region-key.ts           # atomic key rotation for an existing region
```

## PR conventions

- One thing per PR. Bundle the test + the doc update with the change.
- Commit messages follow the existing pattern: `type(scope): summary`. Common types: `feat`, `fix`, `chore(format)`, `chore(release)`, `docs`, `refactor`.
- Pre-push hooks run integration tests + format-check; fix issues locally instead of `--no-verify`.
- CI gates: `typecheck`, `format-check`, `lint`, `knip`. All must pass before merge.
- Release tags are `v<version>` (e.g. `v0.7.1`). Pushing a tag triggers CD which publishes to Docker Hub.

## Release flow

See `observeone-context/.claude/skills/ob-oo-workers-release/SKILL.md` (internal).

Summary: bump `package.json` version on the PR branch → merge → tag the merge commit → push the tag → CD does the rest.

## Need a hand

- File an issue: https://github.com/Observeone1/oo-workers/issues
- The internal context repo has design docs and the master sequence; ask if you need access.
