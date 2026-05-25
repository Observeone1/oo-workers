/**
 * End-to-end gating test for PATCH /api/auth/profile and POST /api/auth/password.
 * Ported from scripts/auth-profile-test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';
import { userRepo } from '../../src/db/repositories/user.repo.ts';

const ts = Date.now();
const EMAIL0 = `authtest+${ts}@local.test`;
const EMAIL1 = `authtest-renamed+${ts}@local.test`;
const PW0 = 'Origpass123';
const PW_NEW = 'Newpass4567';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let authHdr: Record<string, string>;
const jsonHdr = { 'content-type': 'application/json' };
let userId = -1;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL0, PW0, 'Orig Name');
  userId = u.id;
  const token = await authService.createSession(u);
  authHdr = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  if (userId > 0) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('auth-profile', () => {
  test('A. PATCH /profile without session → 401', async () => {
    const r = await fetch(`${base}/api/auth/profile`, { method: 'PATCH', headers: jsonHdr, body: JSON.stringify({ name: 'x' }) });
    expect(r.status).toBe(401);
  });

  test('B. POST /password without session → 401', async () => {
    const r = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: jsonHdr, body: JSON.stringify({ currentPassword: PW0, newPassword: PW_NEW }) });
    expect(r.status).toBe(401);
  });

  test('C. POST /password {} → 400', async () => {
    const r = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: authHdr, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  test('D. short newPassword → 400, password unchanged', async () => {
    const r = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: authHdr, body: JSON.stringify({ currentPassword: PW0, newPassword: 'short7' }) });
    expect(r.status).toBe(400);
    expect(await authService.login(EMAIL0, PW0)).not.toBeNull();
  });

  test('E. wrong currentPassword → 400, password unchanged', async () => {
    const r = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: authHdr, body: JSON.stringify({ currentPassword: 'TotallyWrong999', newPassword: PW_NEW }) });
    const body = await r.json() as { error?: string };
    expect(r.status).toBe(400);
    expect(/current password is incorrect/i.test(body.error ?? '')).toBe(true);
    expect(await authService.login(EMAIL0, PW0)).not.toBeNull();
    expect(await authService.login(EMAIL0, PW_NEW)).toBeNull();
  });

  test('F. correct currentPassword → 200, old rejected, new accepted', async () => {
    const r = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: authHdr, body: JSON.stringify({ currentPassword: PW0, newPassword: PW_NEW }) });
    expect(r.status).toBe(200);
    expect(await authService.login(EMAIL0, PW0)).toBeNull();
    expect(await authService.login(EMAIL0, PW_NEW)).not.toBeNull();
    const row = await userRepo.findById(userId);
    expect(row?.passwordHash.startsWith('$argon2id')).toBe(true);
  });

  test('G. PATCH /profile {} → 400', async () => {
    const r = await fetch(`${base}/api/auth/profile`, { method: 'PATCH', headers: authHdr, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  test('H. PATCH /profile → 200, name + email updated', async () => {
    const r = await fetch(`${base}/api/auth/profile`, { method: 'PATCH', headers: authHdr, body: JSON.stringify({ name: 'Renamed Person', email: EMAIL1 }) });
    const body = await r.json() as { name: string };
    expect(r.status).toBe(200);
    expect(body.name).toBe('Renamed Person');
    const row = await userRepo.findById(userId);
    expect(row?.name).toBe('Renamed Person');
    expect(row?.email).toBe(EMAIL1);
  });
});
