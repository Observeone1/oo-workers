/**
 * requireAuth distinguishes between Bearer-key and session-cookie failures.
 *
 * Before this change, both code paths returned the same generic
 * "invalid or revoked key" — confusing for dashboard users whose session
 * expired (they never minted a key). Now the middleware checks which
 * credential the request actually sent and tailors the response:
 *
 *   - Authorization: Bearer <bad-key>  → 401 { code: 'key_invalid' }
 *   - Cookie: oo_session=<expired>     → 401 { code: 'session_expired' }
 *   - Neither                          → 401 (no code, "authentication required")
 *
 * The code field lets the dashboard auto-redirect to /login on
 * session_expired without false-redirecting Bearer-key consumers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { acquireRedisDb, startTestServer } from './_harness.ts';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;
}, 60_000);

afterAll(async () => {
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('requireAuth error wording', () => {
  test('no credential → 401 + "authentication required" (no code field)', async () => {
    const res = await fetch(`${base}/api/monitors`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe('authentication required');
    expect(body.code).toBeUndefined();
  });

  test('Bearer header with invalid key → 401 + code "key_invalid"', async () => {
    const res = await fetch(`${base}/api/monitors`, {
      headers: { authorization: 'Bearer oo_thisIsDefinitelyNotAValidKey' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('key_invalid');
    expect(body.error).toMatch(/invalid or revoked/i);
  });

  test('session cookie with bogus value → 401 + code "session_expired"', async () => {
    const res = await fetch(`${base}/api/monitors`, {
      headers: { cookie: 'oo_session=this-session-token-does-not-exist' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('session_expired');
    expect(body.error).toMatch(/session expired/i);
  });
});
