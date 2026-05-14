#!/usr/bin/env bun
/**
 * Register a new region + provision an agent API key for it.
 *
 * Thin wrapper around services/region-admin.ts — the same code path the
 * dashboard's Regions page uses. The cleartext key is printed once and
 * never stored; paste it into the agent box's env as `OO_AGENT_KEY=...`.
 *
 * Usage:
 *   bun scripts/create-region.ts --slug us-east --label "US East (Virginia)"
 *   bun scripts/create-region.ts --slug us-east --label "US East" --quiet
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/create-region.ts --slug us-east --label "US East"
 */

import { sql } from '../src/config/db.ts';
import { createRegionWithKey, RegionAdminError } from '../src/services/region-admin.ts';

interface Args {
  slug: string;
  label: string;
  quiet: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let slug = '';
  let label = '';
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--slug') slug = argv[++i] ?? '';
    else if (arg === '--label') label = argv[++i] ?? '';
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/create-region.ts --slug <slug> --label <label> [--quiet]');
      process.exit(0);
    }
  }
  if (!slug) {
    console.error('--slug is required (e.g. us-east, eu-west)');
    process.exit(2);
  }
  if (!label) {
    console.error('--label is required (e.g. "US East (Virginia)")');
    process.exit(2);
  }
  return { slug, label, quiet };
}

async function main() {
  const { slug, label, quiet } = parseArgs();

  let result;
  try {
    result = await createRegionWithKey(slug, label);
  } catch (err) {
    if (err instanceof RegionAdminError) {
      console.error(err.message);
      process.exit(err.code === 'slug_taken' ? 1 : 2);
    }
    throw err;
  }
  const { region, cleartextKey } = result;

  if (quiet) {
    process.stdout.write(cleartextKey);
  } else {
    console.log(`✅ created region #${region.id} '${region.slug}' (${region.label})`);
    console.log('');
    console.log('   agent env (copy now — key will not be shown again):');
    console.log(`     OO_MASTER_URL=https://your-master.example.com`);
    console.log(`     OO_REGION_SLUG=${region.slug}`);
    console.log(`     OO_AGENT_KEY=${cleartextKey}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error('create-region failed:', err);
  process.exit(1);
});
