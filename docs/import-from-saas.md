# Import from ObserveOne SaaS

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

`--from` is optional — without it the script shells `obs export` itself
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
it would import as a QA project that monitors nothing — those are reported
as skipped (count under `suites`) rather than created empty; re-run the
export with `--include-scripts` to bring them across. SaaS-only suite
settings with no self-host equivalent (`max_tests`, `is_public`,
`allow_form_submit`, `secret_keys`) are not carried.

## What doesn't (yet)

SaaS alert channels, status pages, heartbeats, and incidents are **not**
transferred — the script reports their counts as skipped so nothing is
silently lost. Bringing channels and status pages across is the next piece
of work; heartbeats need a self-host heartbeat monitor type first;
incidents are runtime state (the SaaS itself doesn't re-create them on
apply). For now, recreate those on the self-host, or use
[backup & restore](backup-restore.md) for instance→instance moves (a
different job — that's a full DB snapshot, not a SaaS migration).

## Re-running

`POST /api/import` is **not** idempotent and **not** an upsert — there's no
unique constraint on monitor names, so posting the same export twice
creates duplicates rather than updating or skipping. To stop that footgun,
the script does a pre-flight check against the target and **refuses** to
post any name that already exists, listing the collisions and exiting
non-zero. Pass `--allow-duplicates` to override. (The check isn't atomic —
it catches the realistic footgun of re-running by mistake, not a monitor
created in the gap between the check and the post.) Treat the import as a
one-time seed and manage drift on the self-host afterward.
