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
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { regionRepo } from '../src/db/repositories/region.repo.ts';
import { db, sql } from '../src/config/db.ts';
import { apiKeys, regions } from '../src/db/schema.ts';
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

  // Atomic rotate inside one transaction: create the new key, rebind the
  // region to it, revoke the old key. If anything fails the operator
  // re-runs and we don't leak agent-scoped credential rows that aren't
  // bound to any region.
  const oldKeyId = region.apiKeyId;
  const newKey = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({ name: `agent:${slug}`, keyPrefix, keyHash, scopes: ['agent'] })
      .returning();
    await tx.update(regions).set({ apiKeyId: created.id }).where(eq(regions.id, region.id));
    await tx
      .update(apiKeys)
      .set({ revokedAt: drizzleSql`NOW()` })
      .where(eq(apiKeys.id, oldKeyId));
    return created;
  });

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
