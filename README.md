# oo-workers

Self-hosted monitoring. HTTP uptime checks, API checks with JSONPath assertions, and full Playwright browser flows. Runs in one `docker compose up`. Apache-2.0.

The open-source slice of [ObserveOne](https://observeone.com) — the engine, the scheduler, and a minimal admin UI.

---

## Quickstart

```bash
git clone https://github.com/Observeone1/oo-workers.git
cd oo-workers
cp .env.example .env
docker compose up -d
```

Open **http://localhost:3001** and click *+ Add monitor*. That's it.

The stack boots four services: `worker` (queue consumers + scheduler), `ui` (HTTP + admin dashboard), `postgres`, `redis`. Schema migrations run automatically on first boot.

## What you can monitor

| Type | Checks |
|------|--------|
| **HTTP uptime** | Is the URL up? Expected status code. |
| **API** | Send any HTTP request, evaluate assertions on the response: status, response time, JSONPath into JSON, headers, text contents. |
| **Browser** | Run a full Playwright `.spec.ts` script — log in, click, navigate, assert. Same code your team writes for e2e tests. |

Each monitor has an `interval_seconds` and an `enabled` toggle. The scheduler ticks every 5 seconds and enqueues anything that's due. Workers process jobs concurrently (tunable via env).

## Screenshots

*(coming with the public launch post)*

## Documentation

The dashboard ships a built-in reference at **http://localhost:3001/docs** covering:

- API assertion type × operator matrix
- JSONPath quick reference
- Playwright skeletons (login flow, checkout flow)
- Bulk JSON import schema

## Stack

- **Runtime:** Bun
- **Queue:** BullMQ + Redis 8
- **DB:** Postgres 18 (via `bun:sql` — no `pg` client dep)
- **Browser:** Playwright (Chromium, headless)
- **HTTP:** Hono
- **UI:** plain HTML + TS bundled by `bun build` (no framework)
- **Migrations:** plain `.sql` files run by a tiny custom runner

## Configuration

All via environment variables (see `.env.example`):

| Var | Default | Purpose |
|-----|---------|---------|
| `UI_PORT` | `3001` | Host port for the admin dashboard |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `oo` / `oo` / `oo_workers` | Postgres credentials |
| `URL_MONITOR_CONCURRENCY` | `20` | Parallel HTTP checks |
| `API_CHECK_CONCURRENCY` | `10` | Parallel API checks |
| `QA_PROJECT_CONCURRENCY` | `5` | Parallel browser checks |
| `LOG_LEVEL` | `info` | Worker log level |

## Bulk import

The dashboard has an **Import JSON** button. Schema:

```json
{
  "version": 1,
  "url_monitors": [
    { "name": "site",   "url": "https://example.com", "interval_seconds": 60,
      "assertions": [{ "operator": "equals", "status_code": 200 }] }
  ],
  "api_checks": [...],
  "qa_projects": [...]
}
```

Full schema at `/docs#import`.

## Develop without Docker

```bash
bun install
# point at your own postgres + redis
export DATABASE_URL=postgres://oo:oo@localhost:5432/oo_workers
export REDIS_URL=redis://localhost:6379
bun src/db/migrate.ts
bun --watch src/index.ts    # worker + scheduler
bun --watch src/ui-server.ts # in another shell — HTTP + UI on $PORT
```

## Project layout

```
src/
├── index.ts                 # worker entrypoint (BullMQ + scheduler, no HTTP)
├── ui-server.ts             # UI entrypoint (Hono + serves dashboard)
├── server.ts                # REST API + static UI handlers
├── scheduler.ts             # interval-based job enqueueing
├── config/db.ts             # bun:sql client
├── db/migrate.ts            # .sql runner with schema_migrations tracking
├── processors/              # url-monitor, api-check, qa-project
├── services/                # assertion engine, Playwright runner
└── ui/                      # index.html + app.ts + docs.html
migrations/
├── 0001_init.sql            # core schema
└── 0002_scheduler.sql       # interval_seconds + enabled
scripts/
├── smoke.ts                 # 3-monitor end-to-end smoke
├── load.ts                  # concurrency + failure modes + assertion breadth
└── scheduler-test.ts        # scheduler tick verification
```

## Limitations

Browser checks run against **plain headless Chromium** inside the container — no captcha bypass, no residential proxies, no clean-IP fingerprint rotation. That means:

- Scripts that target your own services (apps behind login, internal dashboards, public pages without bot walls) work great.
- Scripts that target sites with strong bot detection (Google, Cloudflare-gated pages, sites behind hCaptcha/reCAPTCHA, etc.) will hit consent popups or captchas and fail. There is no clean way to fix this without paying for a managed browser service (E2B, Browserbase, Bright Data, etc.) — which would break the "free self-host" promise.

A starter example you can adapt lives in [`examples/`](./examples).

## Roadmap

- **v0.2** *(current)* — workers + scheduler + UI + bulk import + docs.
- **v0.3** — TCP / UDP / database-protocol checks (the gap Uptime Kuma doesn't cover well).
- **v0.4+** — alert channels (Discord/Slack/webhook/email), status pages.

## Contributing

Issues + PRs welcome once we get past v0.2 polish. For now, kick the tires and tell us what breaks.

## License

[Apache-2.0](./LICENSE).
