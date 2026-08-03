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
 *   bun scripts/export.ts --include-artifacts -o full.oodump.tar.gz   # DB + S3
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
  includeArtifacts: boolean;
}

function readValueArg(argv: string[], index: number, flag: string): string | null {
  const value = argv[index + 1];
  if (value == null) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function applyFlag(args: Args, argv: string[], index: number): number {
  const arg = argv[index];
  if (arg === '--scope') {
    const v = readValueArg(argv, index, '--scope');
    if (v !== 'none' && v !== 'window' && v !== 'all') {
      console.error(`--scope must be none|window|all, got '${v}'`);
      process.exit(2);
    }
    args.scope = v;
    return index + 2;
  }
  if (arg === '--since') {
    const since = Number(readValueArg(argv, index, '--since'));
    if (!Number.isFinite(since) || since <= 0) {
      console.error('--since must be a positive number of days');
      process.exit(2);
    }
    args.since = since;
    args.scope = 'window';
    return index + 2;
  }
  if (arg === '-o' || arg === '--out') {
    args.out = readValueArg(argv, index, arg);
    return index + 2;
  }
  if (arg === '--split') {
    args.split = readValueArg(argv, index, '--split');
    return index + 2;
  }
  if (arg === '--include-artifacts') {
    args.includeArtifacts = true;
    return index + 1;
  }
  if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage: bun scripts/export.ts [--scope none|window|all] [--since <days>]\n' +
        '                            [-o <file> | --split <dir>] [--include-artifacts]',
    );
    process.exit(0);
  }
  console.error(`unknown argument: ${arg}`);
  process.exit(2);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    scope: 'window',
    since: DEFAULT_SINCE_DAYS,
    out: null,
    split: null,
    includeArtifacts: false,
  };
  let index = 0;
  while (index < argv.length) {
    index = applyFlag(args, argv, index);
  }
  if (args.includeArtifacts && args.split) {
    console.error('--include-artifacts is not compatible with --split (use -o instead)');
    process.exit(2);
  }
  return args;
}

async function main() {
  const { scope, since, out, split, includeArtifacts } = parseArgs();
  const opts = { scope, sinceDays: since, includeArtifacts };

  if (split) {
    await exportSplit(opts, split);
    console.error(`✅ split backup written to ${split}/`);
  } else {
    const web = exportStream(opts);
    const dest = out ? createWriteStream(out) : process.stdout;
    await pipeline(Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]), dest);
    if (out) {
      const suffix = includeArtifacts ? ' (with artifacts)' : '';
      console.error(`✅ backup written to ${out}${suffix}`);
    }
  }
  await sql.end();
}

try {
  await main();
} catch (err) {
  console.error('export failed:', err);
  process.exit(1);
}
