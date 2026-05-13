#!/usr/bin/env bun
/**
 * Rotate the agent API key for an existing region.
 *
 * Use case: the old key leaked, or you're cycling credentials on a
 * schedule. Old key gets revoked, fresh key gets bound to the region
 * row, region history (executions, last_seen_at) is preserved.
 *
 * The old agent (still running with the revoked key) starts getting 401
 * on its next long-poll. Restart it with the new key — the region row
 * is the same, so monitor bindings carry over.
 *
 * Usage:
 *   bun scripts/rotate-region-key.ts --slug us-east
 *   bun scripts/rotate-region-key.ts --slug us-east --quiet
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/rotate-region-key.ts --slug us-east
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { regionRepo } from '../src/db/repositories/region.repo.ts';
import { db, sql } from '../src/config/db.ts';
import { regions } from '../src/db/schema.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';

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

  const region = await regionRepo.findBySlug(slug);
  if (!region) {
    console.error(`region '${slug}' not found`);
    process.exit(1);
  }

  // 32 bytes → 43 base64url chars (no padding).
  const raw = randomBytes(32).toString('base64url');
  const cleartext = `oo_${raw}`;
  const keyPrefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });

  // Issue the new key first, then atomically swap the region's binding
  // before revoking the old key. Order matters: while the swap is in
  // flight, an agent presenting the old key still hits a valid row and
  // the requireAgent middleware finds the region via api_key_id. As
  // soon as we update regions.api_key_id, the old key's row no longer
  // maps to any region → requireAgent returns 403. Then we revoke
  // the old key for completeness.
  const [newKey] = await apiKeyRepo.create({
    name: `agent:${slug}`,
    keyPrefix,
    keyHash,
    scopes: ['agent'],
  });

  const oldKeyId = region.apiKeyId;
  await db.update(regions).set({ apiKeyId: newKey.id }).where(eq(regions.id, region.id));
  await apiKeyRepo.revoke(oldKeyId);

  if (quiet) {
    process.stdout.write(cleartext);
  } else {
    console.log(`✅ rotated region #${region.id} '${slug}'`);
    console.log(`   old key #${oldKeyId} revoked`);
    console.log(`   new key #${newKey.id} prefix: ${keyPrefix}`);
    console.log('');
    console.log('   agent env (copy now — key will not be shown again):');
    console.log(`     OO_MASTER_URL=https://your-master.example.com`);
    console.log(`     OO_REGION_SLUG=${slug}`);
    console.log(`     OO_AGENT_KEY=${cleartext}`);
    console.log('');
    console.log('   restart the agent on the regional box to pick up the new key.');
  }
  await sql.end();
}

main().catch((err) => {
  console.error('rotate-region-key failed:', err);
  process.exit(1);
});
