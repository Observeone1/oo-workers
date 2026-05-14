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

# Generate your first API key (auth is on by default).
docker compose exec worker bun scripts/create-api-key.ts --name first
# → copy the oo_… key it prints, you'll paste it into the login screen.
```

This pulls the pre-built image from `observeone/oo-workers:latest` on Docker Hub. To build from source, use `docker compose -f docker-compose.build.yml up -d`.

Open **http://localhost:3001**, paste the key, click _+ Add monitor_. That's it.

Five containers boot: `worker` (queue consumers + scheduler), `ui` (HTTP + dashboard), `postgres`, `redis`, `rustfs` (S3-compatible object storage for browser-check scripts). Schema migrations run automatically on first boot. The UI port binds to `127.0.0.1` by default — see _Security & deployment_ below before exposing publicly.

## What you can monitor

| Type            | Checks                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP uptime** | Is the URL up? Expected status code.                                                                                                         |
| **API**         | Send any HTTP request, evaluate assertions on the response: status, response time, JSONPath into JSON, headers, text contents.               |
| **Browser**     | Run a full Playwright `.spec.ts` script — log in, click, navigate, assert. Same code your team writes for e2e tests.                         |
| **TCP**         | Open a TCP socket to `host:port`, measure connect-latency. Works for any port — SSH, SMTP, Postgres, Redis, custom services.                 |
| **UDP**         | Send a datagram (optional hex payload), optionally await a response within timeout. Use it for DNS queries, NTP probes, custom UDP services. |

Each monitor has an `interval_seconds` and an `enabled` toggle. The scheduler ticks every 5 seconds and enqueues whatever's due. Workers process jobs concurrently (tunable via env).

## Alerts and status pages

When a monitor flips down or recovers, oo-workers can fire to a **webhook**, **Discord**, or **Slack** channel. Set up channels under `#/channels`, bind them per-monitor in the create dialog. Trigger model is status _transition_ only: `SUCCESS → FAILED` fires outage, `FAILED → SUCCESS` fires recovery. Sustained failure stays quiet so flaky checks don't paginate you to death.

Public status pages live at `/status/<slug>` — anonymous, server-rendered, auto-refresh every 60s. Headline banner, 90-day uptime bars per monitor, 24h uptime %. Operators curate which monitors appear (no auto-publish). Admin under `#/status-pages`.

## Multi-region

Run probes from more than one location by attaching regional **agents** to your master. Master schedules and aggregates; agents are stateless and only need outbound HTTPS. Set up a region from the dashboard's **Regions** page, paste the printed key into `docker-compose.agent.yml`'s `.env`, and bind monitors via the **+ Add monitor** dialog's "Run from" picker.

→ **Full walkthrough, architecture, and troubleshooting in [docs/multi-region.md](docs/multi-region.md).**

## Storage

Browser-check scripts and (soon) failed-run traces live in object storage. The default stack bundles **RustFS** (Apache-2.0, S3-compatible) — no setup, scripts upload on create, the bucket is browsable at **http://localhost:9001** with the keys from your `.env`.

Keys follow `qa-projects/<projectId>-<slug>/<testId>-<slug>.spec.ts`, so the bucket reads like your monitors do. Deleting a monitor cleans up its bucket objects; a boot-time orphan sweep handles anything that slips through.

Point at any S3 endpoint by overriding in `.env`:

```bash
OO_OBJECT_STORAGE_ENDPOINT=https://s3.amazonaws.com
OO_OBJECT_STORAGE_BUCKET=my-bucket
OO_OBJECT_STORAGE_ACCESS_KEY=AKIA...
OO_OBJECT_STORAGE_SECRET_KEY=...
```

Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, Ceph — anything that speaks the S3 protocol.

## Security & deployment

Two defaults shipped on day one:

Write endpoints (`POST/PATCH/DELETE` on `/api/monitors/*`, plus `/api/import` and `/run`) need an API key. The dashboard asks for one on first visit and keeps it in an HttpOnly cookie. Reads stay open.

The UI port binds to `127.0.0.1`. Only your own machine reaches it until you change that.

### Get your first key

```bash
docker compose exec worker bun scripts/create-api-key.ts --name first
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

The dashboard ships a built-in reference at **http://localhost:3001/docs** covering the API assertion matrix, JSONPath quick reference, Playwright skeletons (login flow, checkout flow), and the bulk JSON import schema.

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

Active releases live on [GitHub Releases](https://github.com/Observeone1/oo-workers/releases) and Docker Hub (`observeone/oo-workers`). Latest stable is **v1.1.1**.

## Contributing

Issues + PRs welcome. Dev setup, project layout, test commands, and the release flow live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE).
