# Backup & restore

## Using the CLI

```bash
# Export this instance — config + 90d history + browser run artifacts
obs export --include-scripts --include-artifacts > snapshot.oodump.tar.gz

# Restore onto another instance (same or different host)
obs --host https://master-b.example.com import snapshot.oodump.tar.gz
```

The dashboard's **Backup** button under `#/settings/backup` covers the same
flow with a checkbox UI for the artifact toggle. CLI is the right path for
automated nightly backups: pipe the output to S3, cron it, done.

---

A full logical snapshot of an oo-workers instance — configuration **and**
execution history — that you can move to a new host, keep for disaster
recovery, or use to clone an instance for staging.

This is not `pg_dump`. The dump is a portable, schema-versioned NDJSON
stream: it survives a Postgres major-version change, lets you window the
history, and restores through the app's own schema rather than a binary
format.

## What's in a dump

- **All configuration** — every monitor type (HTTP, API, TCP, UDP, **DB**,
  QA/browser), assertions, alert channels, status pages, regions, users
  (password hashes), and API keys (hashes). Restored keys and logins keep
  working.
- **Execution history** — the six `*_executions` tables, windowed to the
  last 90 days by default.
- QA Playwright **script bodies** ride along (they live in a DB column).

Not included by default: sessions (transient — log in again after a
restore) and object-storage artifacts (QA test scripts in S3, Playwright
`trace.zip`, failure screenshots). The default dump is the database only.

**Include artifacts.** Tick **Include browser run artifacts** in the
Backup dialog (or pass `--include-artifacts` to the CLI) to bundle every
object in the configured S3 bucket — QA scripts (`qa-projects/…/*.spec.ts`)
and per-run artifacts (`qa-projects/…/runs/<id>/trace.zip`,
`screenshot-*.png`) — into the dump. The download switches from
`.oodump.gz` (raw NDJSON) to `.oodump.tar.gz` (tar envelope with
`meta.json` + `dump.ndjson` + `artifacts/<key>`). Restore auto-detects
either format; legacy v1.7.0 dumps stay restorable forever.

Without this, a fresh-host restore leaves QA `script_url` pointers
dangling (the suite is unrunnable) and per-run **Download trace** links 404. The toggle is on by default in the UI dialog for that reason.

## From the dashboard

**Backup → Download backup.** Pick a scope — last 90 days, all history, or
config only — and the browser streams an `oo-backup-<timestamp>.oodump.gz`
straight to disk. (It's a gzip, regardless of the `.oodump.gz` name.)

**Backup → Restore.** Choose a `.oodump.gz` file and confirm. Restore
**replaces everything** in the target instance with the backup, so it asks
you to confirm the wipe first. Restoring into the instance you're logged
into clears its sessions, so you'll be signed out and need to log in again
once it finishes.

## From the CLI

Run inside the worker container (direct DB access, no HTTP):

```bash
# Back up — DB only (legacy .oodump.gz)
docker compose exec worker bun scripts/export.ts -o /tmp/backup.oodump.gz
docker compose exec worker bun scripts/export.ts --scope all -o /tmp/full.oodump.gz
docker compose exec worker bun scripts/export.ts --scope none -o /tmp/config.oodump.gz
docker compose exec worker bun scripts/export.ts --since 30 -o /tmp/recent.oodump.gz

# Back up DB + every object in the S3 bucket (.oodump.tar.gz envelope)
docker compose exec worker bun scripts/export.ts --include-artifacts \
  -o /tmp/full-with-artifacts.oodump.tar.gz

# Back up split across one file per table (parallel; good for huge instances)
docker compose exec worker bun scripts/export.ts --split /tmp/backup-dir/

# Restore (target must be empty, or pass --force to wipe it first).
# import.ts auto-detects the format (raw NDJSON vs tar envelope).
docker compose exec worker bun scripts/import.ts --from /tmp/backup.oodump.gz --force
docker compose exec worker bun scripts/import.ts --from /tmp/full-with-artifacts.oodump.tar.gz --force
docker compose exec worker bun scripts/import.ts --from /tmp/backup-dir/ --force
```

`--scope`: `window` (default, last `--since` days), `all`, or `none`
(config only). The single-file dump and a `--split` directory are
interchangeable — `import.ts` reconstructs the same ordering from either.

## Artifact restore semantics

When you restore a tar envelope (`--include-artifacts` dump):

1. The DB rows are applied first, in one transaction, exactly like the
   DB-only path.
2. After the transaction commits, each `artifacts/<key>` tar entry is
   uploaded to the new host's S3 via `putObject` at the same key it had
   on the source.
3. The boot-time `storage-backfill` pass runs at the end so any pre-v1.0
   inline-only `qa_generated_tests.script` rows get re-uploaded to S3 on
   the new host.

A partial S3 outage during step 2 logs a warning and continues — the DB
is the durability anchor, and any missing-object 404s degrade gracefully
the same way they do on a live instance. If the target stack has no
`OO_OBJECT_STORAGE_*` configured, the artifacts in the tar are skipped
with a single warning line and the DB is restored normally.

## Restore rules

- **Fresh-restore only.** The target must be empty, or you pass `--force`
  (CLI) / confirm the wipe (UI), which truncates every table first. There
  is no merge-into-a-running-instance mode — that's a separate concern from
  this DR snapshot.
- **Schema version must match.** The dump records the migration head (e.g.
  `0014_db.sql`). Restore refuses unless the target instance is migrated to
  the exact same version — migrate the target first, then restore. This is
  the one error you're most likely to hit moving between releases.
- IDs are preserved and the serial sequences are bumped past the restored
  rows, so new monitors created after a restore don't collide. The whole
  load runs in one transaction: a failed restore leaves the target
  untouched.
- The export is a best-effort point-in-time view — there's no global lock,
  so a check that fires mid-export may or may not be in the dump. Fine for
  monitoring data; don't treat it as a transactional snapshot of a running
  instance.

## Not the same as Import JSON

The dashboard's **Import JSON** / `POST /api/import` is a thin adapter for
pulling an ObserveOne SaaS export (or a hand-written config) into a fresh
instance. It's config-only and not idempotent. Backup/restore is the
DB-direct full snapshot described here — different tool, different job.

## Testing

`bun run test:backup` runs the round-trip end to end — it provisions its
own `oo_br_*` databases from `DATABASE_URL`, exercises export/import (all
scopes, the 90-day window per execution table, single-vs-split parity, the
schema-head guard, force semantics, and sequence reset), and drops them
again. It never touches the working database, and it runs as part of
`bun run test:integration` (pre-push hook + CI). The dashboard flow has a
manual Playwright spec at `tests/ui/backup.e2e.spec.ts`.
