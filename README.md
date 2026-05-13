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

# Generate your first API key (auth is on by default).
docker compose exec worker bun scripts/create-api-key.ts --name first
# → copy the oo_… key it prints, you'll paste it into the login screen.
```

This pulls the pre-built image from `observeone/oo-workers:latest` on Docker Hub — no local build needed. To build from source instead (for contributors), use `docker compose -f docker-compose.build.yml up -d`.

Open **http://localhost:3001**, paste the key, and click _+ Add monitor_. That's it.

The stack boots four services: `worker` (queue consumers + scheduler), `ui` (HTTP + admin dashboard), `postgres`, `redis`. Schema migrations run automatically on first boot. The UI port binds to `127.0.0.1` by default — see _Security & deployment_ below before exposing publicly.

## What you can monitor

| Type            | Checks                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP uptime** | Is the URL up? Expected status code.                                                                                                         |
| **API**         | Send any HTTP request, evaluate assertions on the response: status, response time, JSONPath into JSON, headers, text contents.               |
| **Browser**     | Run a full Playwright `.spec.ts` script — log in, click, navigate, assert. Same code your team writes for e2e tests.                         |
| **TCP**         | Open a TCP socket to `host:port`, measure connect-latency. Works for any port — SSH, SMTP, Postgres, Redis, custom services.                 |
| **UDP**         | Send a datagram (optional hex payload), optionally await a response within timeout. Use it for DNS queries, NTP probes, custom UDP services. |

Each monitor has an `interval_seconds` and an `enabled` toggle. The scheduler ticks every 5 seconds and enqueues anything that's due. Workers process jobs concurrently (tunable via env).

## Screenshots

_(coming with the public launch post)_

## Security & deployment

Two defaults out of the box:

- Write endpoints (`POST/PATCH/DELETE` on `/api/monitors/*`, plus `/api/import` and `/run`) need an API key. The dashboard asks for one on first visit and keeps it in an HttpOnly cookie. Reads stay open.
- The UI port binds to `127.0.0.1`. Only your own machine reaches it until you change that.

### Get your first key

```bash
docker compose exec worker bun scripts/create-api-key.ts --name first
# → oo_<43 chars>  (copy this — it won't be shown again)
```

Only the argon2id hash is stored. Make as many as you want with different names; revoke them individually later. Two scopes exist: `write` (default) and `read` (reserved, not used yet).

### Expose to the network

Set `OO_BIND_ADDR=0.0.0.0` in `.env` to drop the loopback restriction. Then put a reverse proxy with TLS in front — Caddy, Traefik, nginx, or Tailscale Funnel all work. Plain HTTP on a public IP is not a good idea.

### Known gaps

- An authenticated caller can ask the worker to probe any host:port it can reach, including your internal network. An allowlist of destination IPs is on the roadmap (S2 in the security plan).
- TLS isn't built in. Terminate it at the proxy.
- For a fully internal LAN where everyone on the network is trusted, you can set `OO_AUTH_ENABLED=false` to skip the login screen. Don't do this with a port reachable from the internet.

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

| Var                                                   | Default                    | Purpose                                                              |
| ----------------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `UI_PORT`                                             | `3001`                     | Host port for the admin dashboard                                    |
| `OO_BIND_ADDR`                                        | `127.0.0.1`                | Interface the UI port binds to. `0.0.0.0` to expose to your network. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `oo` / `oo` / `oo_workers` | Postgres credentials                                                 |
| `URL_MONITOR_CONCURRENCY`                             | `20`                       | Parallel HTTP checks                                                 |
| `API_CHECK_CONCURRENCY`                               | `10`                       | Parallel API checks                                                  |
| `QA_PROJECT_CONCURRENCY`                              | `5`                        | Parallel browser checks                                              |
| `TCP_MONITOR_CONCURRENCY`                             | `20`                       | Parallel TCP probes                                                  |
| `UDP_MONITOR_CONCURRENCY`                             | `20`                       | Parallel UDP probes                                                  |
| `LOG_LEVEL`                                           | `info`                     | Worker log level                                                     |

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
├── middleware/              # auth gate (Bearer + cookie)
├── processors/              # url-monitor, api-check, qa-project, tcp-monitor, udp-monitor
├── services/                # assertion engine, Playwright runner, tcp-probe, udp-probe
└── ui/                      # index.html + app.ts + login.ts + docs.html
migrations/
├── 0001_init.sql            # core schema
├── 0002_scheduler.sql       # interval_seconds + enabled
├── 0003_tcp.sql             # tcp_monitors + tcp_executions
├── 0004_udp.sql             # udp_monitors + udp_executions
└── 0005_auth.sql            # api_keys
scripts/
├── smoke.ts                 # multi-monitor end-to-end smoke
├── load.ts                  # concurrency + failure modes + assertion breadth
├── scheduler-test.ts        # scheduler tick verification
└── create-api-key.ts        # bootstrap an API key
```

## Limitations

Browser checks run against **plain headless Chromium** inside the container — no captcha bypass, no residential proxies, no clean-IP fingerprint rotation. That means:

- Scripts that target your own services (apps behind login, internal dashboards, public pages without bot walls) work great.
- Scripts that target sites with strong bot detection (Google, Cloudflare-gated pages, sites behind hCaptcha/reCAPTCHA, etc.) will hit consent popups or captchas and fail. There is no clean way to fix this without paying for a managed browser service (E2B, Browserbase, Bright Data, etc.) — which would break the "free self-host" promise.

A starter example you can adapt lives in [`examples/`](./examples).

## Roadmap

- **v0.6** _(current)_ — TCP + UDP probes, API-key auth, localhost-bind default, sign-in flow.
- **v0.7** — SSRF allowlist (gate which hosts probes can reach), TLS overlay (Caddy + LE auto-certs), alert channels (Discord/Slack/webhook/email), status pages.
- **v0.8+** — database-protocol checks (Postgres/MySQL/Redis `SELECT 1`/PING), S3/MinIO opt-in for QA script storage.

## Contributing

Issues + PRs welcome once we get past v0.2 polish. For now, kick the tires and tell us what breaks.

## License

[Apache-2.0](./LICENSE).
