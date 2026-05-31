# Heartbeat monitors

Heartbeat monitors are **inverted-direction**: instead of oo-workers probing your service, **your service pings oo-workers** every time it completes a successful run. If no ping arrives within `period + grace` seconds, the monitor flips to `OVERDUE` and fires an alert.

Best for cron jobs, scheduled batch tasks, queue consumers, and anything that doesn't expose an HTTP endpoint you can probe.

## Quick start

1. **Create the monitor** in the dashboard (Add monitor → Heartbeat) or via the API:

   ```bash
   curl -X POST http://localhost:3001/api/monitors/heartbeat \
     -H "Authorization: Bearer oo_<your-key>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "nightly-backup",
       "periodSeconds": 86400,
       "graceSeconds": 1800,
       "description": "Nightly off-site backup"
     }'
   # → { "id": 12, "token": "Eyq...", ... }
   ```

   The `token` is the URL component you'll ping. It's not a secret in the usual sense - anyone with the URL can mark your heartbeat as alive - but treat it like one anyway and don't paste it into public chat.

2. **Wire your service to ping on success**:

   ```bash
   # At the end of your cron job / batch script:
   curl -fsS -X POST http://monitor.example.com/heartbeat/Eyq...
   ```

   The `-f` flag fails the curl on non-2xx so a misconfigured URL surfaces in your job's logs.

3. **Done.** The dashboard's Heartbeat tab shows `last_ping_at`, current status, and the period + grace.

## States

| State     | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `PENDING` | Created but no ping has arrived yet. **Stays PENDING forever** - won't alert until the first ping.   |
| `UP`      | At least one ping received, and the most recent one was within `period + grace`.                     |
| `OVERDUE` | No ping for at least `period + grace` seconds. Outage alert fired once when the transition happened. |

A heartbeat in `PENDING` that's never been pinged stays PENDING and never alerts. If you wire up the cron and the first run happens to succeed, the monitor flips to `UP`. If you never wire it up, the monitor sits silent - there's intentionally no "you forgot to ping" alert at creation time.

## The two endpoints

| Method | Path                | Behaviour                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/heartbeat/:token` | Records a ping. Updates `last_ping_at`, flips status to `UP`, and fires a recovery alert if the heartbeat was previously `OVERDUE`. Sub-second pings are debounced (no DB write) so a leaked token can't flood the worker. Returns `200 { ok, status, lastPingAt }` or `404 { error: "unknown heartbeat" }`. |
| `GET`  | `/heartbeat/:token` | **Read-only.** Returns the current status without recording a ping. This exists so link-previewer pre-fetches (Slack, iMessage, Discord) don't accidentally ping your heartbeat every time the URL gets pasted somewhere.                                                                                    |

Both endpoints are unauthenticated by design - services need to ping without managing an API key. The token in the URL is the auth.

**Disabled heartbeats look like missing heartbeats from the outside.** Both `POST` and `GET` to a disabled heartbeat's token return `404`. This is deliberate: a curious caller can't tell whether the token exists-and-disabled or never-existed.

## Period and grace

- `periodSeconds` - the expected gap between pings. Must be `≥ 30`. A 30s floor means the scheduler tick (5s default) reliably catches `OVERDUE` transitions without spurious recoveries.
- `graceSeconds` - extra tolerance before flipping to `OVERDUE`. Default `60`. Set this higher than the longest-acceptable jitter for your job (cron drift, container restart, network blip).

Total deadline: `period + grace`. A nightly job at `00:00` with `periodSeconds: 86400` + `graceSeconds: 1800` (30 min) won't alert until `00:30` the next day.

## Migration from SaaS

Heartbeats migrate cleanly from a SaaS `obs export` (CLI v1.26.0+). The SaaS `ping_key` is preserved as the self-host `token`, so existing services pointing at the old `/ping/<key>` URL keep working with no rotation.

Pre-v1.26.0 CLI exports lack the `ping_key` field; the import still creates the heartbeat but with a freshly-generated token. The script's pre-flight warning calls this out and lists which URLs need rotation.

## Alerting

Heartbeats alert through the same channel system as every other monitor type. Bind channels to a heartbeat from the Heartbeat tab → click the row → Alert channels. The `UP → OVERDUE` transition fires the outage alert; the next `POST /heartbeat/:token` (which flips status back to `UP`) fires a recovery alert.

## Limitations

- **Channel binding can't ride in a SaaS export.** The CLI export doesn't emit channel refs for heartbeats; after an import, operator must re-bind manually from the Heartbeat tab. Tracked as a follow-up.
- **No "ping-not-received-yet" alert.** PENDING heartbeats stay silent. If you've ever forgotten to wire a cron, this won't catch it - set up a manual test ping at creation time as a smoke test.
- **No grace-zero ping-on-arrival alerts.** A burst of 100 pings inside one period doesn't fire 100 success events; the deadline-sweeper only fires on the transition, not per ping.
