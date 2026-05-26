/**
 * tickRegionStatus() fires `region` events only on online/offline transitions.
 *
 * Stateful-sweep test that catches:
 *
 *   - First-sweep silence: seeds state, must NOT emit on the first call.
 *   - Real transitions: a flip in lastSeenAt threshold fires exactly one
 *     event per region, with the right status.
 *   - No spurious re-emits: a sweep on unchanged state fires zero events.
 *
 * Manipulates `regions.last_seen_at` directly to control the derived
 * online state — no need to actually run an agent.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { acquireRedisDb } from './_harness.ts';
import { execEvents } from '../../src/services/exec-events.ts';
import { tickRegionStatus } from '../../src/scheduler.ts';

const TAG = `sse-rs-${Date.now()}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let sql: ReturnType<typeof postgres>;
let apiKeyIds: number[] = [];
let regionIds: number[] = [];

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  sql = postgres(process.env.DATABASE_URL!);

  // Two regions: A starts online (last_seen_at = NOW()), B starts offline.
  for (const suffix of ['a', 'b']) {
    const [key] = await sql<[{ id: number }]>`
      INSERT INTO api_keys (name, key_prefix, key_hash, scopes)
      VALUES (${`${TAG}-${suffix}`}, ${`oo_${TAG.slice(0, 6)}${suffix}`}, 'unused', ARRAY['agent']::text[])
      RETURNING id`;
    apiKeyIds.push(key.id);
    const lastSeen = suffix === 'a' ? 'NOW()' : `NOW() - INTERVAL '2 minutes'`;
    const [region] = await sql.unsafe(
      `INSERT INTO regions (slug, label, api_key_id, last_seen_at)
       VALUES ('${TAG}-${suffix}', 'Test ${suffix}', ${key.id}, ${lastSeen})
       RETURNING id`,
    ) as unknown as Array<{ id: number }>;
    regionIds.push(region.id);
  }
}, 30_000);

afterAll(async () => {
  for (const id of regionIds) await sql`DELETE FROM regions WHERE id = ${id}`.catch(() => {});
  for (const id of apiKeyIds) await sql`DELETE FROM api_keys WHERE id = ${id}`.catch(() => {});
  await sql.end();
  await redisCtx.releaseDb();
}, 30_000);

/** Drain region events into an array, return a stop fn. */
function captureRegionEvents(): { events: Array<{ regionId: number; status: string }>; stop: () => void } {
  const events: Array<{ regionId: number; status: string }> = [];
  const handler = (p: unknown) => events.push(p as { regionId: number; status: string });
  execEvents.on('region', handler as never);
  return {
    events,
    stop: () => execEvents.off('region', handler as never),
  };
}

describe('tickRegionStatus', () => {
  test('first sweep seeds in-memory state without emitting', async () => {
    const cap = captureRegionEvents();
    await tickRegionStatus();
    // Wait a tick so emit-then-receive completes if there were any.
    await new Promise((r) => setTimeout(r, 50));
    expect(cap.events).toHaveLength(0);
    cap.stop();
  });

  test('second sweep emits on transitions, not on unchanged state', async () => {
    // Flip A offline (2 min stale), flip B online (NOW).
    await sql.unsafe(`UPDATE regions SET last_seen_at = NOW() - INTERVAL '2 minutes' WHERE id = ${regionIds[0]}`);
    await sql.unsafe(`UPDATE regions SET last_seen_at = NOW() WHERE id = ${regionIds[1]}`);

    const cap = captureRegionEvents();
    await tickRegionStatus();
    await new Promise((r) => setTimeout(r, 50));
    cap.stop();

    expect(cap.events).toHaveLength(2);
    // A flipped to offline.
    const aEvent = cap.events.find((e) => e.regionId === regionIds[0]);
    expect(aEvent?.status).toBe('offline');
    // B flipped to online.
    const bEvent = cap.events.find((e) => e.regionId === regionIds[1]);
    expect(bEvent?.status).toBe('online');
  });

  test('third sweep on unchanged state emits zero events', async () => {
    const cap = captureRegionEvents();
    await tickRegionStatus();
    await new Promise((r) => setTimeout(r, 50));
    cap.stop();
    expect(cap.events).toHaveLength(0);
  });
});
