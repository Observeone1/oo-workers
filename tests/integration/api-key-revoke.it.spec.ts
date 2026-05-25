/**
 * API key revocation — instant cache eviction.
 *
 * Verifies that after POST /api/keys/:id/revoke, a key whose validated-key
 * cache entry was populated by a prior request is rejected immediately (not
 * after the 30 s TTL) — i.e. that evictFromKeyCache is called synchronously
 * in the revoke handler and that the middleware honours the eviction.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';

const ts = Date.now();
const EMAIL = `keyrevoke+${ts}@local.test`;
const PW = 'TestPass12345';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let sessionHdr: Record<string, string>;
let userId = -1;

// Shared across sequential tests A–D.
let keyId = -1;
let cleartextKey = '';
let keyHdr: Record<string, string>;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL, PW, 'Revoke Test');
  userId = u.id;
  const token = await authService.createSession(u);
  sessionHdr = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  if (userId > 0) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('api-key-revocation', () => {
  test('A. create a read-scoped key and confirm it authenticates (cold cache)', async () => {
    const r = await fetch(`${base}/api/keys`, {
      method: 'POST',
      headers: sessionHdr,
      body: JSON.stringify({ name: 'revoke-test', scopes: ['read'] }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { id: number; cleartextKey: string };
    keyId = body.id;
    cleartextKey = body.cleartextKey;
    keyHdr = { Authorization: `Bearer ${cleartextKey}` };

    const auth = await fetch(`${base}/api/keys`, { headers: keyHdr });
    expect(auth.status).toBe(200);
  });

  test('B. second request with the same key hits the validated-key cache (still 200)', async () => {
    const auth = await fetch(`${base}/api/keys`, { headers: keyHdr });
    expect(auth.status).toBe(200);
  });

  test('C. revoke the key (→ 204)', async () => {
    const r = await fetch(`${base}/api/keys/${keyId}/revoke`, {
      method: 'POST',
      headers: sessionHdr,
    });
    expect(r.status).toBe(204);
  });

  test('D. immediately re-auth with the revoked key → 401 (cache evicted, not waiting for TTL)', async () => {
    const auth = await fetch(`${base}/api/keys`, { headers: keyHdr });
    expect(auth.status).toBe(401);
  });
});
