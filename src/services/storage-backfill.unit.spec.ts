/**
 * Unit tests for runBackfill — the boot-time storage maintenance pass
 * (upload pre-v1.0.0 inline scripts, migrate the legacy qa-scripts/
 * layout, sweep orphaned objects).
 *
 * Seams: the S3 network boundary is mocked via the signedFetchRaw seam
 * so the real object-storage.ts runs (URL building, config parsing and
 * the pure key helpers). The db mock is a queue-driven drizzle stand-in:
 * each awaited `db.select(...)` chain resolves to the next queued result,
 * so a test states the exact sequence of reads it expects the pass to
 * perform. runBackfill always runs upload -> migrate -> sweep, so every
 * test queues all three phases (the *Empty helpers keep that noise down).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  dbMock,
  mockDb,
  mockObjectStorageSigning,
  resetObjectStorageSigningMock,
  setFullObjectStorageEnv,
  signedFetchRawMock,
} from '../test-support/shared-mocks.ts';
import { resetObjectStorageConfigCache } from './object-storage.ts';

/**
 * A drizzle query stand-in: a real Promise carrying the chain methods, so
 * `await db.select().from(x).where(y).limit(n)` works without hand-rolling a
 * `then`. The queued result is taken when `.from()` runs, which is the order
 * the pass issues its reads in.
 */
type Query = Promise<unknown> & {
  where: () => Query;
  leftJoin: () => Query;
  limit: () => Query;
};

/** Results the next awaited select chains will resolve to, in order. */
const selects: unknown[] = [];
/** Every `db.update(...).set(v)` payload, in call order. */
const updates: Record<string, unknown>[] = [];

function nextQuery(): Query {
  const q = (
    selects.length === 0
      ? Promise.reject(new Error('db mock: select queue exhausted'))
      : Promise.resolve(selects.shift())
  ) as Query;
  q.where = () => q;
  q.leftJoin = () => q;
  q.limit = () => q;
  return q;
}

function selectBuilder(): { from: () => Query } {
  return { from: () => nextQuery() };
}

/** Queue results for the next awaited select chains, in order. */
function queue(...results: unknown[]): void {
  selects.push(...results);
}

function updateBuilder(): { set: (v: Record<string, unknown>) => unknown } {
  return {
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return { where: () => Promise.resolve(undefined) };
    },
  };
}

mockDb();
mockObjectStorageSigning();

const { runBackfill } = await import('./storage-backfill.ts');

/** upload phase finds nothing to do (one count read). */
function queueUploadEmpty(): void {
  queue([{ total: 0 }]);
}
/** migrate phase finds nothing to do (one count read). */
function queueMigrateEmpty(): void {
  queue([{ total: 0 }]);
}
/** sweep phase reads script rows then artifact rows. */
function queueSweep(scriptRows: unknown[] = [], artifactRows: unknown[] = []): void {
  queue(scriptRows, artifactRows);
}

/** Extract the object key from a signed S3 URL pathname. */
function keyOf(call: unknown[]): string {
  const pathname = (call[1] as URL).pathname;
  // Path-style URLs: /bucket/key
  return decodeURIComponent(pathname.split('/').slice(2).join('/'));
}

/** All signedFetchRaw calls grouped by HTTP method. */
function callsByMethod(): Record<string, unknown[][]> {
  const out: Record<string, unknown[][]> = { GET: [], PUT: [], DELETE: [] };
  for (const c of signedFetchRawMock.mock.calls) {
    const method = c[0] as string;
    (out[method] ??= []).push(c);
  }
  return out;
}

/** Keys passed to PUTObject, in call order. */
function putKeys(): string[] {
  return callsByMethod().PUT.map(keyOf);
}

/** Keys passed to DELETEObject, in call order. */
function deleteKeys(): string[] {
  return callsByMethod().DELETE.map(keyOf);
}

/** List prefixes requested, in call order. */
function listPrefixes(): string[] {
  return callsByMethod()
    .GET.filter((c) => (c[1] as URL).searchParams.get('list-type') === '2')
    .map((c) => (c[1] as URL).searchParams.get('prefix') ?? '');
}

/**
 * Reconstruct moveObject calls from the GET/PUT/DELETE sequence.
 * A move is: GET oldKey, PUT newKey, DELETE oldKey with no other
 * operation on oldKey between GET and DELETE.
 */
function moveCalls(): { from: string; to: string }[] {
  const calls = signedFetchRawMock.mock.calls;
  const moves: { from: string; to: string }[] = [];
  for (let i = 0; i < calls.length - 2; i++) {
    const [m1, m2, m3] = [calls[i][0], calls[i + 1][0], calls[i + 2][0]] as string[];
    if (m1 === 'GET' && m2 === 'PUT' && m3 === 'DELETE') {
      const from = keyOf(calls[i]);
      const to = keyOf(calls[i + 1]);
      const del = keyOf(calls[i + 2]);
      if (from === del) {
        moves.push({ from, to });
      }
    }
  }
  return moves;
}

beforeEach(() => {
  selects.length = 0;
  updates.length = 0;
  // Shared registrations: prime our own behaviour, never trust what another
  // spec file left behind.
  dbMock.db = { select: () => selectBuilder(), update: () => updateBuilder() };
  dbMock.sql = () => Promise.resolve([]);
  setFullObjectStorageEnv();
  resetObjectStorageConfigCache();
  mockObjectStorageSigning();
  signedFetchRawMock.mockImplementation(async (method, url) => {
    const u = url as URL;
    if (u.searchParams.get('list-type') === '2') {
      return new Response('<ListBucketResult></ListBucketResult>');
    }
    if (method === 'GET') return new Response('script body');
    return new Response('OK', { status: 200 });
  });
});

afterEach(async () => {
  resetObjectStorageSigningMock();
});

describe('runBackfill — storage not configured', () => {
  test('returns all-zero counts and touches neither db nor storage', async () => {
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('OO_OBJECT_STORAGE_'))) {
      delete process.env[k];
    }
    resetObjectStorageConfigCache();

    const out = await runBackfill();

    expect(out).toEqual({ uploaded: 0, migrated: 0, orphansDeleted: 0, failed: 0 });
    expect(signedFetchRawMock).not.toHaveBeenCalled();
    // No select was consumed — the queue we never filled was never read.
    expect(selects).toHaveLength(0);
  });
});

describe('runBackfill — upload pass', () => {
  test('uploads each pending script under the current qa-projects key and records it', async () => {
    queue([{ total: 2 }]);
    queue([
      {
        id: 7,
        projectId: 3,
        testName: 'Checkout Flow',
        script: 'await page.goto()',
        projectName: 'Shop',
      },
      { id: 8, projectId: 3, testName: 'Login', script: 'expect(1)', projectName: 'Shop' },
    ]);
    queue([]); // second batch read drains the loop
    queueMigrateEmpty();
    queueSweep();

    const out = await runBackfill();

    expect(out.uploaded).toBe(2);
    expect(out.failed).toBe(0);

    // Real qaScriptKey output, not a stubbed one.
    const keys = putKeys().sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([
      'qa-projects/3-shop/7-checkout-flow.spec.ts',
      'qa-projects/3-shop/8-login.spec.ts',
    ]);
    // The script body is uploaded verbatim.
    const putCalls = callsByMethod().PUT;
    expect(putCalls.map((c) => (c[2] as Buffer | string).toString()).sort()).toEqual([
      'await page.goto()',
      'expect(1)',
    ]);
    expect(putCalls.map((c) => (c[6] as Record<string, string>)['content-type'])).toEqual([
      'text/typescript',
      'text/typescript',
    ]);
    // Each uploaded row gets its script_url written back to the key we uploaded.
    expect(
      updates.map((u) => u.scriptUrl).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(keys);
  });

  test('falls back to synthetic project/test names when the join returns nulls', async () => {
    queue([{ total: 1 }]);
    queue([{ id: 42, projectId: 9, testName: null, script: 'x', projectName: null }]);
    queue([]);
    queueMigrateEmpty();
    queueSweep();

    const out = await runBackfill();

    expect(out.uploaded).toBe(1);
    expect(putKeys()[0]).toBe('qa-projects/9-project-9/42-test-42.spec.ts');
  });

  test('a failed upload is counted, does not write script_url, and does not stop its peers', async () => {
    queue([{ total: 2 }]);
    queue([
      { id: 1, projectId: 1, testName: 'ok', script: 's1', projectName: 'p' },
      { id: 2, projectId: 1, testName: 'boom', script: 's2', projectName: 'p' },
    ]);
    queue([]);
    queueMigrateEmpty();
    queueSweep();
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (method === 'PUT' && keyOf([method, u, null, '', '', '', {}]).includes('boom')) {
        throw new Error('s3 down');
      }
      if (u.searchParams.get('list-type') === '2')
        return new Response('<ListBucketResult></ListBucketResult>');
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.uploaded).toBe(1);
    expect(out.failed).toBe(1);
    // Only the surviving row was marked as uploaded.
    expect(updates).toHaveLength(1);
    expect(updates[0].scriptUrl).toBe('qa-projects/1-p/1-ok.spec.ts');
  });

  test('aborts the upload loop when every row in a batch fails (no infinite re-read)', async () => {
    queue([{ total: 2 }]);
    queue([
      { id: 1, projectId: 1, testName: 'a', script: 's', projectName: 'p' },
      { id: 2, projectId: 1, testName: 'b', script: 's', projectName: 'p' },
    ]);
    // Deliberately queue NO further batch read: if the loop re-read, the
    // mock would reject with "select queue exhausted" and fail this test.
    queueMigrateEmpty();
    queueSweep();
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (method === 'PUT') throw new Error('s3 down');
      if (u.searchParams.get('list-type') === '2')
        return new Response('<ListBucketResult></ListBucketResult>');
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.uploaded).toBe(0);
    expect(out.failed).toBe(2);
    expect(updates).toHaveLength(0);
  });

  test('skips the batch loop entirely when the pending count is zero', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep();

    const out = await runBackfill();

    expect(out.uploaded).toBe(0);
    expect(callsByMethod().PUT).toHaveLength(0);
  });
});

describe('runBackfill — legacy migrate pass', () => {
  test('moves legacy keys to the new layout and repoints script_url', async () => {
    queueUploadEmpty();
    queue([{ total: 1 }]);
    queue([
      {
        id: 5,
        projectId: 2,
        testName: 'Smoke Test',
        scriptUrl: 'qa-scripts/5.spec.ts',
        projectName: 'Api',
      },
    ]);
    queue([]);
    queueSweep();

    const out = await runBackfill();

    expect(out.migrated).toBe(1);
    expect(moveCalls()).toEqual([
      { from: 'qa-scripts/5.spec.ts', to: 'qa-projects/2-api/5-smoke-test.spec.ts' },
    ]);
    expect(updates[0].scriptUrl).toBe('qa-projects/2-api/5-smoke-test.spec.ts');
  });

  test('leaves a row alone when its script_url is already in the current layout', async () => {
    queueUploadEmpty();
    queue([{ total: 1 }]);
    queue([
      {
        id: 6,
        projectId: 2,
        testName: 't',
        scriptUrl: 'qa-projects/2-api/6-t.spec.ts',
        projectName: 'Api',
      },
    ]);
    queue([]);
    queueSweep();

    const out = await runBackfill();

    // isLegacyQaScriptKey (real) rejects it, so it is neither moved nor counted.
    expect(out.migrated).toBe(0);
    expect(moveCalls()).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('counts a failed move without repointing script_url', async () => {
    queueUploadEmpty();
    queue([{ total: 1 }]);
    queue([
      { id: 9, projectId: 1, testName: 't', scriptUrl: 'qa-scripts/9.spec.ts', projectName: 'p' },
    ]);
    queueSweep();
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (method === 'GET' && keyOf([method, u, null, '', '', '', {}]) === 'qa-scripts/9.spec.ts') {
        throw new Error('copy failed');
      }
      if (u.searchParams.get('list-type') === '2')
        return new Response('<ListBucketResult></ListBucketResult>');
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.migrated).toBe(0);
    expect(out.failed).toBe(1);
    expect(updates).toHaveLength(0);
  });
});

describe('runBackfill — orphan sweep', () => {
  test('deletes only bucket keys no row still references', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep(
      [{ scriptUrl: 'qa-projects/1-p/1-a.spec.ts' }, { scriptUrl: null }],
      [{ traceUrl: 'qa-projects/1-p/trace.zip', screenshotUrls: ['qa-projects/1-p/shot.png'] }],
    );
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix');
        if (prefix === 'qa-scripts/') {
          return new Response(
            '<ListBucketResult><Key>qa-scripts/legacy-orphan.spec.ts</Key></ListBucketResult>',
          );
        }
        return new Response(
          '<ListBucketResult>' +
            '<Key>qa-projects/1-p/1-a.spec.ts</Key>' +
            '<Key>qa-projects/1-p/trace.zip</Key>' +
            '<Key>qa-projects/1-p/shot.png</Key>' +
            '<Key>qa-projects/1-p/stale.spec.ts</Key>' +
            '</ListBucketResult>',
        );
      }
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(2);
    expect(out.failed).toBe(0);
    expect(deleteKeys().sort()).toEqual([
      'qa-projects/1-p/stale.spec.ts',
      'qa-scripts/legacy-orphan.spec.ts',
    ]);
    expect(listPrefixes()).toEqual(['qa-scripts/', 'qa-projects/']);
  });

  test('sweeps a large orphan set exactly once each despite the bounded worker pool', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep();
    const orphans = Array.from({ length: 25 }, (_, i) => `qa-projects/x/${i}.spec.ts`);
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix');
        if (prefix === 'qa-projects/') {
          return new Response(
            '<ListBucketResult>' +
              orphans.map((k) => `<Key>${k}</Key>`).join('') +
              '</ListBucketResult>',
          );
        }
        return new Response('<ListBucketResult></ListBucketResult>');
      }
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(25);
    // The pool must not double-delete or drop a key.
    expect(deleteKeys().sort()).toEqual([...orphans].sort());
  });

  test('counts a failed delete without aborting the rest of the sweep', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep();
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix');
        if (prefix === 'qa-projects/') {
          return new Response(
            '<ListBucketResult><Key>qa-projects/a.spec.ts</Key><Key>qa-projects/bad.spec.ts</Key></ListBucketResult>',
          );
        }
        return new Response('<ListBucketResult></ListBucketResult>');
      }
      if (method === 'GET') return new Response('script body');
      if (
        method === 'DELETE' &&
        keyOf([method, u, null, '', '', '', {}]) === 'qa-projects/bad.spec.ts'
      ) {
        throw new Error('denied');
      }
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(1);
    expect(out.failed).toBe(1);
  });

  test('does nothing when the bucket holds no orphans', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep([{ scriptUrl: 'qa-projects/1-p/live.spec.ts' }], []);
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix');
        if (prefix === 'qa-projects/') {
          return new Response(
            '<ListBucketResult><Key>qa-projects/1-p/live.spec.ts</Key></ListBucketResult>',
          );
        }
        return new Response('<ListBucketResult></ListBucketResult>');
      }
      if (method === 'GET') return new Response('script body');
      return new Response('OK', { status: 200 });
    });

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(0);
    expect(callsByMethod().DELETE).toHaveLength(0);
  });
});

describe('runBackfill — aggregate result', () => {
  test('sums failures across all three passes', async () => {
    // upload: 1 row, fails
    queue([{ total: 1 }]);
    queue([{ id: 1, projectId: 1, testName: 't', script: 's', projectName: 'p' }]);
    // migrate: 1 row, fails
    queue([{ total: 1 }]);
    queue([
      { id: 2, projectId: 1, testName: 't', scriptUrl: 'qa-scripts/2.spec.ts', projectName: 'p' },
    ]);
    // sweep: 1 orphan, fails
    queueSweep();
    signedFetchRawMock.mockImplementation(async (method, url) => {
      const u = url as URL;
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix');
        if (prefix === 'qa-projects/') {
          return new Response(
            '<ListBucketResult><Key>qa-projects/orphan.spec.ts</Key></ListBucketResult>',
          );
        }
        return new Response('<ListBucketResult></ListBucketResult>');
      }
      throw new Error('down');
    });

    const out = await runBackfill();

    expect(out).toEqual({ uploaded: 0, migrated: 0, orphansDeleted: 0, failed: 3 });
  });
});
