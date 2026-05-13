/**
 * Region admin operations — shared between the HTTP endpoints in
 * server.ts and the CLI scripts (create-region.ts, rotate-region-key.ts).
 *
 * The cleartext key is only ever returned from these functions, never
 * stored. Callers must surface it to the operator immediately and not
 * persist it anywhere else.
 */

import { randomBytes } from 'node:crypto';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { apiKeys, regions } from '../db/schema.ts';
import { regionRepo, type RegionRow } from '../db/repositories/region.repo.ts';
import { KEY_PREFIX_LEN } from '../middleware/auth.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

export interface CreatedRegion {
  region: RegionRow;
  cleartextKey: string;
}

async function generateKey(): Promise<{
  cleartext: string;
  keyPrefix: string;
  keyHash: string;
}> {
  const raw = randomBytes(32).toString('base64url');
  const cleartext = `oo_${raw}`;
  const keyPrefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  return { cleartext, keyPrefix, keyHash };
}

export class RegionAdminError extends Error {
  constructor(
    message: string,
    public code: 'invalid_slug' | 'slug_taken' | 'not_found',
  ) {
    super(message);
  }
}

export async function createRegionWithKey(slug: string, label: string): Promise<CreatedRegion> {
  if (!SLUG_RE.test(slug)) {
    throw new RegionAdminError(
      'slug must be lowercase alphanumeric + dashes, max 64 chars',
      'invalid_slug',
    );
  }
  if (await regionRepo.findBySlug(slug)) {
    throw new RegionAdminError(`region '${slug}' already exists`, 'slug_taken');
  }
  const { cleartext, keyPrefix, keyHash } = await generateKey();

  const region = await db.transaction(async (tx) => {
    const [key] = await tx
      .insert(apiKeys)
      .values({ name: `agent:${slug}`, keyPrefix, keyHash, scopes: ['agent'] })
      .returning();
    const [r] = await tx.insert(regions).values({ slug, label, apiKeyId: key.id }).returning();
    return r;
  });

  return { region, cleartextKey: cleartext };
}

export async function rotateRegionKey(regionId: number): Promise<CreatedRegion> {
  const region = await regionRepo.findById(regionId);
  if (!region) {
    throw new RegionAdminError(`region #${regionId} not found`, 'not_found');
  }
  const { cleartext, keyPrefix, keyHash } = await generateKey();
  const oldKeyId = region.apiKeyId;

  const updatedRegion = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({ name: `agent:${region.slug}`, keyPrefix, keyHash, scopes: ['agent'] })
      .returning();
    const [r] = await tx
      .update(regions)
      .set({ apiKeyId: created.id })
      .where(eq(regions.id, region.id))
      .returning();
    await tx
      .update(apiKeys)
      .set({ revokedAt: drizzleSql`NOW()` })
      .where(eq(apiKeys.id, oldKeyId));
    return r;
  });

  return { region: updatedRegion, cleartextKey: cleartext };
}

export async function deleteRegion(regionId: number): Promise<void> {
  const region = await regionRepo.findById(regionId);
  if (!region) {
    throw new RegionAdminError(`region #${regionId} not found`, 'not_found');
  }
  // Revoke the agent key first — the FK is ON DELETE RESTRICT to prevent
  // accidental deletion of api_keys that still have an active region.
  // Once the region row is gone, the api_key has no purpose, so revoking
  // it makes it unusable AND keeps it as forensic history.
  await db.transaction(async (tx) => {
    await tx
      .update(apiKeys)
      .set({ revokedAt: drizzleSql`NOW()` })
      .where(eq(apiKeys.id, region.apiKeyId));
    // monitor_regions cascades automatically (ON DELETE CASCADE).
    await tx.delete(regions).where(eq(regions.id, region.id));
  });
}
