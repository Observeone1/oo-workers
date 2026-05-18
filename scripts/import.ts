#!/usr/bin/env bun
/**
 * Restore an oo-workers backup produced by `scripts/export.ts` (or the
 * dashboard "Backup" button). Fresh-restore only: the target must be empty,
 * or pass --force to wipe it first. IDs and sequences are preserved.
 *
 * The schema version in the dump must match this instance — migrate the
 * target to the same version before restoring.
 *
 * Usage:
 *   bun scripts/import.ts --from backup.oodump.gz
 *   bun scripts/import.ts --from backup.oodump.gz --force   # wipe non-empty target
 *   bun scripts/import.ts --from ./backup-dir/              # a --split directory
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/import.ts --from /tmp/backup.oodump.gz
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { sql } from '../src/config/db.ts';
import { restore, restoreFromDir, RestoreError } from '../src/services/backup.ts';

interface Args {
  from: string;
  force: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from = '';
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') from = argv[++i] ?? '';
    else if (arg === '--force') force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/import.ts --from <file|dir> [--force]');
      process.exit(0);
    }
  }
  if (!from) {
    console.error('--from is required (a .oodump.gz file or a --split directory)');
    process.exit(2);
  }
  return { from, force };
}

async function main() {
  const { from, force } = parseArgs();
  try {
    const isDir = (await stat(from)).isDirectory();
    const result = isDir
      ? await restoreFromDir(from, { force })
      : await restore(createReadStream(from), { force });
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    console.log(`✅ restore complete (schema ${result.schemaHead}, ${total} rows)`);
    for (const [t, n] of Object.entries(result.counts)) console.log(`   ${t}: ${n}`);
  } catch (err) {
    if (err instanceof RestoreError) {
      console.error(`restore refused: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
