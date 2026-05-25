/**
 * POST /api/monitors/api assertion validation.
 *
 * The api_assertions table has NOT NULL on (type, operator). Before the fix,
 * a body with assertions[i].type missing/invalid landed as a Postgres
 * constraint error → 500. Now the route validates the array first and
 * returns 400 with a useful message.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';

const ts = Date.now();
const EMAIL = `apiassert+${ts}@local.test`;
const PW = 'TestPass12345';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let hdr: Record<string, string>;
let userId = -1;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;
  const u = await authService.register(EMAIL, PW, 'API Assertion Test');
  userId = u.id;
  const token = await authService.createSession(u);
  hdr = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  if (userId > 0) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

async function postApi(body: unknown) {
  return fetch(`${base}/api/monitors/api`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify(body),
  });
}

describe('api-monitor assertion validation', () => {
  test('missing type → 400, not 500', async () => {
    const r = await postApi({
      name: 'no-type',
      url: 'https://example.com',
      assertions: [{ operator: 'equals', value: '200' }],
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/assertions\[0\]\.type/);
  });

  test('invalid type string → 400', async () => {
    const r = await postApi({
      name: 'bad-type',
      url: 'https://example.com',
      assertions: [{ type: 'totally_bogus', operator: 'equals', value: '200' }],
    });
    expect(r.status).toBe(400);
  });

  test('invalid operator → 400', async () => {
    const r = await postApi({
      name: 'bad-op',
      url: 'https://example.com',
      assertions: [{ type: 'status_code', operator: 'kinda_equals', value: '200' }],
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/assertions\[0\]\.operator/);
  });

  test('assertions not an array → 400', async () => {
    const r = await postApi({
      name: 'not-array',
      url: 'https://example.com',
      assertions: { type: 'status_code', operator: 'equals' },
    });
    expect(r.status).toBe(400);
  });

  test('valid assertion → 201', async () => {
    const r = await postApi({
      name: `valid-${ts}`,
      url: 'https://example.com',
      assertions: [{ type: 'status_code', operator: 'equals', value: '200' }],
    });
    expect(r.status).toBe(201);
  });

  test('empty assertions array → 201 (no assertions is a valid choice)', async () => {
    const r = await postApi({
      name: `empty-${ts}`,
      url: 'https://example.com',
      assertions: [],
    });
    expect(r.status).toBe(201);
  });
});
