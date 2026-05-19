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
 * Carries HTTP monitors + API checks across. SaaS QA suites, alert
 * channels, status pages, heartbeats and incidents are reported as
 * skipped, not transferred — full parity is a separate follow-up.
 *
 * Re-running is NOT idempotent and NOT an upsert. There is no unique
 * constraint on monitor names, so /api/import happily creates duplicates
 * on a second run (it does not skip or reconcile). This script does a
 * pre-flight name-collision check against the target and refuses to post
 * colliding names unless --allow-duplicates is passed.
 */

import { adaptSaaSExport } from './adapt-cli-export.ts';

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

  const { payload, skipped } = adaptSaaSExport(
    (await loadSaasExport(from)) as Parameters<typeof adaptSaaSExport>[0],
  );
  const notTransferred = Object.entries(skipped).filter(([, n]) => n > 0);

  console.log(
    `adapted: urlMonitors=${payload.urlMonitors.length} apiChecks=${payload.apiChecks.length} qaProjects=${payload.qaProjects.length}`,
  );
  if (notTransferred.length) {
    console.log(
      `not transferred (no self-host import yet): ${notTransferred
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')}`,
    );
  }

  if (dryRun) {
    console.log('--dry-run: nothing posted.');
    return;
  }

  if (!key) {
    console.error('--key <oo_…> or OO_IMPORT_KEY required (an API key with write scope).');
    process.exit(2);
  }

  // Pre-flight: /api/import has no unique-name constraint, so re-running
  // duplicates rather than skipping. Refuse colliding names up front.
  const listRes = await fetch(`${url}/api/monitors`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (listRes.ok) {
    const existing = (await listRes.json()) as Record<string, Array<{ name: string }>>;
    const have = new Set([
      ...(existing.url ?? []).map((m) => `url:${m.name}`),
      ...(existing.api ?? []).map((m) => `api:${m.name}`),
    ]);
    const collisions = [
      ...payload.urlMonitors.filter((m) => have.has(`url:${m.name}`)).map((m) => `url ${m.name}`),
      ...payload.apiChecks.filter((m) => have.has(`api:${m.name}`)).map((m) => `api ${m.name}`),
    ];
    if (collisions.length && !allowDuplicates) {
      console.error(
        `\n⚠ ${collisions.length} name(s) already exist on the target. /api/import is not ` +
          `idempotent and has no unique-name constraint — posting these would create ` +
          `DUPLICATES, not update or skip them:`,
      );
      for (const c of collisions) console.error(`  - ${c}`);
      console.error(
        '\nTreat import as a one-time seed. Re-run with --allow-duplicates to override.',
      );
      process.exit(1);
    }
    if (collisions.length) {
      console.warn(
        `⚠ proceeding with ${collisions.length} duplicate name(s) (--allow-duplicates).`,
      );
    }
  }

  const res = await fetch(`${url}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`POST ${url}/api/import → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const result = (await res.json()) as {
    url: number;
    api: number;
    qa: number;
    tcp: number;
    udp: number;
    skipped?: string[];
  };
  console.log(`imported: url=${result.url} api=${result.api}`);

  // The pre-flight handles re-import collisions; anything here is a
  // per-item server-side creation error (bad field, validation, etc.).
  const errored = result.skipped ?? [];
  if (errored.length) {
    console.warn(`\n⚠ ${errored.length} item(s) the server could not create:`);
    for (const s of errored) console.warn(`  - ${s}`);
    process.exit(1);
  }
  console.log('✓ done.');
}

main().catch((err) => {
  console.error('import-from-saas failed:', err);
  process.exit(1);
});
