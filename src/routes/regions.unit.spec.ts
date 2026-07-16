/**
 * /api/regions HTTP contract — driven through a real Hono app via
 * app.request(): the online/version-skew projection, create with one-time
 * cleartext key, delete, rotate, and the RegionAdminError -> status-code
 * mapping. The repo and admin service are mocked at their module
 * boundaries; route logic itself runs for real.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

class FakeRegionAdminError extends Error {
  constructor(
    message: string,
    public code: 'invalid_slug' | 'slug_taken' | 'not_found',
  ) {
    super(message);
  }
}

const list = mock(async (): Promise<unknown[]> => []);
const createRegionWithKey = mock(async (_s: string, _l: string): Promise<unknown> => ({}));
const rotateRegionKey = mock(async (_id: number): Promise<unknown> => ({}));
const deleteRegion = mock(async (_id: number): Promise<void> => {});

mock.module('../db/repositories/region.repo.ts', () => ({
  regionRepo: { list },
}));
mock.module('../services/region-admin.ts', () => ({
  RegionAdminError: FakeRegionAdminError,
  createRegionWithKey,
  rotateRegionKey,
  deleteRegion,
}));
mock.module('../utils/version.ts', () => ({
  packageVersion: () => '2.5.0',
}));

const { registerRegionRoutes } = await import('./regions.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerRegionRoutes(app);
  return app;
}

beforeEach(() => {
  list.mockReset();
  createRegionWithKey.mockReset();
  rotateRegionKey.mockReset();
  deleteRegion.mockReset();
  list.mockResolvedValue([]);
});

describe('GET /api/regions', () => {
  test('projects online status and version skew per region', async () => {
    const now = Date.now();
    list.mockResolvedValue([
      {
        id: 1,
        slug: 'eu',
        label: 'EU',
        lastSeenAt: new Date(now - 10_000),
        createdAt: new Date('2026-01-01'),
        agentVersion: '2.5.0',
      },
      {
        id: 2,
        slug: 'us',
        label: 'US',
        lastSeenAt: new Date(now - 120_000),
        createdAt: new Date('2026-01-01'),
        agentVersion: '2.4.0',
      },
      {
        id: 3,
        slug: 'ap',
        label: 'AP',
        lastSeenAt: null,
        createdAt: new Date('2026-01-01'),
        agentVersion: null,
      },
    ]);

    const res = await makeApp().request('/api/regions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;

    expect(body.map((r) => [r.slug, r.online, r.versionSkew])).toEqual([
      ['eu', true, false], // fresh + same version
      ['us', false, true], // stale + skewed
      ['ap', false, false], // never seen, no version = no skew warning
    ]);
    expect(body[0].masterVersion).toBe('2.5.0');
  });
});

describe('POST /api/regions', () => {
  test('requires slug and label', async () => {
    const res = await makeApp().request('/api/regions', {
      method: 'POST',
      body: JSON.stringify({ slug: '  ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'slug and label are required' });
    expect(createRegionWithKey).not.toHaveBeenCalled();
  });

  test('creates a region and returns the one-time cleartext key', async () => {
    createRegionWithKey.mockResolvedValue({
      region: {
        id: 7,
        slug: 'eu-central',
        label: 'EU Central',
        createdAt: '2026-07-17T00:00:00.000Z',
        apiKeyId: 12,
      },
      cleartextKey: 'oo_secret',
    });

    const res = await makeApp().request('/api/regions', {
      method: 'POST',
      body: JSON.stringify({ slug: ' eu-central ', label: ' EU Central ' }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      region: {
        id: 7,
        slug: 'eu-central',
        label: 'EU Central',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
      cleartextKey: 'oo_secret',
    });
    // Inputs are trimmed before hitting the service.
    expect(createRegionWithKey).toHaveBeenCalledWith('eu-central', 'EU Central');
  });

  test('maps slug_taken to 409 and invalid_slug to 400', async () => {
    createRegionWithKey.mockRejectedValue(new FakeRegionAdminError('taken', 'slug_taken'));
    const conflict = await makeApp().request('/api/regions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'eu', label: 'EU' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'taken', code: 'slug_taken' });

    createRegionWithKey.mockRejectedValue(new FakeRegionAdminError('bad', 'invalid_slug'));
    const invalid = await makeApp().request('/api/regions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'EU', label: 'EU' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('DELETE /api/regions/:id', () => {
  test('rejects a non-numeric id', async () => {
    const res = await makeApp().request('/api/regions/abc', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(deleteRegion).not.toHaveBeenCalled();
  });

  test('deletes and returns 204', async () => {
    const res = await makeApp().request('/api/regions/3', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteRegion).toHaveBeenCalledWith(3);
  });

  test('maps not_found to 404', async () => {
    deleteRegion.mockRejectedValue(new FakeRegionAdminError('missing', 'not_found'));
    const res = await makeApp().request('/api/regions/99', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/regions/:id/rotate-key', () => {
  test('rotates and returns the new cleartext key', async () => {
    rotateRegionKey.mockResolvedValue({
      region: { id: 3, slug: 'us-east', label: 'US East', apiKeyId: 55 },
      cleartextKey: 'oo_rotated',
    });

    const res = await makeApp().request('/api/regions/3/rotate-key', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      region: { id: 3, slug: 'us-east', label: 'US East' },
      cleartextKey: 'oo_rotated',
    });
  });

  test('maps not_found to 404 and bad ids to 400', async () => {
    rotateRegionKey.mockRejectedValue(new FakeRegionAdminError('missing', 'not_found'));
    expect((await makeApp().request('/api/regions/99/rotate-key', { method: 'POST' })).status).toBe(
      404,
    );
    expect((await makeApp().request('/api/regions/x/rotate-key', { method: 'POST' })).status).toBe(
      400,
    );
  });
});
