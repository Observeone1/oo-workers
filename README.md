# oo-workers

Self-hosted monitoring workers. HTTP / API / Playwright browser checks, queued via BullMQ + Redis, results in Postgres. The OSS slice of ObserveOne, packaged for `docker compose up`.

**Status:** pre-alpha · private repo until v0.1.

---

## Quickstart

```bash
git clone git@github.com:Observeone1/oo-workers.git
cd oo-workers
cp .env.example .env
docker compose up -d
docker compose logs -f worker
```

That's it. The worker connects to Postgres + Redis, runs migrations on first boot, and listens on three queues (`url-monitor`, `api-check`, `qa-project`).

## What it does

This is the **engine**. It does not have a UI in v0.1, and it does not pick which monitors to run — it processes jobs you push to its queues.

For each monitor type, the worker:

- Picks up a BullMQ job from its queue
- Executes the check (fetch URL, hit API, run Playwright script)
- Evaluates assertions
- Writes the result to Postgres
- Retries on failure per BullMQ retry policy

### Monitor types

| Type | Queue | Table (config) | Table (results) | Assertions |
|------|-------|----------------|-----------------|------------|
| HTTP uptime | `url-monitor` | `url_monitors` | `url_monitor_executions` | status code |
| API check | `api-check` | `api_checks` | `api_executions` | status, response time, JSONPath, headers, text |
| Browser check | `qa-project` | `qa_projects` + `qa_generated_tests` | `qa_test_executions` | full Playwright script |

## How to feed it work (v0.1)

There's no scheduler or HTTP API yet (Phase 2). To run a check manually:

1. Insert a monitor row into Postgres (e.g. `INSERT INTO url_monitors (name, url) VALUES ('example', 'https://example.com')`).
2. Insert an execution row with `status='pending'`.
3. Push a BullMQ job to the appropriate queue with `{ executionId, monitor, assertions }`.

A scheduler that does steps 2 and 3 on a cron-like interval is on the Phase 2 roadmap.

## Stack

- **Runtime:** Bun (`bun:sql` built-in Postgres client, no separate compile step)
- **Queue:** BullMQ + Redis
- **DB:** Postgres 16
- **Browser:** Playwright (Chromium)
- **Migrations:** plain `.sql` files in `migrations/`, applied by `src/db/migrate.ts`

## Project layout

```
src/
├── index.ts                          # entry: starts 3 BullMQ workers
├── config/db.ts                      # bun:sql client (DATABASE_URL)
├── db/migrate.ts                     # tiny .sql runner with schema_migrations tracking
├── processors/
│   ├── url-monitor.processor.ts
│   ├── api-check.processor.ts
│   └── qa-project.processor.ts
├── services/
│   ├── assertion.service.ts          # JSONPath-aware assertion engine
│   └── playwright.service.ts         # Playwright child-process runner
└── utils/logger.ts
migrations/
└── 0001_init.sql                     # schema: monitors, assertions, executions
docker-compose.yml
Dockerfile
.env.example
```

## Roadmap

- **v0.1 (current):** worker engine + Postgres + Redis, `docker compose up`. HTTP / API / browser checks. Manual job pushing.
- **v0.2:** thin admin UI (monitor CRUD, history, live status, manual "run now"), scheduler.
- **v0.3:** TCP / UDP / database-protocol checks (the gap Uptime Kuma doesn't cover well).
- **v0.4+:** multi-region result tagging, alert channels, status pages.

## Develop without docker

```bash
bun install
# (run a postgres + redis however you like)
export DATABASE_URL=postgres://oo:oo@localhost:5432/oo_workers
export REDIS_URL=redis://localhost:6379
bun src/db/migrate.ts
bun --watch src/index.ts
```

## License

TBD before public release.
