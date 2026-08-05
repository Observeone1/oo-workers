/**
 * URL monitor repository contract — assertion CRUD, update/updateEnabled,
 * and deleteAssertionsByMonitorId, plus the replaceAssertions delete+insert
 * transaction, against the real Postgres schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { urlMonitorRepo } from '../../src/db/repositories/url-monitor.repo.ts';

const sql = connectDb();
const marker = `url-monitor-repo-it-${Date.now()}`;
let monitorId = -1;

beforeAll(async () => {
  const [monitor] = await urlMonitorRepo.create({
    name: marker,
    url: 'https://example.test/health',
    intervalSeconds: 60,
  });
  monitorId = monitor.id;
}, 30_000);

afterAll(async () => {
  if (monitorId > 0) {
    await sql`DELETE FROM url_monitors WHERE id = ${monitorId}`;
  }
  await sql.end();
});

describe('urlMonitorRepo', () => {
  test('createAssertion + findAssertionsByMonitorId returns the inserted row', async () => {
    const [created] = await urlMonitorRepo.createAssertion(monitorId, {
      operator: 'equals',
      statusCode: 200,
    });
    expect(created.urlMonitorId).toBe(monitorId);

    const assertions = await urlMonitorRepo.findAssertionsByMonitorId(monitorId);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.statusCode).toBe(200);
  });

  test('createAssertions bulk inserts multiple rows; empty array short-circuits', async () => {
    const created = await urlMonitorRepo.createAssertions(monitorId, [
      { operator: 'equals', statusCode: 201 },
      { operator: 'equals', statusCode: 204 },
    ]);
    expect(created).toHaveLength(2);
    expect(await urlMonitorRepo.findAssertionsByMonitorId(monitorId)).toHaveLength(3);

    const noop = await urlMonitorRepo.createAssertions(monitorId, []);
    expect(noop).toEqual([]);
    expect(await urlMonitorRepo.findAssertionsByMonitorId(monitorId)).toHaveLength(3);
  });

  test('update modifies monitor fields', async () => {
    await urlMonitorRepo.update(monitorId, {
      name: `${marker}-updated`,
      url: 'https://example.test/updated',
      intervalSeconds: 120,
    });
    const [monitor] = await urlMonitorRepo.findById(monitorId);
    expect(monitor.name).toBe(`${marker}-updated`);
    expect(monitor.url).toBe('https://example.test/updated');
    expect(monitor.intervalSeconds).toBe(120);
  });

  test('updateEnabled toggles the enabled flag', async () => {
    await urlMonitorRepo.updateEnabled(monitorId, false);
    const [monitor] = await urlMonitorRepo.findById(monitorId);
    expect(monitor.enabled).toBe(false);
  });

  test('replaceAssertions atomically swaps old assertions for new ones', async () => {
    const before = await urlMonitorRepo.findAssertionsByMonitorId(monitorId);
    expect(before).toHaveLength(3);

    const replaced = await urlMonitorRepo.replaceAssertions(monitorId, [
      { operator: 'equals', statusCode: 500 },
    ]);
    expect(replaced).toHaveLength(1);

    const after = await urlMonitorRepo.findAssertionsByMonitorId(monitorId);
    expect(after).toHaveLength(1);
    expect(after[0]?.statusCode).toBe(500);
    // None of the pre-replace ids survived — proves delete actually ran.
    expect(before.map((a) => a.id)).not.toContain(after[0]?.id);
  });

  test('deleteAssertionsByMonitorId clears remaining assertions', async () => {
    expect(await urlMonitorRepo.findAssertionsByMonitorId(monitorId)).toHaveLength(1);
    await urlMonitorRepo.deleteAssertionsByMonitorId(monitorId);
    expect(await urlMonitorRepo.findAssertionsByMonitorId(monitorId)).toHaveLength(0);
  });

  test('deleteById removes the monitor row', async () => {
    const [toDelete] = await urlMonitorRepo.create({
      name: `${marker}-to-delete`,
      url: 'https://example.test/delete-me',
    });
    await urlMonitorRepo.deleteById(toDelete.id);
    expect(await urlMonitorRepo.findById(toDelete.id)).toEqual([]);
  });
});
