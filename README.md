# oo-workers

Self-hosted monitoring. HTTP uptime checks, API checks with JSONPath assertions, and full Playwright browser flows. Runs in one `docker compose up`. Apache-2.0.

The open-source slice of [ObserveOne](https://observeone.com) — the engine, the scheduler, and a minimal admin UI.

---

## Quickstart

```bash
git clone https://github.com/Observeone1/oo-workers.git
cd oo-workers
./scripts/setup.sh           # writes .env with random Postgres + Redis passwords
docker compose up -d
```

This pulls the pre-built image from `observeone/oo-workers:latest` on Docker Hub. To build from source, use `docker compose -f docker-compose.build.yml up -d`.

Open **http://localhost:3001**. On first visit a setup wizard asks you to create an admin account (email + password); after that it's a normal email/password login. Click _+ Add monitor_ and you're going.

Need programmatic access (CLI, agents, CI)? Mint API keys in the dashboard under **Keys**, or from the shell:

```bash
docker compose exec worker bun scripts/create-api-key.ts --name ci
# → copy the oo_… key; send it as `Authorization: Bearer oo_…`
```

Five containers boot: `worker` (queue consumers + scheduler), `ui` (HTTP + dashboard), `postgres`, `redis`, `rustfs` (S3-compatible object storage for browser-check scripts). Schema migrations run automatically on first boot. The UI port binds to `127.0.0.1` by default — see _Security & deployment_ below before exposing publicly.

## What you can monitor

| Type            | Checks                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP uptime** | Is the URL up? Expected status code.                                                                                                                                                                  |
| **API**         | Send any HTTP request, evaluate assertions on the response: status, response time, JSONPath into JSON, headers, text contents.                                                                        |
| **Browser**     | Run a full Playwright `.spec.ts` script — log in, click, navigate, assert. Same code your team writes for e2e tests.                                                                                  |
| **TCP**         | Open a TCP socket to `host:port`, measure connect-latency. Optionally send a payload and assert on the response banner (SSH/SMTP/Redis/IMAP). See [docs/tcp-checks.md](docs/tcp-checks.md).           |
| **UDP**         | Send a datagram (optional hex payload), optionally await a response within timeout. Use it for DNS queries, NTP probes, custom UDP services.                                                          |
| **Database**    | Postgres / MySQL / Redis liveness — connects and confirms the server speaks the protocol (no credentials stored; "is it up?", not authenticated queries). See [docs/db-checks.md](docs/db-checks.md). |

Each monitor has an `interval_seconds` and an `enabled` toggle. The scheduler ticks every 5 seconds and enqueues whatever's due. Workers process jobs concurrently (tunable via env).

## Alerts and status pages

When a monitor flips down or recovers, oo-workers can fire to a **webhook**, **Discord**, **Slack**, or **email** channel. Set up channels under `#/channels`, bind them per-monitor in the create dialog. Email needs SMTP configured once via `OO_SMTP_*` env (see [`.env.example`](.env.example)); the channel just stores the recipient. Trigger model is status _transition_ only: `SUCCESS → FAILED` fires outage, `FAILED → SUCCESS` fires recovery. Sustained failure stays quiet so flaky checks don't paginate you to death.

Public status pages live at `/status/<slug>` — anonymous, server-rendered, auto-refresh every 60s. Headline banner, 90-day uptime bars per monitor, 24h uptime %. Operators curate which monitors appear (no auto-publish). Admin under `#/status-pages`.

## Multi-region

Run probes from more than one location by attaching regional **agents** to your master. Master schedules and aggregates; agents are stateless and only need outbound HTTPS. Set up a region from the dashboard's **Regions** page, paste the printed key into `docker-compose.agent.yml`'s `.env`, and bind monitors via the **+ Add monitor** dialog's "Run from" picker.

→ **Full walkthrough, architecture, and troubleshooting in [docs/multi-region.md](docs/multi-region.md).**

## Storage

Browser-check scripts and **run artifacts** (Playwright `trace.zip` + screenshot, captured on failure) live in object storage. The default stack bundles **RustFS** (Apache-2.0, S3-compatible) — no setup, scripts upload on create, traces upload on failed runs. Browse the bucket at **http://localhost:9001** with the keys from your `.env`.

Keys follow `qa-projects/<projectId>-<slug>/...` — scripts at the root, run artifacts under `runs/<execId>/`. The monitor detail page shows trace + screenshot links per failed run; download the trace and open it with `npx playwright show-trace trace.zip`. Monitor delete cleans up its bucket objects; a boot-time orphan sweep handles anything that slips through.

### Why RustFS

The default storage backend went through three picks:

- **MinIO** was the obvious choice for years. Relicensed to AGPL-3.0 in February 2026 and archived the community repo. AGPL on a bundled binary is a deal-breaker for enterprises that ban copyleft in their stack, even when shipped unmodified.
- **Garage** (Deuxfleurs) was next. Lightweight, geo-distributed, Rust. Also AGPL-3.0. Same problem.
- **RustFS** (Apache-2.0) shipped. Drop-in MinIO replacement, single Rust binary, actively maintained. License matches oo-workers' own Apache-2.0 so the whole stack stays permissive.

### Bring your own S3

Point at any S3-compatible endpoint by overriding `.env`:

```bash
OO_OBJECT_STORAGE_ENDPOINT=https://s3.amazonaws.com
OO_OBJECT_STORAGE_BUCKET=my-bucket
OO_OBJECT_STORAGE_ACCESS_KEY=AKIA...
OO_OBJECT_STORAGE_SECRET_KEY=...
```

Works with AWS S3, Cloudflare R2, Backblaze B2, on-prem MinIO/Ceph — anything that speaks the S3 protocol. The bundled RustFS container still starts but sits idle; comment out the `rustfs:` block in `docker-compose.yml` if you want to free the disk.

## Backup & restore

Take a full logical snapshot — config + execution history — from the
dashboard's **Backup** button or `bun scripts/export.ts`, and restore it on
another instance. It's a portable, schema-versioned dump (not `pg_dump`),
windowed to 90 days of history by default. See
[docs/backup-restore.md](docs/backup-restore.md).

## Security & deployment

Two defaults shipped on day one:

Write endpoints (`POST/PATCH/DELETE` on `/api/monitors/*`, plus `/api/import` and `/run`) require auth; reads stay open. Two ways to authenticate:

- **Dashboard** — email/password. First visit runs a setup wizard to create the admin account; the server keeps an HttpOnly session cookie after login. Sign out from the header.
- **Programmatic** (CLI, agents, CI) — an API key sent as `Authorization: Bearer oo_…`. Manage keys in the dashboard under **Keys** (create with a one-time reveal, revoke anytime) or via the script below.

The UI port binds to `127.0.0.1`. Only your own machine reaches it until you change that.

### Get an API key

In the dashboard: **Keys → Create a key** (copy it from the one-time panel). Or from the shell:

```bash
docker compose exec worker bun scripts/create-api-key.ts --name ci
# → oo_<43 chars>  (copy this — it won't be shown again)
```

Only the argon2id hash is stored. Make as many as you want with different names; revoke them individually later.

### Expose to the network

**TLS overlay (recommended).** Point DNS at the host, set `OO_DOMAIN=monitor.example.com` in `.env`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Caddy fetches a Let's Encrypt cert automatically, serves the UI over HTTPS on `:443`, and renews forever. Ports 80 + 443 need to be reachable from the public internet so the ACME challenge can complete.

**Bring your own proxy.** Set `OO_BIND_ADDR=0.0.0.0` and put Traefik, nginx, or Tailscale Funnel in front. Plain HTTP on a public IP is not a good idea.

### Known tradeoff

An authenticated caller can ask the worker to probe any host:port it can reach, including your internal network. This is intentional — self-hosted monitoring is supposed to watch private services (your NAS, internal Grafana, staging APIs). Don't hand keys to people you wouldn't already trust with that access.

## Documentation

The dashboard ships a built-in reference at **http://localhost:3001/docs** covering the API assertion matrix, JSONPath quick reference, Playwright skeletons (login flow, checkout flow), and the bulk JSON import schema. Deeper guides live in [`docs/`](docs/) — [multi-region](docs/multi-region.md), [database checks](docs/db-checks.md), [backup & restore](docs/backup-restore.md), [import from SaaS](docs/import-from-saas.md), and [TCP banner checks](docs/tcp-checks.md).

## Configuration

Most settings live in `.env` — see [`.env.example`](.env.example) for the full list. The three you'll likely touch:

| Var             | Default     | Purpose                                                              |
| --------------- | ----------- | -------------------------------------------------------------------- |
| `UI_PORT`       | `3001`      | Host port for the admin dashboard.                                   |
| `OO_BIND_ADDR`  | `127.0.0.1` | Interface the UI port binds to. `0.0.0.0` to expose to your network. |
| `*_CONCURRENCY` | varies      | Parallel jobs per probe type. Tune up if your host has the cores.    |

## Limitations

Browser checks run against plain headless Chromium inside the container — no captcha bypass, no residential proxies, no clean-IP fingerprint rotation. That means:

- Scripts that target your own services (apps behind login, internal dashboards, public pages without bot walls) work great.
- Scripts that target sites with strong bot detection (Google, Cloudflare-gated pages, anything behind hCaptcha/reCAPTCHA) will hit consent popups or captchas and fail. The only honest fix is paying for a managed browser service (E2B, Browserbase, Bright Data), which would break the "free self-host" promise.

A starter example you can adapt lives in [`examples/`](./examples).

## Releases

Every `v*` git tag auto-publishes to Docker Hub (`observeone/oo-workers`) as three tags from one build: `:<version>` (e.g. `:1.6.0`), `:<major>.<minor>` (e.g. `:1.6`), and `:latest`. Pull `:latest` for the newest stable, or pin an exact `:<version>`. Browse [all tags](https://github.com/Observeone1/oo-workers/tags).

## Contributing

Issues + PRs welcome. Dev setup, project layout, test commands, and the release flow live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE).
