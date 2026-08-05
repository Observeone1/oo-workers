/**
 * Region repository contract — create, deleteById, and the
 * monitorRegionRepo set/clearForMonitor delete+insert transaction against
 * the real Postgres schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { regionRepo, monitorRegionRepo } from '../../src/db/repositories/region.repo.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';

const sql = connectDb();
const marker = `region-repo-it-${Date.now()}`;
let apiKeyId = -1;
let regionId = -1;
const monitorId = 999_000_002;

beforeAll(async () => {
  const [key] = await apiKeyRepo.create({
    name: marker,
    keyPrefix: marker.slice(0, 20),
    keyHash: 'x'.repeat(20),
  });
  apiKeyId = key.id;

  const [region] = await regionRepo.create({ slug: marker, label: 'IT Region', apiKeyId });
  regionId = region.id;
}, 30_000);

afterAll(async () => {
  await monitorRegionRepo.clearForMonitor('url', monitorId);
  if (regionId > 0) await sql`DELETE FROM regions WHERE id = ${regionId}`;
  if (apiKeyId > 0) await sql`DELETE FROM api_keys WHERE id = ${apiKeyId}`;
  await sql.end();
});

describe('regionRepo', () => {
  test('create inserts a region row with the given slug/label/apiKeyId', async () => {
    const region = await regionRepo.findBySlug(marker);
    expect(region?.id).toBe(regionId);
    expect(region?.label).toBe('IT Region');
    expect(region?.apiKeyId).toBe(apiKeyId);
  });

  test('deleteById removes the region row', async () => {
    const [key] = await apiKeyRepo.create({
      name: `${marker}-2`,
      keyPrefix: `${marker.slice(0, 15)}-2`,
      keyHash: 'y'.repeat(20),
    });
    const [toDelete] = await regionRepo.create({
      slug: `${marker}-to-delete`,
      label: 'To delete',
      apiKeyId: key.id,
    });

    await regionRepo.deleteById(toDelete.id);
    expect(await regionRepo.findById(toDelete.id)).toBeNull();

    await sql`DELETE FROM api_keys WHERE id = ${key.id}`;
  });
});

describe('monitorRegionRepo', () => {
  test('set atomically replaces bound regions; empty array clears them', async () => {
    await monitorRegionRepo.set('url', monitorId, [regionId]);
    let bound = await monitorRegionRepo.forMonitor('url', monitorId);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.id).toBe(regionId);
    expect(bound[0]?.slug).toBe(marker);

    // Re-set with an empty array must delete the prior binding, not insert nothing.
    await monitorRegionRepo.set('url', monitorId, []);
    bound = await monitorRegionRepo.forMonitor('url', monitorId);
    expect(bound).toEqual([]);
  });

  test('clearForMonitor removes bindings without affecting other monitor types', async () => {
    await monitorRegionRepo.set('url', monitorId, [regionId]);
    await monitorRegionRepo.set('api', monitorId, [regionId]);

    await monitorRegionRepo.clearForMonitor('url', monitorId);

    expect(await monitorRegionRepo.forMonitor('url', monitorId)).toEqual([]);
    expect(await monitorRegionRepo.forMonitor('api', monitorId)).toHaveLength(1);

    await monitorRegionRepo.clearForMonitor('api', monitorId);
  });
});
