/**
 * Unit tests for runBackfill — the boot-time storage maintenance pass
 * (upload pre-v1.0.0 inline scripts, migrate the legacy qa-scripts/
 * layout, sweep orphaned objects).
 *
 * Seams: the object-storage I/O calls are mocked, but the *pure* key
 * helpers (qaScriptKey, isLegacyQaScriptKey) are kept real — the point
 * is to assert the keys the backfill actually writes, not a
 * reimplementation of them.
 *
 * The db mock is a queue-driven drizzle stand-in: each awaited
 * `db.select(...)` chain resolves to the next queued result, so a test
 * states the exact sequence of reads it expects the pass to perform.
 * runBackfill always runs upload -> migrate -> sweep, so every test
 * queues all three phases (the *Empty helpers keep that noise down).
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  dbMock,
  mockDb,
  mockObjectStorage,
  objectStorageMock,
  resetObjectStorageMock,
} from '../test-support/shared-mocks.ts';

type Thenable = {
  from: () => Thenable;
  where: () => Thenable;
  leftJoin: () => Thenable;
  limit: () => Thenable;
  then: (resolve: (value: unknown) => void, reject?: (err: unknown) => void) => void;
};

/** Results the next awaited select chains will resolve to, in order. */
const selects: unknown[] = [];
/** Every `db.update(...).set(v)` payload, in call order. */
const updates: Record<string, unknown>[] = [];

function selectBuilder(): Thenable {
  const b = {} as Thenable;
  b.from = () => b;
  b.where = () => b;
  b.leftJoin = () => b;
  b.limit = () => b;
  b.then = (resolve, reject) => {
    if (selects.length === 0) {
      (reject ?? (() => {}))(new Error('db mock: select queue exhausted'));
      return;
    }
    Promise.resolve(selects.shift()).then(resolve, reject);
  };
  return b;
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
mockObjectStorage();
const { putObject, moveObject, deleteObject, listObjects } = objectStorageMock;

const { runBackfill } = await import('./storage-backfill.ts');

/** upload phase finds nothing to do (one count read). */
function queueUploadEmpty(): void {
  selects.push([{ total: 0 }]);
}
/** migrate phase finds nothing to do (one count read). */
function queueMigrateEmpty(): void {
  selects.push([{ total: 0 }]);
}
/** sweep phase reads script rows then artifact rows. */
function queueSweep(scriptRows: unknown[] = [], artifactRows: unknown[] = []): void {
  selects.push(scriptRows, artifactRows);
}

beforeEach(() => {
  selects.length = 0;
  updates.length = 0;
  // Shared registrations: prime our own behaviour, never trust what another
  // spec file left behind.
  dbMock.db = { select: () => selectBuilder(), update: () => updateBuilder() };
  dbMock.sql = () => Promise.resolve([]);
  resetObjectStorageMock();
});

describe('runBackfill — storage not configured', () => {
  test('returns all-zero counts and touches neither db nor storage', async () => {
    objectStorageMock.configured.value = false;

    const out = await runBackfill();

    expect(out).toEqual({ uploaded: 0, migrated: 0, orphansDeleted: 0, failed: 0 });
    expect(putObject).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    // No select was consumed — the queue we never filled was never read.
    expect(selects).toHaveLength(0);
  });
});

describe('runBackfill — upload pass', () => {
  test('uploads each pending script under the current qa-projects key and records it', async () => {
    selects.push([{ total: 2 }]);
    selects.push([
      {
        id: 7,
        projectId: 3,
        testName: 'Checkout Flow',
        script: 'await page.goto()',
        projectName: 'Shop',
      },
      { id: 8, projectId: 3, testName: 'Login', script: 'expect(1)', projectName: 'Shop' },
    ]);
    selects.push([]); // second batch read drains the loop
    queueMigrateEmpty();
    queueSweep();

    const out = await runBackfill();

    expect(out.uploaded).toBe(2);
    expect(out.failed).toBe(0);

    // Real qaScriptKey output, not a stubbed one.
    const keys = putObject.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual([
      'qa-projects/3-shop/7-checkout-flow.spec.ts',
      'qa-projects/3-shop/8-login.spec.ts',
    ]);
    expect(putObject.mock.calls.map((c) => c[2])).toEqual(['text/typescript', 'text/typescript']);
    // The script body is uploaded verbatim.
    expect(putObject.mock.calls.map((c) => c[1]).sort()).toEqual([
      'await page.goto()',
      'expect(1)',
    ]);
    // Each uploaded row gets its script_url written back to the key we uploaded.
    expect(updates.map((u) => u.scriptUrl).sort()).toEqual(keys);
  });

  test('falls back to synthetic project/test names when the join returns nulls', async () => {
    selects.push([{ total: 1 }]);
    selects.push([{ id: 42, projectId: 9, testName: null, script: 'x', projectName: null }]);
    selects.push([]);
    queueMigrateEmpty();
    queueSweep();

    const out = await runBackfill();

    expect(out.uploaded).toBe(1);
    expect(putObject.mock.calls[0][0]).toBe('qa-projects/9-project-9/42-test-42.spec.ts');
  });

  test('a failed upload is counted, does not write script_url, and does not stop its peers', async () => {
    selects.push([{ total: 2 }]);
    selects.push([
      { id: 1, projectId: 1, testName: 'ok', script: 's1', projectName: 'p' },
      { id: 2, projectId: 1, testName: 'boom', script: 's2', projectName: 'p' },
    ]);
    selects.push([]);
    queueMigrateEmpty();
    queueSweep();
    putObject.mockImplementation(async (key: string) => {
      if (key.includes('boom')) throw new Error('s3 down');
      return undefined;
    });

    const out = await runBackfill();

    expect(out.uploaded).toBe(1);
    expect(out.failed).toBe(1);
    // Only the surviving row was marked as uploaded.
    expect(updates).toHaveLength(1);
    expect(updates[0].scriptUrl).toBe('qa-projects/1-p/1-ok.spec.ts');
  });

  test('aborts the upload loop when every row in a batch fails (no infinite re-read)', async () => {
    selects.push([{ total: 2 }]);
    selects.push([
      { id: 1, projectId: 1, testName: 'a', script: 's', projectName: 'p' },
      { id: 2, projectId: 1, testName: 'b', script: 's', projectName: 'p' },
    ]);
    // Deliberately queue NO further batch read: if the loop re-read, the
    // mock would reject with "select queue exhausted" and fail this test.
    queueMigrateEmpty();
    queueSweep();
    putObject.mockRejectedValue(new Error('s3 down'));

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
    expect(putObject).not.toHaveBeenCalled();
  });
});

describe('runBackfill — legacy migrate pass', () => {
  test('moves legacy keys to the new layout and repoints script_url', async () => {
    queueUploadEmpty();
    selects.push([{ total: 1 }]);
    selects.push([
      {
        id: 5,
        projectId: 2,
        testName: 'Smoke Test',
        scriptUrl: 'qa-scripts/5.spec.ts',
        projectName: 'Api',
      },
    ]);
    selects.push([]);
    queueSweep();

    const out = await runBackfill();

    expect(out.migrated).toBe(1);
    expect(moveObject).toHaveBeenCalledTimes(1);
    expect(moveObject.mock.calls[0]).toEqual([
      'qa-scripts/5.spec.ts',
      'qa-projects/2-api/5-smoke-test.spec.ts',
    ]);
    expect(updates[0].scriptUrl).toBe('qa-projects/2-api/5-smoke-test.spec.ts');
  });

  test('leaves a row alone when its script_url is already in the current layout', async () => {
    queueUploadEmpty();
    selects.push([{ total: 1 }]);
    selects.push([
      {
        id: 6,
        projectId: 2,
        testName: 't',
        scriptUrl: 'qa-projects/2-api/6-t.spec.ts',
        projectName: 'Api',
      },
    ]);
    selects.push([]);
    queueSweep();

    const out = await runBackfill();

    // isLegacyQaScriptKey (real) rejects it, so it is neither moved nor counted.
    expect(out.migrated).toBe(0);
    expect(moveObject).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('counts a failed move without repointing script_url', async () => {
    queueUploadEmpty();
    selects.push([{ total: 1 }]);
    selects.push([
      { id: 9, projectId: 1, testName: 't', scriptUrl: 'qa-scripts/9.spec.ts', projectName: 'p' },
    ]);
    queueSweep();
    moveObject.mockRejectedValue(new Error('copy failed'));

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
    listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'qa-scripts/'
        ? ['qa-scripts/legacy-orphan.spec.ts']
        : [
            'qa-projects/1-p/1-a.spec.ts', // live (script_url)
            'qa-projects/1-p/trace.zip', // live (trace)
            'qa-projects/1-p/shot.png', // live (screenshot)
            'qa-projects/1-p/stale.spec.ts', // orphan
          ],
    );

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(2);
    expect(out.failed).toBe(0);
    expect(deleteObject.mock.calls.map((c) => c[0]).sort()).toEqual([
      'qa-projects/1-p/stale.spec.ts',
      'qa-scripts/legacy-orphan.spec.ts',
    ]);
    expect(listObjects.mock.calls.map((c) => c[0])).toEqual(['qa-scripts/', 'qa-projects/']);
  });

  test('sweeps a large orphan set exactly once each despite the bounded worker pool', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep();
    const orphans = Array.from({ length: 25 }, (_, i) => `qa-projects/x/${i}.spec.ts`);
    listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'qa-projects/' ? orphans : [],
    );

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(25);
    // The pool must not double-delete or drop a key.
    expect(deleteObject.mock.calls.map((c) => c[0]).sort()).toEqual([...orphans].sort());
  });

  test('counts a failed delete without aborting the rest of the sweep', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep();
    listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'qa-projects/' ? ['qa-projects/a.spec.ts', 'qa-projects/bad.spec.ts'] : [],
    );
    deleteObject.mockImplementation(async (key: string) => {
      if (key.includes('bad')) throw new Error('denied');
      return undefined;
    });

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(1);
    expect(out.failed).toBe(1);
  });

  test('does nothing when the bucket holds no orphans', async () => {
    queueUploadEmpty();
    queueMigrateEmpty();
    queueSweep([{ scriptUrl: 'qa-projects/1-p/live.spec.ts' }], []);
    listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'qa-projects/' ? ['qa-projects/1-p/live.spec.ts'] : [],
    );

    const out = await runBackfill();

    expect(out.orphansDeleted).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe('runBackfill — aggregate result', () => {
  test('sums failures across all three passes', async () => {
    // upload: 1 row, fails
    selects.push([{ total: 1 }]);
    selects.push([{ id: 1, projectId: 1, testName: 't', script: 's', projectName: 'p' }]);
    // migrate: 1 row, fails
    selects.push([{ total: 1 }]);
    selects.push([
      { id: 2, projectId: 1, testName: 't', scriptUrl: 'qa-scripts/2.spec.ts', projectName: 'p' },
    ]);
    // sweep: 1 orphan, fails
    queueSweep();
    putObject.mockRejectedValue(new Error('down'));
    moveObject.mockRejectedValue(new Error('down'));
    deleteObject.mockRejectedValue(new Error('down'));
    listObjects.mockImplementation(async (prefix: string) =>
      prefix === 'qa-projects/' ? ['qa-projects/orphan.spec.ts'] : [],
    );

    const out = await runBackfill();

    expect(out).toEqual({ uploaded: 0, migrated: 0, orphansDeleted: 0, failed: 3 });
  });
});
