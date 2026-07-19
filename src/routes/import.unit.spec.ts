/**
 * /api/import HTTP contract — passthrough of the import result, the
 * version-mismatch 400, and the opaque 500 for adapter failures.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

class FakeImportVersionError extends Error {}

const runImport = mock(async (_body: unknown): Promise<unknown> => ({}));

mock.module('../services/import.ts', () => ({
  ImportVersionError: FakeImportVersionError,
  runImport,
}));
mock.module('../utils/logger.ts', () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {} },
}));

const { registerImportRoutes } = await import('./import.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerImportRoutes(app);
  return app;
}

function post(body: unknown) {
  return makeApp().request('/api/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  runImport.mockReset();
});

describe('POST /api/import', () => {
  test('runs the import and returns its result', async () => {
    runImport.mockResolvedValue({ imported: { monitors: 4 }, skipped: 0 });

    const res = await post({ version: 1, monitors: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: { monitors: 4 }, skipped: 0 });
    expect(runImport).toHaveBeenCalledWith({ version: 1, monitors: [] });
  });

  test('maps a version mismatch to 400 with the message', async () => {
    runImport.mockRejectedValue(new FakeImportVersionError('unsupported dump version 9'));

    const res = await post({ version: 9 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported dump version 9' });
  });

  test('maps adapter failures to an opaque 500', async () => {
    runImport.mockRejectedValue(new Error('fk violation on monitor 3'));

    const res = await post({ version: 1 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'import failed' });
  });
});
