#!/usr/bin/env bun
/**
 * Full logical backup of this oo-workers instance — config + execution
 * history — as a gzip NDJSON dump. The DB-direct power-path; the dashboard
 * "Backup" button is the same dump over HTTP.
 *
 * Usage:
 *   bun scripts/export.ts                         # last 90d → stdout
 *   bun scripts/export.ts -o backup.oodump.gz     # → file
 *   bun scripts/export.ts --scope all -o full.oodump.gz
 *   bun scripts/export.ts --scope none -o config.oodump.gz   # config only
 *   bun scripts/export.ts --since 30 -o recent.oodump.gz
 *   bun scripts/export.ts --split ./backup-dir/   # one .ndjson.gz per table
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/export.ts -o /tmp/backup.oodump.gz
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sql } from '../src/config/db.ts';
import {
  DEFAULT_SINCE_DAYS,
  exportSplit,
  exportStream,
  type DataScope,
} from '../src/services/backup.ts';

interface Args {
  scope: DataScope;
  since: number;
  out: string | null;
  split: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let scope: DataScope = 'window';
  let since = DEFAULT_SINCE_DAYS;
  let out: string | null = null;
  let split: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scope') {
      const v = argv[++i];
      if (v !== 'none' && v !== 'window' && v !== 'all') {
        console.error(`--scope must be none|window|all, got '${v}'`);
        process.exit(2);
      }
      scope = v;
    } else if (arg === '--since') {
      since = Number(argv[++i]);
      if (!Number.isFinite(since) || since <= 0) {
        console.error('--since must be a positive number of days');
        process.exit(2);
      }
      scope = 'window';
    } else if (arg === '-o' || arg === '--out') out = argv[++i] ?? null;
    else if (arg === '--split') split = argv[++i] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun scripts/export.ts [--scope none|window|all] [--since <days>] [-o <file> | --split <dir>]',
      );
      process.exit(0);
    }
  }
  return { scope, since, out, split };
}

async function main() {
  const { scope, since, out, split } = parseArgs();
  const opts = { scope, sinceDays: since };

  if (split) {
    await exportSplit(opts, split);
    console.error(`✅ split backup written to ${split}/`);
  } else {
    const web = exportStream(opts);
    const dest = out ? createWriteStream(out) : process.stdout;
    await pipeline(Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]), dest);
    if (out) console.error(`✅ backup written to ${out}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error('export failed:', err);
  process.exit(1);
});
