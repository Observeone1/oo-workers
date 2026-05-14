# Multi-region monitoring

Run probes from more than one location by attaching regional **agents** to your master. The master holds the schedule, fans jobs out per region, and aggregates results. Agents are stateless — they only need outbound HTTPS back to the master, no database, no Redis, no inbound ports. You can run agents on a $4 VPS, a home lab, or anywhere with outbound internet.

## Architecture

```
                                  ┌──────────────────────────────┐
                                  │   master (one instance)      │
                                  │  • UI / dashboard            │
                                  │  • scheduler + BullMQ        │
                                  │  • Postgres + Redis          │
                                  │  • /api/agent/{jobs,results} │
                                  └──────┬──────────────────┬────┘
                                         │ outbound HTTPS  │
                       ┌─────────────────┘                 └──────────────┐
                       │                                                  │
                ┌──────▼──────┐                                    ┌──────▼──────┐
                │  us-east    │                                    │  eu-west    │
                │  agent box  │                                    │  agent box  │
                │  (no DB)    │                                    │  (no DB)    │
                └─────────────┘                                    └─────────────┘
```

**Master** schedules jobs. For each due monitor, it looks up which regions it's bound to. If no regions are attached, the job runs locally on the master's in-process BullMQ workers (existing single-node behavior). If regions are attached, the job is pushed to one Redis list per region (`oo:jobs:<slug>`).

**Agents** long-poll `GET /api/agent/jobs?wait=N`. Master holds the connection open until a job is available or `N` seconds pass. Agent runs the probe locally, then POSTs the result to `/api/agent/results`. Each agent only sees its own region's jobs (authorized via the agent's API key).

**Why HTTP, not Redis-wire?** Agents on the open internet shouldn't need access to your Postgres or Redis. Outbound HTTPS to master is the only requirement — works through NAT, firewalls, home routers. The pattern mirrors how Pingdom, Better Stack, and Checkly all run their probe networks.

## Quick setup — adding your first region (~10 min)

### Prerequisite

**Your master must be reachable from the agent box.** If master binds to `127.0.0.1` (the default), agents on other boxes can't connect. Either:

- **Public HTTPS** — front master with a TLS reverse proxy. Caddy auto-LE works well; see `Security & deployment` in the main README.
- **Tailscale / Wireguard** — put master and agents on the same private network. Use the master's Tailscale IP or MagicDNS name as `OO_MASTER_URL`.

Self-signed certs aren't supported by the agent today (Bun's fetch validates by default). Use a real cert via Let's Encrypt or a private CA you've installed system-wide.

### Step 1 — On master, create the region

Open the dashboard, click **Regions** in the header, fill in:

- **Slug** — lowercase, dashes only. `us-east`, `eu-west`, `home-lab`.
- **Label** — display name. `US East (Virginia)`, `Frankfurt`, etc.

Click **Create region**. A green panel appears with the cleartext API key — this is the **only time** it's shown. Click **Copy to clipboard**.

(CLI alternative: `docker compose exec worker bun scripts/create-region.ts --slug us-east --label "US East"`)

### Step 2 — On the agent box, fetch the two files and configure

```bash
# Fetch the agent compose + env template.
curl -O https://raw.githubusercontent.com/Observeone1/oo-workers/main/docker-compose.agent.yml
curl -O https://raw.githubusercontent.com/Observeone1/oo-workers/main/.env.agent.example
mv .env.agent.example .env

# Edit .env — set these three values:
#   OO_MASTER_URL   = https://master.example.com (or the Tailscale URL)
#   OO_AGENT_KEY    = oo_…  (paste from step 1)
#   OO_REGION_SLUG  = us-east

# Start the agent.
docker compose -f docker-compose.agent.yml up -d

# Watch the first long-poll succeed.
docker compose -f docker-compose.agent.yml logs -f agent
```

You should see `🛰 agent starting` followed by `agent picked up exec=… type=…` as soon as a monitor bound to this region fires.

### Step 3 — Back on master, bind monitors to the region

Refresh the **Regions** page — within 30 seconds, your new region's status dot should turn green.

Open any monitor's **+ Add monitor** dialog (or edit an existing monitor via the API). A "Run from" section now appears with checkboxes for each region. Check `us-east` → Create. The scheduler's next tick fans the monitor out to that region, and the agent picks it up.

(API alternative to set regions on an existing monitor:)

```bash
curl -X PUT https://master.example.com/api/monitors/url/42/regions \
  -H "Authorization: Bearer oo_<your-write-key>" \
  -H "content-type: application/json" \
  -d '{"regionIds": [1]}'
```

`regionIds: []` = run on master only. Multiple IDs = fan out to each (one execution row per region per interval).

## What works on agents

| Monitor type | Agent support                            |
| ------------ | ---------------------------------------- |
| URL          | ✅                                       |
| API          | ✅                                       |
| TCP          | ✅                                       |
| UDP          | ✅                                       |
| Browser (QA) | ❌ Returns `ERROR` — runs only on master |

Browser (Playwright) monitors need a heavy Chromium runtime; we haven't yet shipped that on agents. If you bind a QA monitor to a region, the agent will report each run as `ERROR` with a clear message. To run it on master only, delete the matching row from `monitor_regions` (or uncheck the region in the dialog).

## Multiple agents per region

Running more than one agent for the same region is safe. Redis `BRPOP` guarantees only one agent receives each job, and master's result write is idempotent on `executionId`. You get parallel probe throughput for free.

Each agent box uses its own clone of the agent key bound to the region — the same key file. To deploy: copy the `.env` to each agent box, run the agent compose on each.

## Rotating an agent key

**From the UI:** open Regions → click **Rotate key** on the row → confirm. A new cleartext key panel appears; copy it.

**From the CLI:**

```bash
docker compose exec worker bun scripts/rotate-region-key.ts --slug us-east
```

Both paths are atomic: a new key is issued, the region's binding is updated, the old key is revoked, all in one transaction. The running agent starts getting 401 — restart it with the new env vars and it picks up where it left off. Region history (executions, last_seen_at, monitor bindings) is preserved.

## Deleting a region

**From the UI:** Regions → **Delete** on the row → confirm.

This revokes the agent's API key and removes all `monitor_regions` bindings (cascading). **Existing execution history is preserved** — the `region_id` on those rows is set to NULL, so they still show in detail views but lose the region attribution.

## Stalled executions

If an agent crashes mid-probe (machine power off, network drop, OOM), the corresponding execution row stays at `PENDING` in the master's database. The master keeps scheduling new probes every interval, so the metric stays fresh — only the stale row leaks.

The dashboard and API automatically project these as `FAILED` once they're older than 2× the monitor's interval. There's no background sweeper; the projection happens at read time. A late agent result (from a recovering agent) can still write into the row (the underlying status stays `PENDING` until something updates it), so the projection isn't destructive.

## Troubleshooting

### Agent log: `ECONNREFUSED` or DNS errors

The agent can't reach `OO_MASTER_URL`. Most common: master is bound to `127.0.0.1` and the agent is on a different box. Either expose master publicly (with TLS) or put both on the same VPN.

### Agent log: `401 invalid or revoked agent key`

The key was revoked (e.g., by a `rotate-region-key` you forgot about) or you mis-pasted the cleartext when setting `OO_AGENT_KEY`. Generate a new key via Rotate, paste it into the agent's `.env`, restart.

### Agent log: `socket connection was closed unexpectedly`

Should not happen with master at `v0.7.0+` (`Bun.serve idleTimeout` was bumped to 120s to fix this race). If you see it: confirm the master is on the latest tag.

### Region shows offline in the UI even though the agent is running

Check the agent's logs for backoff errors. If long-polls are succeeding (`agent picked up exec=…` lines appear), `regions.last_seen_at` updates on every poll. If the dashboard still shows offline, refresh — the threshold is 60s.

### Master upgraded, agent didn't

Run `docker compose -f docker-compose.agent.yml pull && docker compose -f docker-compose.agent.yml up -d` on each agent box after master version bumps. Agents are bundled in the same `observeone/oo-workers` image as master, so the agent compose pulls the same tag.

## Known gaps

- **No agent-side connectivity preflight.** First sign of misconfiguration is the agent log. A `scripts/check-agent-connectivity.ts` is on the polish backlog.
- **Self-signed TLS isn't supported** by the agent's fetch.
- **No header badge** showing online region count — open the Regions page to see status. On the polish backlog.
- **Browser (QA) monitors don't run on agents** — see "What works on agents" above.
- **No per-region latency series** on the monitor detail page yet — all runs are listed flat. On the polish backlog.

## Reference

- Design doc (architecture choices, alternatives considered): `observeone-context/plans/2026-05-13-oo-workers-phase-4-multi-region.md` (internal)
- Source: `src/scheduler.ts` (dual-path dispatch), `src/agent.ts` (loop), `src/services/agent-dispatch.ts` (master-side), `src/services/region-admin.ts` (CRUD), `src/ui/regions.ts` (settings page)
