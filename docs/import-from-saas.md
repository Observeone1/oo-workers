# Import from ObserveOne SaaS

## Using the CLI

```bash
# Export from SaaS (the CLI talks to the SaaS API by default)
obs --host https://app.observeone.com export --include-scripts > saas.json

# Apply into your self-hosted instance
obs --host http://localhost:3001 apply saas.json
```

The CLI handles the id-anchor remap that lets bindings between monitors,
channels, and status pages reconstruct correctly across the SaaS↔self-host
id boundary. Hand-rolled JSON typically misses these — use the CLI.

---

Already running monitors on ObserveOne SaaS? Pull that config into a
self-hosted instance in one command.

```bash
# 1. Export from SaaS (the obs CLI, logged in):
obs export --include-scripts > saas-export.json

# 2. Mint a write-scoped API key on the self-host:
docker compose exec worker bun scripts/create-api-key.ts --name import

# 3. Import:
bun scripts/import-from-saas.ts --from saas-export.json \
  --url http://localhost:3001 --key oo_…
```

`--from` is optional - without it the script shells `obs export` itself
(needs the CLI installed and logged in). `--url` defaults to
`http://localhost:3001` (`OO_IMPORT_URL` env also works); `--key` can come
from `OO_IMPORT_KEY`. Add `--dry-run` to see what would be imported without
posting anything (no key needed).

## What transfers

HTTP uptime monitors and API checks (with their assertions). HTTP monitors
import with a `status == 200` assertion, since SaaS treats them as uptime
checks.

**QA suites → QA projects**, _provided the SaaS export carried the test
scripts_. Run the SaaS export as `obs export --include-scripts`: each suite
becomes a QA project (name, target URL, schedule, and its Playwright tests).
A suite exported **without** `--include-scripts` has no scripts to run, so
it would import as a QA project that monitors nothing - those are reported
as skipped (count under `suites`) rather than created empty; re-run the
export with `--include-scripts` to bring them across. SaaS-only suite
settings with no self-host equivalent (`max_tests`, `is_public`,
`allow_form_submit`, `secret_keys`) are not carried.

**Alert channels** of type `email`, `slack`, `discord`, and `webhook`.
Only the endpoint is carried - `config.email` → the recipient,
`config.webhook_url` → the webhook URL. SaaS channel types with no
self-host equivalent (`teams`, `telegram`, `sms`) are reported as
skipped, never half-created; a channel whose endpoint is missing or
invalid is skipped too. Their SaaS-side secrets (Telegram `bot_token`,
Twilio `account_sid`/`auth_token`) are **never** read or written.

> ⚠ **`obs.json` contains live secrets.** A SaaS export embeds working
> webhook URLs (Discord/Slack tokens are in the URL) and recipient
> addresses. Treat the file as a credential - don't commit it, delete it
> after import.

### Bindings (monitor ↔ channel + status-page ↔ monitor)

The SaaS export references one entity from another by numeric id:
`monitor.channel_ids`, `status_pages[].monitors[].monitor_id`. Those ids
are SaaS-local; they don't exist on the self-host. As of **CLI v1.25.0+**
the export emits stable name-based anchors instead (a `channelRefs` array
on each monitor, an `{ ref, type }` shape on each status-page monitor
binding), and the self-host's `/api/import` reconstructs the bindings
during a second pass after every entity has been created.

Failure modes the script surfaces honestly rather than dropping silently:

- **Dangling ref**: the bundle binds a monitor to a channel that itself
  failed to create (invalid endpoint, duplicate name). Reported in
  `skipped` as `channel ref N did not resolve (channel may have been
skipped or absent from bundle)`.
- **All status-page refs dangle**: a status page whose every monitor ref
  failed to resolve is not created - a hollow shell is less useful than a
  clear "skipped" note.
- **Pre-v1.25.0 bundle**: no anchors → no bindings get wired. The whole
  import still succeeds, but the post-import advisory flags `N monitor(s)
imported with no alert-channel bindings` so a half-migrated stack
  doesn't fly blind. Re-export from v1.25.0+ to get bindings.

Heartbeat channel bindings are the one exception still pending - see
**Heartbeats** below.

## What doesn't (yet)

**Incidents** are the only resource still skipped. They're runtime state
(the SaaS itself doesn't re-create them on apply), so the script reports
the count and moves on. Heartbeats and status pages now migrate (see
below); use [backup & restore](backup-restore.md) for instance-to-instance
moves of incidents and runtime data.

### Heartbeats

Heartbeats migrate as of CLI v1.26.0 + oo-workers v1.22.0. The CLI
export now includes each heartbeat's `ping_key`, and the self-host
import re-uses it as the heartbeat token. That means every service
already posting to `/heartbeat/<token>` keeps working unchanged after
the cut-over.

Two follow-ups to be aware of:

1. **Alert-channel routing on heartbeats is not in the bundle.** The
   CLI export doesn't emit channel refs for heartbeats, so any alerts
   wired up on the SaaS need to be re-bound on the self-host. The
   import script prints an advisory after a successful import.
2. **Older CLI exports (< v1.26.0) lack `ping_key`.** The import still
   succeeds, but a fresh token is generated, so the ping URL changes.
   The script prints a warning listing how many heartbeats were
   imported tokenless; re-run `obs export` on v1.26.0+ to avoid this.

## Re-running

`POST /api/import` is **not** idempotent and **not** an upsert - there's no
unique constraint on monitor names, so posting the same export twice
creates duplicates rather than updating or skipping. To stop that footgun,
the script does a pre-flight check against the target and **refuses** to
post any name that already exists, listing the collisions and exiting
non-zero. Pass `--allow-duplicates` to override. (The check isn't atomic;
it catches the realistic footgun of re-running by mistake, not a monitor
created in the gap between the check and the post.) Treat the import as a
one-time seed and manage drift on the self-host afterward.
