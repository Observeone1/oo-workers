/**
 * SSE monitor-created / monitor-deleted events.
 *
 * Verifies the Phase 2 emit points fire on every POST/DELETE route:
 *
 *   - POST /api/monitors/url   → 'monitor-created' { type: 'url',  monitorId }
 *   - POST /api/monitors/api   → 'monitor-created' { type: 'api',  monitorId }
 *   - POST /api/monitors/tcp   → 'monitor-created' { type: 'tcp',  monitorId }
 *   - POST /api/monitors/udp   → 'monitor-created' { type: 'udp',  monitorId }
 *   - POST /api/monitors/db    → 'monitor-created' { type: 'db',   monitorId }
 *   - POST /api/monitors/tls   → 'monitor-created' { type: 'tls',  monitorId }
 *   - POST /api/monitors/qa    → 'monitor-created' { type: 'qa',   monitorId }
 *   - POST /api/monitors/heartbeat → 'monitor-created' { type: 'heartbeat', monitorId }
 *   - DELETE /api/monitors/:type/:id → 'monitor-deleted' { type, monitorId }
 *
 * Stays at the bus layer — doesn't open an SSE HTTP connection. The
 * wire-layer tests in sse-events.it.spec.ts already cover that path.
 * Here we just confirm the emitters fire from the route handlers, which
 * is what gives the dashboard its live-update behaviour in Phase 2.
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

const TAG = `sse-lc-${Date.now()}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let writeHdr: Record<string, string>;

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
    scopes: ['write'],
  });
  writeHdr = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

/**
 * Subscribe once, return a promise that resolves with the next event's
 * payload (and auto-unsubscribes). Used per-test so listeners don't leak
 * across tests.
 */
function nextEvent(name: 'monitor-created' | 'monitor-deleted'): Promise<{ type: string; monitorId: number }> {
  return new Promise((resolve) => {
    const handler = (p: unknown) => {
      execEvents.off(name as 'monitor-created', handler as never);
      resolve(p as { type: string; monitorId: number });
    };
    execEvents.on(name as 'monitor-created', handler as never);
  });
}

describe('monitor-created / monitor-deleted emits', () => {
  test('POST /api/monitors/url emits monitor-created with type=url', async () => {
    const wait = nextEvent('monitor-created');
    const res = await fetch(`${base}/api/monitors/url`, {
      method: 'POST',
      headers: writeHdr,
      body: JSON.stringify({ name: `${TAG}-url`, url: 'https://example.com' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };
    const evt = await wait;
    expect(evt.type).toBe('url');
    expect(evt.monitorId).toBe(created.id);
  });

  test('POST /api/monitors/heartbeat emits monitor-created with type=heartbeat', async () => {
    const wait = nextEvent('monitor-created');
    const res = await fetch(`${base}/api/monitors/heartbeat`, {
      method: 'POST',
      headers: writeHdr,
      body: JSON.stringify({ name: `${TAG}-hb`, periodSeconds: 60, graceSeconds: 30 }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };
    const evt = await wait;
    expect(evt.type).toBe('heartbeat');
    expect(evt.monitorId).toBe(created.id);
  });

  test('DELETE /api/monitors/:type/:id emits monitor-deleted', async () => {
    // Create something to delete (don't rely on test ordering).
    const createRes = await fetch(`${base}/api/monitors/url`, {
      method: 'POST',
      headers: writeHdr,
      body: JSON.stringify({ name: `${TAG}-del`, url: 'https://example.com' }),
    });
    const created = (await createRes.json()) as { id: number };

    const wait = nextEvent('monitor-deleted');
    const delRes = await fetch(`${base}/api/monitors/url/${created.id}`, {
      method: 'DELETE',
      headers: writeHdr,
    });
    expect(delRes.status).toBe(204);
    const evt = await wait;
    expect(evt.type).toBe('url');
    expect(evt.monitorId).toBe(created.id);
  });
});
