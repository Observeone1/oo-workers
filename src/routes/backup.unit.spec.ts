/**
 * /api/backup + /api/restore HTTP contract — scope/since/includeArtifacts
 * parsing, the download headers per dump format, the estimate fallback,
 * and restore's body/force/error mapping. The backup service is mocked at
 * its module boundary; route logic runs through a real Hono app.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

class FakeRestoreError extends Error {}

const estimateArtifacts = mock(async (): Promise<unknown> => ({}));
const exportStream = mock((_opts: Record<string, unknown>): ReadableStream => {
  return new Response('dump-bytes').body!;
});
const restore = mock(
  async (_body: unknown, _opts: Record<string, unknown>): Promise<unknown> => ({}),
);

mock.module('../services/backup.ts', () => ({
  DEFAULT_SINCE_DAYS: 90,
  estimateArtifacts,
  exportStream,
  restore,
  RestoreError: FakeRestoreError,
}));
mock.module('../utils/logger.ts', () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {} },
}));

const { registerBackupRoutes } = await import('./backup.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerBackupRoutes(app);
  return app;
}

beforeEach(() => {
  estimateArtifacts.mockReset();
  exportStream.mockReset();
  restore.mockReset();
  estimateArtifacts.mockResolvedValue({ artifactCount: 3, artifactBytes: 1024 });
  exportStream.mockImplementation(() => new Response('dump-bytes').body!);
  restore.mockResolvedValue({ ok: true, tables: 12 });
});

describe('GET /api/backup', () => {
  test('streams the legacy gzip dump with a windowed default scope', async () => {
    const res = await makeApp().request('/api/backup');

    expect(exportStream).toHaveBeenCalledWith({
      scope: 'window',
      sinceDays: 90,
      includeArtifacts: false,
    });
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const disposition = res.headers.get('content-disposition')!;
    expect(disposition).toStartWith('attachment; filename="oo-backup-');
    expect(disposition).toEndWith('.oodump.gz"');
    expect(await res.text()).toBe('dump-bytes');
  });

  test('switches to the tar.gz envelope with artifacts and honours scope/since', async () => {
    const res = await makeApp().request('/api/backup?scope=all&since=30&includeArtifacts=1');

    expect(exportStream).toHaveBeenCalledWith({
      scope: 'all',
      sinceDays: 30,
      includeArtifacts: true,
    });
    expect(res.headers.get('content-disposition')).toEndWith('.oodump.tar.gz"');
  });

  test('falls back to the window scope for unknown scope values', async () => {
    await makeApp().request('/api/backup?scope=everything');
    expect(exportStream).toHaveBeenCalledWith(expect.objectContaining({ scope: 'window' }));
  });
});

describe('GET /api/backup/estimate', () => {
  test('returns the artifact estimate', async () => {
    const res = await makeApp().request('/api/backup/estimate');
    expect(await res.json()).toEqual({ artifactCount: 3, artifactBytes: 1024 });
  });

  test('degrades to 0/0 when the estimate fails', async () => {
    estimateArtifacts.mockRejectedValue(new Error('no storage'));
    const res = await makeApp().request('/api/backup/estimate');
    expect(await res.json()).toEqual({ artifactCount: 0, artifactBytes: 0 });
  });
});

describe('POST /api/restore', () => {
  test('requires a request body', async () => {
    const res = await makeApp().request('/api/restore', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'request body required (the .oodump.gz)',
    });
    expect(restore).not.toHaveBeenCalled();
  });

  test('restores and reports the result, defaulting force to false', async () => {
    const res = await makeApp().request('/api/restore', {
      method: 'POST',
      body: 'gzip-bytes',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tables: 12 });
    expect(restore.mock.calls[0][1]).toEqual({ force: false });
  });

  test('passes force=1 through', async () => {
    await makeApp().request('/api/restore?force=1', { method: 'POST', body: 'x' });
    expect(restore.mock.calls[0][1]).toEqual({ force: true });
  });

  test('maps RestoreError to 400 with the message', async () => {
    restore.mockRejectedValue(new FakeRestoreError('target database is not empty'));
    const res = await makeApp().request('/api/restore', { method: 'POST', body: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'target database is not empty' });
  });

  test('maps unexpected failures to an opaque 500', async () => {
    restore.mockRejectedValue(new Error('pg exploded at table 7'));
    const res = await makeApp().request('/api/restore', { method: 'POST', body: 'x' });
    expect(res.status).toBe(500);
    // Internals stay out of the client response.
    expect(await res.json()).toEqual({ error: 'restore failed' });
  });
});
