#!/usr/bin/env bun
/**
 * Rotate the agent API key for an existing region.
 *
 * Thin wrapper around services/region-admin.ts — the same code path the
 * dashboard's Regions page uses. Old key gets revoked, fresh key gets
 * bound to the region row, region history (executions, last_seen_at,
 * monitor bindings) is preserved.
 *
 * The old agent (still running with the revoked key) starts getting 401
 * on its next long-poll. Restart it with the new key.
 *
 * Usage:
 *   bun scripts/rotate-region-key.ts --slug us-east
 *   bun scripts/rotate-region-key.ts --slug us-east --quiet
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/rotate-region-key.ts --slug us-east
 */

import { sql } from '../src/config/db.ts';
import { regionRepo } from '../src/db/repositories/region.repo.ts';
import { rotateRegionKey, RegionAdminError } from '../src/services/region-admin.ts';

interface Args {
  slug: string;
  quiet: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let slug = '';
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--slug') slug = argv[++i] ?? '';
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/rotate-region-key.ts --slug <slug> [--quiet]');
      process.exit(0);
    }
  }
  if (!slug) {
    console.error('--slug is required');
    process.exit(2);
  }
  return { slug, quiet };
}

async function main() {
  const { slug, quiet } = parseArgs();

  const existing = await regionRepo.findBySlug(slug);
  if (!existing) {
    console.error(`region '${slug}' not found`);
    process.exit(1);
  }

  let result;
  try {
    result = await rotateRegionKey(existing.id);
  } catch (err) {
    if (err instanceof RegionAdminError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { region, cleartextKey } = result;

  if (quiet) {
    process.stdout.write(cleartextKey);
  } else {
    console.log(`✅ rotated region #${region.id} '${region.slug}'`);
    console.log('   old agent key revoked, new key issued');
    console.log('');
    console.log('   agent env (copy now — key will not be shown again):');
    console.log(`     OO_MASTER_URL=https://your-master.example.com`);
    console.log(`     OO_REGION_SLUG=${region.slug}`);
    console.log(`     OO_AGENT_KEY=${cleartextKey}`);
    console.log('');
    console.log('   restart the agent on the regional box to pick up the new key.');
  }
  await sql.end();
}

main().catch((err) => {
  console.error('rotate-region-key failed:', err);
  process.exit(1);
});
