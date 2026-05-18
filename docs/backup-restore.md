# Backup & restore

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

Not included: sessions (transient — log in again after a restore), and
object-storage artifacts (Playwright `trace.zip` / screenshots). The dump
is the database only.

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
# Back up
docker compose exec worker bun scripts/export.ts -o /tmp/backup.oodump.gz
docker compose exec worker bun scripts/export.ts --scope all -o /tmp/full.oodump.gz
docker compose exec worker bun scripts/export.ts --scope none -o /tmp/config.oodump.gz
docker compose exec worker bun scripts/export.ts --since 30 -o /tmp/recent.oodump.gz

# Back up split across one file per table (parallel; good for huge instances)
docker compose exec worker bun scripts/export.ts --split /tmp/backup-dir/

# Restore (target must be empty, or pass --force to wipe it first)
docker compose exec worker bun scripts/import.ts --from /tmp/backup.oodump.gz --force
docker compose exec worker bun scripts/import.ts --from /tmp/backup-dir/ --force
```

`--scope`: `window` (default, last `--since` days), `all`, or `none`
(config only). The single-file dump and a `--split` directory are
interchangeable — `import.ts` reconstructs the same ordering from either.

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
