#!/usr/bin/env bun
/**
 * Register a new region + provision an agent API key for it.
 *
 * Two side effects:
 *   1. Insert a row into `regions` with the given slug + label
 *   2. Insert a row into `api_keys` with scope=['agent'] bound to that region
 *
 * The cleartext key is printed once and never stored — paste it into the
 * agent box's env as `OO_AGENT_KEY=...`. Along with `OO_MASTER_URL` and
 * `OO_REGION_SLUG` (matching --slug), that's everything the agent needs.
 *
 * Usage:
 *   bun scripts/create-region.ts --slug us-east --label "US East (Virginia)"
 *   bun scripts/create-region.ts --slug us-east --label "US East" --quiet
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/create-region.ts --slug us-east --label "US East"
 */

import { randomBytes } from 'node:crypto';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { regionRepo } from '../src/db/repositories/region.repo.ts';
import { sql } from '../src/config/db.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';

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
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/.test(slug)) {
    console.error('--slug must be lowercase alphanumeric + dashes, max 64 chars');
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

  const existing = await regionRepo.findBySlug(slug);
  if (existing) {
    console.error(`region '${slug}' already exists (id=${existing.id})`);
    process.exit(1);
  }

  // 32 bytes → 43 base64url chars (no padding).
  const raw = randomBytes(32).toString('base64url');
  const cleartext = `oo_${raw}`;
  const keyPrefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });

  const [key] = await apiKeyRepo.create({
    name: `agent:${slug}`,
    keyPrefix,
    keyHash,
    scopes: ['agent'],
  });
  const [region] = await regionRepo.create({
    slug,
    label,
    apiKeyId: key.id,
  });

  if (quiet) {
    process.stdout.write(cleartext);
  } else {
    console.log(`✅ created region #${region.id} '${slug}' (${label})`);
    console.log(`   agent key #${key.id} prefix: ${keyPrefix}`);
    console.log('');
    console.log('   agent env (copy now — key will not be shown again):');
    console.log(`     OO_MASTER_URL=https://your-master.example.com`);
    console.log(`     OO_REGION_SLUG=${slug}`);
    console.log(`     OO_AGENT_KEY=${cleartext}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error('create-region failed:', err);
  process.exit(1);
});
