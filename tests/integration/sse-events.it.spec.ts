/**
 * SSE feed at GET /api/events.
 *
 * Phase 1 of the polling-to-SSE migration. Stands up the endpoint, the
 * in-process event bus, and the auth gate. No view consumes events yet
 * — this spec verifies the wire layer in isolation:
 *
 *   - Unauth'd request → 401 (no SSE handshake)
 *   - Auth'd request → 200 with text/event-stream + a `hello` event
 *   - bus.emit('execution', ...) → connected client receives an
 *     `execution` event with the same payload
 *   - Client abort cleans up listeners (no leak across reconnects)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { apiKeys } from '../../src/db/schema.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';
import { execEvents } from '../../src/services/exec-events.ts';

const TAG = `sse-${Date.now()}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let authHdr: Record<string, string>;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['read'],
  });
  authHdr = { Authorization: `Bearer ${cleartext}` };
}, 30_000);

afterAll(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

/**
 * Helper: open an SSE stream and incrementally collect events. Returns
 * `{ next, close }`. `next(predicate)` resolves with the first event
 * matching the predicate. `close()` cancels the reader so the server-
 * side cleanup path runs.
 */
async function openSSE(url: string, init: RequestInit) {
  // Per-connection AbortController so close() can sever the HTTP socket,
  // which is what triggers hono's stream.onAbort on the server side.
  // Cancelling just the body reader doesn't reliably propagate.
  const ac = new AbortController();
  const res = await fetch(url, { ...init, signal: ac.signal });
  if (res.status !== 200) {
    return {
      res,
      next: async () => {
        throw new Error(`SSE opened with status ${res.status}`);
      },
      close: async () => {
        ac.abort();
        await res.body?.cancel().catch(() => {});
      },
    };
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const queue: Array<{ event: string; data: string }> = [];
  let buf = '';
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Split on blank-line boundaries (one event per chunk).
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
        const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
        if (event && data) queue.push({ event, data });
      }
    }
  })();
  return {
    res,
    next: async (
      pred: (e: { event: string; data: string }) => boolean,
      timeoutMs = 4000,
    ): Promise<{ event: string; data: string }> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const i = queue.findIndex(pred);
        if (i >= 0) return queue.splice(i, 1)[0]!;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('SSE: timed out waiting for matching event');
    },
    close: async () => {
      stopped = true;
      ac.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
  };
}

describe('SSE /api/events', () => {
  test('unauthenticated request → 401, no SSE handshake', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
    await res.body?.cancel().catch(() => {});
  });

  test('authenticated request → 200 + text/event-stream + initial hello', async () => {
    const sse = await openSSE(`${base}/api/events`, { headers: authHdr });
    expect(sse.res.status).toBe(200);
    expect(sse.res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const hello = await sse.next((e) => e.event === 'hello');
    expect(() => JSON.parse(hello.data)).not.toThrow();
    await sse.close();
  });

  test('bus.emit("execution") is delivered to connected clients', async () => {
    const sse = await openSSE(`${base}/api/events`, { headers: authHdr });
    await sse.next((e) => e.event === 'hello');

    const payload = {
      type: 'url' as const,
      monitorId: 999,
      row: {
        id: 1234,
        status: 'SUCCESS',
        latencyMs: 42,
        startTime: new Date().toISOString(),
      },
    };
    // Emit AFTER the listener is registered (which happens during fetch).
    setTimeout(() => execEvents.emit('execution', payload), 50);
    const received = await sse.next((e) => e.event === 'execution');
    expect(JSON.parse(received.data)).toEqual(payload);
    await sse.close();
  });

  test('listener cleanup on disconnect — no leak across reconnects', async () => {
    const baseListeners = execEvents.listenerCount('execution');

    for (let i = 0; i < 3; i++) {
      const sse = await openSSE(`${base}/api/events`, { headers: authHdr });
      await sse.next((e) => e.event === 'hello');
      await sse.close();
      // Give the server a beat to run its onAbort cleanup before the next
      // open — otherwise the test races the cleanup we're asserting on.
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(execEvents.listenerCount('execution')).toBeLessThanOrEqual(baseListeners);
  });
});
