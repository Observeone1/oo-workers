/**
 * The restore path's row-coercion contract.
 *
 * A dump is JSON, so every timestamp arrives as an ISO string while Drizzle
 * expects a Date. hydrate() is the single place that closes that gap for
 * every row of every table on every restore, so a regression here is silent:
 * Postgres either rejects the insert or stores an epoch, and either way
 * nothing else in the pipeline notices.
 */

import { describe, expect, test } from 'bun:test';
import { getTableName } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { mockDb } from '../test-support/shared-mocks.ts';

// backup-shared imports config/db for schemaHead/ooVersion. Nothing exercised
// here touches either, but the import still has to resolve.
mockDb();

const { hydrate, TABLES, SPEC_BY_NAME, ALL_TABLE_NAMES, WRITE_BATCH } =
  await import('./backup-shared.ts');

const REGIONS = getTableName(schema.regions);
const URL_EXECS = getTableName(schema.urlMonitorExecutions);

describe('hydrate', () => {
  test('converts timestamp-typed columns from ISO strings to Dates', () => {
    const out = hydrate(schema.regions, {
      id: 1,
      slug: 'eu',
      createdAt: '2026-03-01T10:20:30.000Z',
      updatedAt: '2026-03-02T11:21:31.000Z',
    });

    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.updatedAt).toBeInstanceOf(Date);
    expect((out.createdAt as Date).toISOString()).toBe('2026-03-01T10:20:30.000Z');
    expect((out.updatedAt as Date).toISOString()).toBe('2026-03-02T11:21:31.000Z');
  });

  test('converts nullable timestamps too, and leaves null alone', () => {
    const out = hydrate(schema.urlMonitorExecutions, {
      id: 5,
      startTime: '2026-03-01T10:20:30.000Z',
      endTime: null,
    });

    expect(out.startTime).toBeInstanceOf(Date);
    // null must stay null: coercing it to `new Date(null)` (epoch) would make
    // every in-flight execution look like it finished in 1970.
    expect(out.endTime).toBeNull();
  });

  test('leaves non-date columns untouched', () => {
    const out = hydrate(schema.regions, {
      id: 7,
      slug: 'eu',
      lastSeenAt: '2026-03-01T10:20:30.000Z',
    });

    expect(out.id).toBe(7);
    expect(out.slug).toBe('eu');
    // A JSON column holding an array must not be walked or stringified.
    const exec = hydrate(schema.urlMonitorExecutions, {
      id: 1,
      assertionResults: [{ id: 1, passed: true }],
      statusCode: 200,
      responseTimeMs: 12,
    });
    expect(exec.assertionResults).toEqual([{ id: 1, passed: true }]);
    expect(exec.statusCode).toBe(200);
    expect(exec.responseTimeMs).toBe(12);
  });

  test('preserves every key, so unknown and unlisted columns still insert', () => {
    const out = hydrate(schema.regions, {
      id: 1,
      createdAt: '2026-03-01T10:20:30.000Z',
      someFutureColumn: 'kept',
    });

    expect(Object.keys(out).sort()).toEqual(['createdAt', 'id', 'someFutureColumn']);
    expect(out.someFutureColumn).toBe('kept');
  });

  test('returns an empty object for an empty row', () => {
    expect(hydrate(schema.regions, {})).toEqual({});
  });

  test('an already-Date value is not double-coerced', () => {
    // The guard is `typeof v === 'string'`, so a Date must survive. A double
    // conversion here would be an invalid Date.
    const when = new Date('2026-03-01T10:20:30.000Z');
    const out = hydrate(schema.regions, { createdAt: when });

    expect(out.createdAt).toBe(when);
  });

  test('every timestamp column of an execution table is coerced', () => {
    // The whole execution history is the highest-value data in a backup; a
    // single unconverted column makes rows sort as text.
    const out = hydrate(schema.urlMonitorExecutions, {
      id: 1,
      startTime: '2026-03-01T10:20:30.000Z',
      endTime: '2026-03-01T10:20:31.000Z',
    });

    for (const key of ['startTime', 'endTime']) {
      expect(out[key]).toBeInstanceOf(Date);
    }
  });

  test('a string that is not a valid date surfaces as an Invalid Date, not a crash', () => {
    // JSON.stringify turns a Date into an ISO string, so this is only
    // reachable via a hand-edited dump. It must not throw: restore() would
    // abort the whole transaction over one bad row.
    const out = hydrate(schema.regions, { createdAt: 'not-a-date' });
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN((out.createdAt as Date).getTime())).toBe(true);
  });
});

describe('table ordering contract', () => {
  test('parents are dumped before the children that reference them', () => {
    // The FK-safe order is the import-correctness spec (see the comment on
    // TABLES). Assert the edges that would actually break a restore: a
    // monitor before its executions, a project before its runs.
    const at = (name: string) => ALL_TABLE_NAMES.indexOf(name);
    expect(at(REGIONS)).toBeLessThan(at(getTableName(schema.monitorRegions)));
    expect(at(getTableName(schema.urlMonitors))).toBeLessThan(at(URL_EXECS));
    expect(at(getTableName(schema.qaProjects))).toBeLessThan(at(getTableName(schema.qaRuns)));
    expect(at(getTableName(schema.qaRuns))).toBeLessThan(at(getTableName(schema.qaTestExecutions)));
  });

  test('every table name maps back to a spec, and back the other way', () => {
    expect(ALL_TABLE_NAMES).toHaveLength(TABLES.length);
    for (const spec of TABLES) {
      expect(SPEC_BY_NAME.get(getTableName(spec.table))).toBe(spec);
    }
  });

  test('write batching is the documented positive constant', () => {
    // restore() flushes in WRITE_BATCH-sized chunks; a zero or negative value
    // would make the batch loop spin or drop every row.
    expect(WRITE_BATCH).toBe(500);
  });
});
