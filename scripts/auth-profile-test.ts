#!/usr/bin/env bun
/**
 * Gating test for the self-service account endpoints added in the v2 UI
 * redesign (PR #45):
 *
 *   PATCH /api/auth/profile   — change own name / email
 *   POST  /api/auth/password  — change own password
 *
 * These ship security-sensitive logic (Bun.password.verify on the
 * current password, argon2id rehash) and had ZERO committed coverage —
 * a break from this repo's anti-vacuous-gating-test discipline. This
 * closes that gap end-to-end: it boots the REAL Hono app via
 * startServer() and drives the real routes over HTTP, authenticating
 * exactly like the browser (session token → Bearer, read by
 * extractKey).
 *
 * Anti-vacuous by construction. The negative control is the
 * wrong-current-password case (step E): a changePassword that failed to
 * verify the current password would return 200 there and flip the
 * password — so step E asserts the password is UNCHANGED (old still
 * logs in, candidate-new does not). The positive case (step F) then
 * proves the happy path actually rehashes and invalidates the old
 * password. Off/on pair: a no-op handler fails E's "still rejected",
 * a verify-skipping handler fails E's "password unchanged".
 *
 * Needs Postgres + Redis (startServer wires BullMQ). Mutates the
 * integration DB with a unique throwaway user + sessions, deleted in a
 * finally. Run: `bun run test:auth-profile`. Also a stage in
 * scripts/run-integration.sh.
 */

import { createServer } from 'node:net';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { startServer } from '../src/server.ts';
import { authService } from '../src/services/auth.service.ts';
import { userRepo } from '../src/db/repositories/user.repo.ts';
import { db } from '../src/config/db.ts';
import { users, sessions } from '../src/db/schema.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const ts = Date.now();
const EMAIL0 = `authtest+${ts}@local.test`;
const EMAIL1 = `authtest-renamed+${ts}@local.test`;
const PW0 = 'Origpass123';
const PW_NEW = 'Newpass4567';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

let stopServer: (() => Promise<void>) | null = null;
let userId = -1;

try {
  const port = await freePort();
  stopServer = startServer(connection, port);
  const base = `http://127.0.0.1:${port}`;

  // Real user + real session, created via the same service the app uses.
  const u = await authService.register(EMAIL0, PW0, 'Orig Name');
  userId = u.id;
  const token = await authService.createSession(u);
  const authHdr = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const jsonHdr = { 'content-type': 'application/json' };

  // Give Bun.serve a moment to bind.
  await new Promise((r) => setTimeout(r, 300));

  // ---- A/B: unauthenticated requests are rejected (route guard) ----
  const aNo = await fetch(`${base}/api/auth/profile`, {
    method: 'PATCH',
    headers: jsonHdr,
    body: JSON.stringify({ name: 'x' }),
  });
  check('A. PATCH /profile without session → 401', aNo.status === 401, `got ${aNo.status}`);

  const bNo = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: jsonHdr,
    body: JSON.stringify({ currentPassword: PW0, newPassword: PW_NEW }),
  });
  check('B. POST /password without session → 401', bNo.status === 401, `got ${bNo.status}`);

  // ---- C: password change with missing fields → 400 ----
  const cBad = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({}),
  });
  check('C. POST /password {} → 400', cBad.status === 400, `got ${cBad.status}`);

  // ---- D: new password too short → 400, and password UNCHANGED ----
  const dShort = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ currentPassword: PW0, newPassword: 'short7' }),
  });
  check('D. POST /password newPassword<8 → 400', dShort.status === 400, `got ${dShort.status}`);
  check('D. password unchanged after short-reject', !!(await authService.login(EMAIL0, PW0)));

  // ---- E: NEGATIVE CONTROL — wrong current password ----
  // Must be rejected AND must not have changed anything.
  const eWrong = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ currentPassword: 'TotallyWrong999', newPassword: PW_NEW }),
  });
  const eBody = await eWrong.json().catch(() => ({}));
  check('E. wrong currentPassword → 400', eWrong.status === 400, `got ${eWrong.status}`);
  check(
    'E. generic error (no enumeration)',
    typeof eBody.error === 'string' && /current password is incorrect/i.test(eBody.error),
    JSON.stringify(eBody),
  );
  check('E. old password STILL works (unchanged)', !!(await authService.login(EMAIL0, PW0)));
  check(
    'E. candidate-new password does NOT work',
    (await authService.login(EMAIL0, PW_NEW)) === null,
  );

  // ---- F: POSITIVE — correct current password rotates it ----
  const fOk = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: authHdr,
    body: JSON.stringify({ currentPassword: PW0, newPassword: PW_NEW }),
  });
  check('F. correct currentPassword → 200', fOk.status === 200, `got ${fOk.status}`);
  check('F. old password now REJECTED', (await authService.login(EMAIL0, PW0)) === null);
  check('F. new password now ACCEPTED', !!(await authService.login(EMAIL0, PW_NEW)));
  const afterPw = await userRepo.findById(userId);
  check(
    'F. stored hash is argon2id',
    !!afterPw && afterPw.passwordHash.startsWith('$argon2id'),
    afterPw?.passwordHash.slice(0, 12),
  );

  // ---- G: profile update with no fields → 400 ----
  const gBad = await fetch(`${base}/api/auth/profile`, {
    method: 'PATCH',
    headers: authHdr,
    body: JSON.stringify({}),
  });
  check('G. PATCH /profile {} → 400', gBad.status === 400, `got ${gBad.status}`);

  // ---- H: profile update applies name + email ----
  const hOk = await fetch(`${base}/api/auth/profile`, {
    method: 'PATCH',
    headers: authHdr,
    body: JSON.stringify({ name: 'Renamed Person', email: EMAIL1 }),
  });
  const hBody = await hOk.json().catch(() => ({}));
  check('H. PATCH /profile → 200', hOk.status === 200, `got ${hOk.status}`);
  check('H. response reflects new name', hBody.name === 'Renamed Person', JSON.stringify(hBody));
  const afterProfile = await userRepo.findById(userId);
  check(
    'H. DB row updated (name + email)',
    !!afterProfile && afterProfile.name === 'Renamed Person' && afterProfile.email === EMAIL1,
    `${afterProfile?.name} / ${afterProfile?.email}`,
  );
} finally {
  if (userId > 0) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  if (stopServer) await stopServer().catch(() => {});
  connection.disconnect();
}

console.log(failed ? '\n❌ auth-profile-test FAILED' : '\n✅ auth-profile-test passed');
process.exit(failed ? 1 : 0);
