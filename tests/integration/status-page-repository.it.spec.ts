/**
 * Status-page repository contract.
 *
 * Covers CRUD and ordered monitor bindings against Postgres. Route tests mock
 * these repositories and do not exercise transaction replacement semantics.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { statusPageMonitorRepo, statusPageRepo } from '../../src/db/repositories/status-page.repo.ts';

const sql = connectDb();
const marker = `status-page-repo-it-${Date.now()}`;
let pageId = -1;

beforeAll(async () => {
  const [page] = await statusPageRepo.create({
    slug: marker,
    title: 'Status-page repository integration test',
    description: 'Before update',
  });
  pageId = page.id;
}, 30_000);

afterAll(async () => {
  if (pageId > 0) {
    await sql`DELETE FROM status_pages WHERE id = ${pageId}`;
  }
  await sql.end();
});

describe('statusPageRepo and statusPageMonitorRepo', () => {
  test('finds, updates, lists, and replaces ordered monitor bindings', async () => {
    expect((await statusPageRepo.findById(pageId))?.slug).toBe(marker);
    expect((await statusPageRepo.findBySlug(marker))?.description).toBe('Before update');
    expect(await statusPageRepo.findById(-1)).toBeNull();

    await statusPageRepo.update(pageId, {
      title: 'Updated title',
      description: null,
    });
    expect((await statusPageRepo.findBySlug(marker))?.title).toBe('Updated title');
    expect((await statusPageRepo.findBySlug(marker))?.description).toBeNull();

    await statusPageMonitorRepo.set(pageId, [
      { monitorType: 'url', monitorId: 101 },
      { monitorType: 'tls', monitorId: 202 },
    ]);
    expect(await statusPageMonitorRepo.forPage(pageId)).toEqual([
      { monitorType: 'url', monitorId: 101, sortOrder: 0 },
      { monitorType: 'tls', monitorId: 202, sortOrder: 1 },
    ]);

    await statusPageMonitorRepo.set(pageId, [{ monitorType: 'db', monitorId: 303 }]);
    expect(await statusPageMonitorRepo.forPage(pageId)).toEqual([
      { monitorType: 'db', monitorId: 303, sortOrder: 0 },
    ]);

    await statusPageMonitorRepo.clearForMonitor('db', 303);
    expect(await statusPageMonitorRepo.forPage(pageId)).toEqual([]);
    expect((await statusPageRepo.list()).some((page) => page.id === pageId)).toBe(true);
  });
});
