#!/usr/bin/env bun
/**
 * One-shot SaaS → self-host config import.
 *
 * Chains: `obs export` (or a pre-exported file) → in-process adapt →
 * `POST /api/import` with an API key. Replaces the old broken manual
 * two-step (the adapter used to emit a schema `/api/import` didn't read,
 * so it silently imported nothing).
 *
 * Usage:
 *   bun scripts/import-from-saas.ts --from saas-export.json --key oo_…
 *   bun scripts/import-from-saas.ts --key oo_… --url https://monitor.example.com
 *   bun scripts/import-from-saas.ts --from saas-export.json --dry-run
 *
 * Auth: --key <oo_…> or OO_IMPORT_KEY env (an API key with write scope —
 * mint one with scripts/create-api-key.ts). Not needed for --dry-run.
 *
 * Carries across: HTTP monitors, API checks, QA suites (with inline
 * scripts), alert channels of a supported type, status pages, and
 * heartbeats (with their ping URL preserved via CLI v1.26.0 ping_key).
 * Whatever can't be brought across (incidents, plus scriptless suites
 * and unsupported/invalid channels) is reported with a count, never
 * silently dropped.
 *
 * Re-running is NOT idempotent and NOT an upsert. There is no unique
 * constraint on names, so /api/import happily creates duplicates on a
 * second run (it does not skip or reconcile) — for channels a duplicate
 * means double-alerting on every outage. This script does a pre-flight
 * name-collision check (monitors AND channels) and refuses to post
 * colliding names unless --allow-duplicates is passed.
 */

import { adaptSaaSExport } from './adapt-cli-export.ts';
import {
  ensureNoNameCollisions,
  logAdaptSummary,
  postImportPayload,
} from './import-from-saas-helpers.ts';

interface Args {
  from: string | null;
  url: string;
  key: string;
  dryRun: boolean;
  allowDuplicates: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from: string | null = null;
  let url = process.env.OO_IMPORT_URL ?? 'http://localhost:3001';
  let key = process.env.OO_IMPORT_KEY ?? '';
  let dryRun = false;
  let allowDuplicates = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') from = argv[++i] ?? null;
    else if (arg === '--url') url = argv[++i] ?? url;
    else if (arg === '--key') key = argv[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-duplicates') allowDuplicates = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun scripts/import-from-saas.ts [--from <file>] [--url <base>] [--key <oo_…>] [--dry-run] [--allow-duplicates]',
      );
      process.exit(0);
    }
  }
  return { from, url: url.replace(/\/$/, ''), key, dryRun, allowDuplicates };
}

async function loadSaasExport(from: string | null): Promise<unknown> {
  if (from) return JSON.parse(await Bun.file(from).text());
  // No file → shell the installed, logged-in CLI.
  const proc = Bun.spawn(['obs', 'export', '--include-scripts'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.error(`\`obs export\` failed (exit ${proc.exitCode}). ${err.trim()}`);
    console.error('Install/login the obs CLI, or pass --from <file> with a pre-exported JSON.');
    process.exit(1);
  }
  try {
    return JSON.parse(out);
  } catch {
    console.error('`obs export` did not return JSON. Pass --from <file> instead.');
    process.exit(1);
  }
}

async function main() {
  const { from, url, key, dryRun, allowDuplicates } = parseArgs();

  const { payload, skipped, warnings } = adaptSaaSExport(
    (await loadSaasExport(from)) as Parameters<typeof adaptSaaSExport>[0],
  );
  logAdaptSummary(payload, skipped, warnings);

  if (dryRun) {
    console.log('--dry-run: nothing posted.');
    return;
  }

  if (!key) {
    console.error('--key <oo_…> or OO_IMPORT_KEY required (an API key with write scope).');
    process.exit(2);
  }

  await ensureNoNameCollisions(url, key, payload, allowDuplicates);
  await postImportPayload(url, key, payload);
}

try {
  await main();
} catch (err) {
  console.error('import-from-saas failed:', err);
  process.exit(1);
}
