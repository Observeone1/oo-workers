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

## Multi-region

Run probes from more than one location by attaching regional **agents** to your master. Master schedules and aggregates; agents are stateless and only need outbound HTTPS. Set up a region from the dashboard's **Regions** page, paste the printed key into `docker-compose.agent.yml`'s `.env`, and bind monitors via the **+ Add monitor** dialog's "Run from" picker.

→ **Full walkthrough, architecture, and troubleshooting in [docs/multi-region.md](docs/multi-region.md).**

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

Issues + PRs welcome. Dev setup, project layout, test commands, and the release flow live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE).
