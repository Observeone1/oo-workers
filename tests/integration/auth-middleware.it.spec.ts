/**
 * middleware/auth.ts branch coverage that the other specs don't reach:
 *   - extractKey(): cookie header present but none of its parts is
 *     oo_session (the for-loop runs to completion, falls through to null)
 *   - requireAuth(): a key that authenticates but lacks the required scope
 *     (403, distinct from the 401 "no match" case auth-error-codes.it.spec.ts
 *     covers)
 *
 * requireAgent()'s own scope/region-binding 403s are covered by
 * agent-routes.it.spec.ts (they need a real bound region, which belongs
 * there). Left deliberately uncovered, with reasons:
 *   - VALIDATE_KEY_CACHE "cached row is revoked" branch (96-97): the cache
 *     only ever stores rows fetched via findActiveByPrefix(), which already
 *     filters out revoked rows — a cached entry's `revokedAt` can't become
 *     non-null in place (revocation is a DB write, not a mutation of the
 *     cached object), so this branch is unreachable through any real
 *     validateKey() call path today. It's a belt-and-suspenders guard for a
 *     future change to the caching logic, not exercisable behavior.
 *   - VALIDATE_KEY_CACHE LRU eviction (112-113): needs 1024+ distinct keys
 *     successfully verified (cached only on a real argon2id pass, ~100ms
 *     each per the code's own comment) — 100+ seconds added to the suite to
 *     paint one defensive bookkeeping line, not a reasonable trade.
 *   - requireAuth()'s `scope === 'agent'` branch (165): no production route
 *     ever calls requireAuth('agent') — server.ts, api-keys.ts, events.ts,
 *     artifacts.ts only ever pass 'read'/'write'; requireAgent() (a
 *     different function) is what actually gates /api/agent/*. Dead code
 *     under the current routing table.
 *   - touchLastUsed/touchLastSeen .catch() bodies (149-151, 221-223 in
 *     requireAuth/requireAgent): fire-and-forget error logging that only
 *     runs if the DB write rejects. The call sites themselves (149, 214,
 *     221) are exercised by every successful authenticated request in this
 *     suite; forcing the awaited DB call to actually reject would mean
 *     breaking the shared DB connection mid-suite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions, apiKeys } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';

const ts = Date.now();
const TAG = `authmw-${ts}`;
const EMAIL = `${TAG}@local.test`;
const PW = 'AuthMiddlewarePass1';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let sessionHdr: Record<string, string>;
let userId = -1;
let readOnlyKeyName = '';

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL, PW, 'Auth Middleware Test');
  userId = u.id;
  const token = await authService.createSession(u);
  sessionHdr = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  try {
    if (readOnlyKeyName) await db.delete(apiKeys).where(eq(apiKeys.name, readOnlyKeyName));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch {
    /* best-effort cleanup */
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('extractKey() cookie parsing', () => {
  test('cookie header present but no oo_session part → treated as unauthenticated', async () => {
    const r = await fetch(`${base}/api/monitors`, {
      headers: { cookie: 'foo=bar; other=baz' },
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string; code?: string };
    expect(body.error).toBe('authentication required');
    expect(body.code).toBeUndefined();
  });
});

describe('requireAuth() scope enforcement', () => {
  let readKeyHdr: Record<string, string>;

  beforeAll(async () => {
    const createRes = await fetch(`${base}/api/keys`, {
      method: 'POST',
      headers: sessionHdr,
      body: JSON.stringify({ name: `${TAG}-read-key`, scopes: ['read'] }),
    });
    expect(createRes.status).toBe(200);
    const { cleartextKey } = (await createRes.json()) as { cleartextKey: string };
    readOnlyKeyName = `${TAG}-read-key`;
    readKeyHdr = { Authorization: `Bearer ${cleartextKey}`, 'content-type': 'application/json' };
  });

  test('read-scoped key on a write-only route → 403 key lacks scope', async () => {
    const r = await fetch(`${base}/api/monitors/url`, {
      method: 'POST',
      headers: readKeyHdr,
      body: JSON.stringify({ name: 'should-be-rejected', url: 'https://example.com' }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe(`key lacks 'write' scope`);
  });

  test('the same read-scoped key IS allowed on a read route', async () => {
    const r = await fetch(`${base}/api/monitors`, { headers: readKeyHdr });
    expect(r.status).toBe(200);
  });
});
