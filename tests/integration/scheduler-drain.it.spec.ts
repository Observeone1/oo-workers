/**
 * BullMQ startup drain — integration test.
 *
 * Verifies that stale waiting jobs left from a previous process boot are
 * removed by the drain that runs at the start of startScheduler(). This
 * is the on-restart side of the stale-dedup fix: without the drain, stale
 * jobs with old-format IDs would sit in the wait queue forever, BullMQ
 * would silently skip re-enqueues of the same ID, and the monitors would
 * never run again after a hard kill.
 *
 * We pre-populate stale jobs artificially (simulating the previous boot's
 * leftovers), start the scheduler, and assert the specific IDs are gone.
 * We assert by job ID — NOT by queue empty-count, because the scheduler's
 * immediate tick may add new jobs for any due monitors in the shared DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { acquireRedisDb } from './_harness.ts';
import { startScheduler } from '../../src/scheduler.ts';

// Representative sample: one stale ID per queue covers the drain loop.
// Old-format IDs have no boot nonce (pre-fix format).
const STALE: Array<{ queue: string; jobId: string }> = [
  { queue: 'url-monitor', jobId: 'url:1:99999' },
  { queue: 'api-check',   jobId: 'api:1:99999' },
  { queue: 'tcp-monitor', jobId: 'tcp:1:99999' },
];

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let schedulerConn: Redis;
let stopScheduler: (() => Promise<void>) | null = null;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();

  // Phase 1 — seed stale jobs using a throwaway connection that
  // mimics the previous boot's scheduler queue state.
  const setupConn = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
  for (const { queue, jobId } of STALE) {
    const q = new Queue(queue, { connection: setupConn });
    await q.add('check', {}, { jobId });
    await q.close();
  }

  // Sanity-check: jobs are actually waiting before the scheduler starts.
  for (const { queue, jobId } of STALE) {
    const q = new Queue(queue, { connection: setupConn });
    const job = await q.getJob(jobId);
    expect(job).toBeDefined();
    await q.close();
  }
  await setupConn.quit();

  // Phase 2 — start the scheduler. The drain is awaited inside
  // startScheduler before it returns, so stale jobs are gone by the time
  // this call resolves. The immediate tick fires after but is non-blocking.
  schedulerConn = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
  stopScheduler = await startScheduler(schedulerConn);
}, 60_000);

afterAll(async () => {
  await stopScheduler?.();
  schedulerConn.disconnect();
  await redisCtx.releaseDb();
}, 30_000);

describe('BullMQ startup drain', () => {
  test('pre-seeded stale job IDs are removed from all drained queues', async () => {
    const verifyConn = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
    for (const { queue, jobId } of STALE) {
      const q = new Queue(queue, { connection: verifyConn });
      const job = await q.getJob(jobId);
      expect(job).toBeUndefined();
      await q.close();
    }
    await verifyConn.quit();
  });
});
