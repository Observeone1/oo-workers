/**
 * Fleet availability repository contract.
 *
 * This exercises the real UNION ALL query and its zero-filled date window.
 * Route unit tests mock the repository, so they cannot protect this SQL or
 * the date-bucket shaping.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { getFleetAvailability } from '../../src/db/repositories/availability.repo.ts';

const sql = connectDb();
const marker = `availability-it-${Date.now()}`;
let monitorId = -1;

beforeAll(async () => {
  const [monitor] = await sql<[{ id: number }]>`
    INSERT INTO url_monitors (name, url)
    VALUES (${marker}, 'https://availability.example.test')
    RETURNING id
  `;
  monitorId = monitor.id;

}, 30_000);

afterAll(async () => {
  if (monitorId > 0) {
    await sql`DELETE FROM url_monitors WHERE id = ${monitorId}`;
  }
  await sql.end();
});

describe('getFleetAvailability', () => {
  test('aggregates execution statuses and fills missing days with zeros', async () => {
    const days = 3;
    const before = await getFleetAvailability(days);
    const beforeToday = before.at(-1);

    await sql`
      INSERT INTO url_monitor_executions (url_monitor_id, status, start_time)
      VALUES
        (${monitorId}, 'SUCCESS', NOW()),
        (${monitorId}, 'FAILED', NOW()),
        (${monitorId}, 'passed', NOW())
    `;

    const buckets = await getFleetAvailability(days);
    const today = new Date().toISOString().slice(0, 10);
    const todayBucket = buckets.find((bucket) => bucket.date === today);

    expect(buckets).toHaveLength(days);
    expect(todayBucket).toEqual({
      date: today,
      total: (beforeToday?.total ?? 0) + 3,
      passed: (beforeToday?.passed ?? 0) + 2,
    });
    expect(buckets.slice(0, -1).every((bucket) => bucket.total === 0 && bucket.passed === 0)).toBe(true);
  });
});
