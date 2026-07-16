/**
 * /api/artifacts HTTP contract — the qa-projects key allowlist, the
 * read-auth gate registration, streaming with inline vs attachment
 * disposition, and the opaque 404/502 error mapping that keeps storage
 * internals out of client responses.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const getObjectResponse = mock(async (_key: string): Promise<Response> => new Response(''));
const requireAuth = mock((_scope: string) => {
  return async (_c: unknown, next: () => Promise<void>) => next();
});

mock.module('../services/object-storage.ts', () => ({ getObjectResponse }));
mock.module('../middleware/auth.ts', () => ({ requireAuth }));
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

beforeEach(() => {
  getObjectResponse.mockReset();
  getObjectResponse.mockResolvedValue(
    new Response('artifact-bytes', { headers: { 'content-type': 'application/zip' } }),
  );
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
    expect(getObjectResponse).not.toHaveBeenCalled();
  });

  test('streams a zip as attachment with upstream content-type', async () => {
    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);

    expect(res.status).toBe(200);
    expect(getObjectResponse).toHaveBeenCalledWith(GOOD_KEY);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="trace.zip"');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    expect(await res.text()).toBe('artifact-bytes');
  });

  test('serves non-zip artifacts inline', async () => {
    getObjectResponse.mockResolvedValue(
      new Response('png-bytes', { headers: { 'content-type': 'image/png' } }),
    );
    const key = 'qa-projects/12-checkout-suite/runs/345/failure.png';

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(key)}`);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="failure.png"');
  });

  test('maps a missing object to an opaque 404', async () => {
    getObjectResponse.mockRejectedValue(
      Object.assign(new Error('NoSuchKey: s3://internal-bucket/...'), { status: 404 }),
    );

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);
    expect(res.status).toBe(404);
    // Storage internals never reach the client.
    expect(await res.json()).toEqual({ error: 'fetch failed' });
  });

  test('maps other storage failures to an opaque 502', async () => {
    getObjectResponse.mockRejectedValue(new Error('endpoint http://rustfs:9000 down'));

    const res = await makeApp().request(`/api/artifacts?key=${encodeURIComponent(GOOD_KEY)}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'fetch failed' });
  });
});
