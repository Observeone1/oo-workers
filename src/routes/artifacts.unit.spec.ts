/**
 * /api/artifacts HTTP contract — the qa-projects key allowlist, the
 * read-auth gate registration, streaming with inline vs attachment
 * disposition, and the opaque 404/502 error mapping that keeps storage
 * internals out of client responses.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

import {
  authMiddlewareMock,
  mockAuthMiddleware,
  mockObjectStorageSigning,
  resetObjectStorageSigningMock,
  setFullObjectStorageEnv,
  signedFetchRawMock,
} from '../test-support/shared-mocks.ts';

const { requireAuth } = authMiddlewareMock;

mockObjectStorageSigning();
mockAuthMiddleware();
mock.module('../utils/logger.ts', () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {} },
}));

const { registerArtifactsRoutes } = await import('./artifacts.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerArtifactsRoutes(app);
  return app;
}

const GOOD_KEY = 'qa-projects/12-checkout-suite/runs/345/trace.zip';

function lastSignedUrl(): URL {
  const calls = signedFetchRawMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as URL;
}

beforeEach(() => {
  // Shared registrations: prime our own behaviour every time.
  setFullObjectStorageEnv();
  mockObjectStorageSigning();
  signedFetchRawMock.mockResolvedValue(
    new Response('artifact-bytes', { headers: { 'content-type': 'application/zip' } }),
  );
});

afterEach(() => {
  resetObjectStorageSigningMock();
});

describe('GET /api/artifacts', () => {
  test('registers the read-auth gate on the route', () => {
    makeApp();
    expect(requireAuth).toHaveBeenCalledWith('read');
  });

  test.each([
    '',
    'qa-scripts/1-x/script.ts', // wrong prefix
    'qa-projects/12-checkout/runs/345/../../../secrets', // traversal
    'qa-projects/12-checkout/other/345/file.png', // not under runs/
  ])('rejects the key %j', async (key) => {
    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(key)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad or unauthorized key' });
    expect(signedFetchRawMock).not.toHaveBeenCalled();
  });

  test('streams a zip as attachment with upstream content-type', async () => {
    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);

    expect(res.status).toBe(200);
    expect(lastSignedUrl().pathname).toContain('/' + GOOD_KEY);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="trace.zip"');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    expect(await res.text()).toBe('artifact-bytes');
  });

  test('serves non-zip artifacts inline', async () => {
    signedFetchRawMock.mockResolvedValue(
      new Response('png-bytes', { headers: { 'content-type': 'image/png' } }),
    );
    const key = 'qa-projects/12-checkout-suite/runs/345/failure.png';

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(key)}`);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="failure.png"');
  });

  test('maps a missing object to an opaque 404', async () => {
    signedFetchRawMock.mockRejectedValue(
      Object.assign(new Error('NoSuchKey: s3://internal-bucket/...'), { status: 404 }),
    );

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);
    expect(res.status).toBe(404);
    // Storage internals never reach the client.
    expect(await res.json()).toEqual({ error: 'fetch failed' });
  });

  test('maps other storage failures to an opaque 502', async () => {
    signedFetchRawMock.mockRejectedValue(new Error('storage endpoint rustfs:9000 down'));

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'fetch failed' });
  });
});
