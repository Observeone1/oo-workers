/**
 * Cross-process event-bus bridge — regression test for the bug that shipped
 * in v1.26.0–v1.28.0 and was fixed in v1.28.1.
 *
 * The dashboard's SSE live updates are emitted in one process (the `worker`:
 * scheduler + BullMQ processors) but the SSE stream is served by another
 * (the `ui`). The original bus was a bare in-process EventEmitter, so every
 * worker-originated event (executions, heartbeat OVERDUE, region status)
 * died at the process boundary and never reached the browser. The single-
 * process integration tests (sse-*.it.spec.ts) all passed because the bus
 * works in-process — which is exactly why the bug shipped.
 *
 * This spec exercises the Redis pub/sub bridge that crosses that boundary,
 * within one process, by publishing/subscribing on the real channel:
 *
 *   1. emit() publishes to Redis  → the "send" half (worker → channel)
 *   2. a foreign-origin publish reaches local on() listeners
 *      → the "receive" half that was broken (channel → ui SSE)
 *   3. a local emit() delivers to listeners exactly once
 *      → guards the origin-dedup so the publisher's own loopback message
 *        doesn't double-fire
 *
 * If anyone reverts the bridge to a bare EventEmitter, case 2 fails: a
 * message on the channel never reaches a local listener.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Redis } from 'ioredis';
import { acquireRedisDb } from './_harness.ts';
import {
  execEvents,
  initEventBus,
  resetEventBus,
  EVENT_CHANNEL,
} from '../../src/services/exec-events.ts';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let rawPub: Redis;
let rawSub: Redis;

const sampleRow = {
  id: 1,
  status: 'SUCCESS',
  responseTimeMs: 42,
  startTime: '2026-05-31T00:00:00.000Z',
};

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  // Wire the bus to this test's Redis db. resetEventBus() first so the
  // result doesn't depend on whether another integration file already
  // initialised the singleton.
  resetEventBus();
  initEventBus(new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null }));
  rawPub = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
  rawSub = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
  // Give the bus's subscriber a moment to actually SUBSCRIBE before tests run.
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  resetEventBus();
  rawPub.disconnect();
  rawSub.disconnect();
  await redisCtx.releaseDb();
});

describe('exec-events redis bridge', () => {
  test('emit() publishes the event to the Redis channel (worker → channel)', async () => {
    const got = new Promise<{ origin: string; event: string; data: unknown }>((resolve) => {
      rawSub.once('message', (_ch, raw) => resolve(JSON.parse(raw)));
    });
    await rawSub.subscribe(EVENT_CHANNEL);

    execEvents.emit('execution', { type: 'url', monitorId: 7, row: { ...sampleRow } });

    const msg = await Promise.race([
      got,
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ]);
    expect(msg).not.toBeNull();
    expect(msg!.event).toBe('execution');
    expect(msg!.origin).toBeTruthy();
    expect((msg!.data as { monitorId: number }).monitorId).toBe(7);

    await rawSub.unsubscribe(EVENT_CHANNEL);
  });

  test('a foreign-origin publish reaches local on() listeners (channel → SSE)', async () => {
    const got = new Promise<{ monitorId: number }>((resolve) => {
      const handler = (p: { monitorId: number }) => {
        execEvents.off('execution', handler);
        resolve(p);
      };
      execEvents.on('execution', handler);
    });

    // Simulate the worker process publishing — a DIFFERENT origin, so the
    // bus must NOT skip it.
    await rawPub.publish(
      EVENT_CHANNEL,
      JSON.stringify({
        origin: 'another-process',
        event: 'execution',
        data: { type: 'url', monitorId: 99, row: { ...sampleRow } },
      }),
    );

    const payload = await Promise.race([
      got,
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ]);
    expect(payload).not.toBeNull();
    expect(payload!.monitorId).toBe(99);
  });

  test('a local emit() delivers to listeners exactly once (no loopback double-fire)', async () => {
    let count = 0;
    const handler = () => {
      count += 1;
    };
    execEvents.on('execution', handler);

    execEvents.emit('execution', { type: 'url', monitorId: 123, row: { ...sampleRow } });

    // Wait well past the Redis round-trip: if the bus's own published
    // message were re-delivered (broken dedup), count would reach 2.
    await new Promise((r) => setTimeout(r, 400));
    execEvents.off('execution', handler);

    expect(count).toBe(1);
  });
});
