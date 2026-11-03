/**
 * Heartbeat recordPing concurrency — two simultaneous pings on an OVERDUE
 * row must serialize (SELECT ... FOR UPDATE in one transaction) so exactly
 * one observes OVERDUE and reports wasOverdue=true. Without the row lock
 * both peek OVERDUE before either updates and both claim the recovery,
 * firing a duplicate recovery alert.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { heartbeatRepo } from '../../src/db/repositories/heartbeat.repo.ts';

const sql = connectDb();
const marker = `heartbeat-ping-race-it-${Date.now()}`;
let heartbeatId = -1;
let token = '';

beforeAll(async () => {
  const [row] = await heartbeatRepo.create({ name: marker, periodSeconds: 60 });
  heartbeatId = row.id;
  token = row.token;
}, 30_000);

afterAll(async () => {
  if (heartbeatId > 0) {
    await sql`DELETE FROM heartbeat_monitors WHERE id = ${heartbeatId}`;
  }
  await sql.end();
});

describe('heartbeatRepo.recordPing concurrency', () => {
  test('ten simultaneous pings: exactly one reports wasOverdue', async () => {
    // Warm the pool so all racers start on equal footing.
    await Promise.all(Array.from({ length: 10 }, () => heartbeatRepo.findById(heartbeatId)));
    for (let round = 0; round < 5; round++) {
      // Re-arm: OVERDUE with a lastPingAt far outside the 1s debounce window.
      await sql`UPDATE heartbeat_monitors SET status = 'OVERDUE', last_ping_at = now() - interval '30 seconds' WHERE id = ${heartbeatId}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => heartbeatRepo.recordPing(token)),
      );
      expect(results.every((r) => r !== null)).toBe(true);
      expect(results.filter((r) => r?.wasOverdue).length).toBe(1);
    }

    const [row] = await heartbeatRepo.findById(heartbeatId);
    expect(row.status).toBe('UP');
  });
});
