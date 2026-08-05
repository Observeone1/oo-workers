/**
 * /api/auth/* branch coverage for setup-status, setup's already-set-up gate,
 * login (API-key + email/password, both rate-limit buckets), logout, and me
 * — the surfaces auth-profile.it.spec.ts (profile/password) and
 * api-assertion-validation.it.spec.ts (session-header auth) don't touch.
 *
 * POST /api/auth/setup's validation + first-admin-creation branches
 * (needsSetup === true) are deliberately NOT covered here: `needsSetup()` is
 * `userRepo.count() === 0` over the ENTIRE shared users table, and every
 * .it.spec.ts file in this run shares one Postgres database (set once in
 * tests/integration/setup.ts) — dozens of other files create real user rows
 * that are never fully drained back to zero. There's no isolated-DB seam for
 * the server's `db` singleton (bound to DATABASE_URL at first import), so
 * forcing an empty users table here would mean deleting rows other
 * concurrently-running files depend on. Only the "already set up" 409 gate
 * (reachable with the table in its normal non-empty state) is covered.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions, apiKeys } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';

const ts = Date.now();
const TAG = `authrt-${ts}`;
const EMAIL = `${TAG}@local.test`;
const PW = 'AuthRoutesPass1';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let userId = -1;
let cleartextApiKey = '';

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL, PW, 'Auth Routes Test');
  userId = u.id;

  cleartextApiKey = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartextApiKey, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartextApiKey.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['write'],
  });
}, 30_000);

afterAll(async () => {
  try {
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
  } catch {
    /* best-effort cleanup */
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('GET /api/auth/setup-status', () => {
  test('returns a boolean needsSetup flag', async () => {
    const r = await fetch(`${base}/api/auth/setup-status`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { needsSetup: boolean };
    expect(typeof body.needsSetup).toBe('boolean');
  });
});

describe('POST /api/auth/setup', () => {
  test('already set up (users exist) → 409', async () => {
    const r = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'someone-else@local.test', password: 'irrelevant123' }),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('already set up');
  });
});

describe('POST /api/auth/login — API key (backwards compat)', () => {
  test('empty key string → 400', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '  ' }),
    });
    expect(r.status).toBe(400);
  });

  test('invalid key → 401', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'oo_totallyBogusKeyValue' }),
    });
    expect(r.status).toBe(401);
  });

  test('valid key → 200 + set-cookie, name/prefix/scopes in body', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: cleartextApiKey }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/oo_session=/);
    const body = (await r.json()) as { name: string; scopes: string[] };
    expect(body.name).toBe(TAG);
    expect(body.scopes).toEqual(['write']);
  });
});

describe('POST /api/auth/login — email/password', () => {
  test('missing email/password → 400', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${TAG}-ip-missing` },
      body: JSON.stringify({ email: '' }),
    });
    expect(r.status).toBe(400);
  });

  test('unknown email → 401', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${TAG}-ip-unknown` },
      body: JSON.stringify({ email: `nope-${TAG}@local.test`, password: 'whatever123' }),
    });
    expect(r.status).toBe(401);
  });

  test('wrong password → 401', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${TAG}-ip-wrongpw` },
      body: JSON.stringify({ email: EMAIL, password: 'TotallyWrongPassword1' }),
    });
    expect(r.status).toBe(401);
  });

  test('correct credentials → 200 + set-cookie', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${TAG}-ip-correct` },
      body: JSON.stringify({ email: EMAIL, password: PW }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/oo_session=/);
    const body = (await r.json()) as { email: string };
    expect(body.email).toBe(EMAIL);
  });

  test('x-forwarded-for with an empty first segment falls back to x-real-ip/unknown, still works', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ',,' },
      body: JSON.stringify({ email: `xffedge-${TAG}@local.test`, password: 'x' }),
    });
    // No real user for this email — 401, but proves clientIp() didn't throw
    // and the request was still rate-bucketed (falls through to x-real-ip
    // -> 'unknown').
    expect(r.status).toBe(401);
  });

  test('IP rate limit: 11th attempt from the same IP → 429', async () => {
    const ip = `${TAG}-ip-flood`;
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: `flood-${i}-${TAG}@local.test`, password: 'x' }),
      });
    }
    expect(last!.status).toBe(429);
  });

  test('email rate limit: 11th attempt for the same email (different IPs) → 429', async () => {
    const email = `emailflood-${TAG}@local.test`;
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `${TAG}-ip-emailflood-${i}` },
        body: JSON.stringify({ email, password: 'x' }),
      });
    }
    expect(last!.status).toBe(429);
  });

  test('IP rate-bucket LRU eviction: cycling through LOGIN_LIMIT_CACHE_MAX+1 distinct IPs evicts the oldest entry without erroring', async () => {
    // LOGIN_LIMIT_CACHE_MAX is 2048 — send one login attempt per distinct IP
    // (never repeating one, so no single IP ever trips the 10/window limit)
    // until the ipBuckets Map has to evict its oldest entry to stay bounded.
    // Must stay LAST in this describe block: it also drives emailBuckets to
    // capacity as a side effect (2049 distinct emails), and leaves both
    // module-level Maps full for the rest of the process — running it before
    // the two flood tests above would perturb their bucket state.
    const CACHE_MAX = 2048;
    const batchSize = 100;
    let lastStatus = 0;
    for (let start = 0; start < CACHE_MAX + 1; start += batchSize) {
      const count = Math.min(batchSize, CACHE_MAX + 1 - start);
      const results = await Promise.all(
        Array.from({ length: count }, (_, j) => {
          const i = start + j;
          return fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': `${TAG}-lru-${i}`,
            },
            body: JSON.stringify({ email: `lru-${i}-${TAG}@local.test`, password: 'x' }),
          });
        }),
      );
      lastStatus = results.at(-1)!.status;
    }
    // Every request used a fresh IP + fresh nonexistent email, so each is a
    // clean 401 — the point is that the (CACHE_MAX + 1)th distinct IP still
    // gets served correctly (no crash) once eviction kicks in.
    expect(lastStatus).toBe(401);
  }, 60_000);
});

describe('GET /api/auth/me', () => {
  test('no credential → 401', async () => {
    const r = await fetch(`${base}/api/auth/me`);
    expect(r.status).toBe(401);
  });

  test('valid API key → 200 name/prefix/scopes', async () => {
    const r = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${cleartextApiKey}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { name: string };
    expect(body.name).toBe(TAG);
  });

  test('valid session → 200 name/email/role', async () => {
    const token = await authService.createSession(await authService.login(EMAIL, PW).then((r) => r!.user));
    const r = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { email: string };
    expect(body.email).toBe(EMAIL);
  });

  test('garbage credential (neither key nor session) → 401 invalid/expired', async () => {
    const r = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: 'Bearer not-a-real-key-or-session-token' },
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/invalid or expired session/);
  });
});

describe('POST /api/auth/logout', () => {
  test('no credential → 204, cookie cleared', async () => {
    const r = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    expect(r.status).toBe(204);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  test('API key credential → 204 (nothing to destroy server-side)', async () => {
    const r = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cleartextApiKey}` },
    });
    expect(r.status).toBe(204);
  });

  test('session credential → 204, session actually destroyed', async () => {
    const result = await authService.login(EMAIL, PW);
    const r = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `oo_session=${result!.token}` },
    });
    expect(r.status).toBe(204);

    const meAfter = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${result!.token}` },
    });
    expect(meAfter.status).toBe(401);
  });

  test('garbage credential (neither key nor session) → still 204', async () => {
    const r = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: 'oo_session=not-a-real-session-token' },
    });
    expect(r.status).toBe(204);
  });
});
