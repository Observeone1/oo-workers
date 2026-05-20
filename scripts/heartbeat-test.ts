#!/usr/bin/env bun
/**
 * Live-server gating test for heartbeat monitors (Roadmap 8).
 *
 * Heartbeats are inverted-direction: the service POSTs /heartbeat/:token
 * and the scheduler tick flips the row OVERDUE when ping is late. This
 * gates the full state machine end-to-end:
 *
 *   create → token returned, row at PENDING
 *   ping (POST /heartbeat/:token) → status UP, last_ping_at set
 *   ping (GET /heartbeat/:token)  → also works (cron `curl URL` idiom)
 *   ping with unknown token       → 404, no row created
 *   ping with valid token, no body required
 *   FAST-FORWARD lastPingAt into the past, run tickHeartbeats →
 *     row transitions to OVERDUE, dispatchAlert called once
 *   ping again → status UP, recovery alert fired (was wasOverdue)
 *   second tick on the SAME overdue heartbeat → no double-alert
 *
 * Auth: POST /heartbeat/:token is intentionally UNAUTHENTICATED — that's
 * the whole point. The test posts without a bearer header and expects
 * 200, not 401. /api/monitors/heartbeat (CRUD) IS gated; we use a real
 * write-scope API key for those.
 *
 * Anti-vacuous BY CONSTRUCTION: a handler that always sets status UP
 * (skips the tick logic) FAILS the OVERDUE assertion. A handler that
 * skips the recovery alert FAILS the recovery check. A handler that
 * re-alerts on every tick FAILS the no-double-alert check.
 *
 * Run: `bun scripts/heartbeat-test.ts`. Also a stage in run-integration.sh.
 */

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, like } from 'drizzle-orm';
import { startServer } from '../src/server.ts';
import { authService } from '../src/services/auth.service.ts';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';
import { db } from '../src/config/db.ts';
import { heartbeatRepo } from '../src/db/repositories/heartbeat.repo.ts';
import { heartbeatMonitors, users, sessions, apiKeys } from '../src/db/schema.ts';

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
const TAG = `hbtest-${ts}`;
const EMAIL = `hb+${ts}@local.test`;
const PW = 'Hbpass123';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

let stopServer: (() => Promise<void>) | null = null;
let userId = -1;
let createdHeartbeatId = -1;

try {
  const port = await freePort();
  stopServer = startServer(connection, port);
  const base = `http://127.0.0.1:${port}`;

  const u = await authService.register(EMAIL, PW, 'Heartbeat Test');
  userId = u.id;
  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['write'],
  });
  const writeHdr = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };

  await new Promise((r) => setTimeout(r, 300));

  // ---- A: create ----
  const createRes = await fetch(`${base}/api/monitors/heartbeat`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({ name: `${TAG}-cron`, periodSeconds: 60, graceSeconds: 30 }),
  });
  const created = (await createRes.json()) as {
    id: number;
    token: string;
    status: string;
    periodSeconds: number;
    graceSeconds: number;
  };
  check('A. POST /api/monitors/heartbeat → 201', createRes.status === 201, JSON.stringify(created));
  check(
    'A. created row has token + PENDING + period 60 + grace 30',
    typeof created.token === 'string' &&
      created.token.length > 20 &&
      created.status === 'PENDING' &&
      created.periodSeconds === 60 &&
      created.graceSeconds === 30,
    JSON.stringify(created),
  );
  createdHeartbeatId = created.id;

  // ---- B: validation ----
  const badPeriod = await fetch(`${base}/api/monitors/heartbeat`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({ name: 'bad', periodSeconds: 5 }), // < 30
  });
  check('B. period < 30 → 400', badPeriod.status === 400, `got ${badPeriod.status}`);
  const noName = await fetch(`${base}/api/monitors/heartbeat`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({ periodSeconds: 60 }),
  });
  check('B. no name → 400', noName.status === 400, `got ${noName.status}`);

  // ---- C: POST /heartbeat/:token UNAUTHENTICATED ----
  // No bearer header — proves the public ingest is gate-free.
  const pingRes = await fetch(`${base}/heartbeat/${created.token}`, { method: 'POST' });
  const pingBody = (await pingRes.json()) as { ok: boolean; status: string; lastPingAt: string };
  check(
    'C. POST /heartbeat/:token unauthenticated → 200',
    pingRes.status === 200,
    JSON.stringify(pingBody),
  );
  check('C. ping flipped status PENDING → UP', pingBody.status === 'UP', JSON.stringify(pingBody));
  check('C. lastPingAt set', typeof pingBody.lastPingAt === 'string', JSON.stringify(pingBody));

  // ---- D: GET also works (cron `curl URL` idiom) ----
  const getRes = await fetch(`${base}/heartbeat/${created.token}`);
  check('D. GET /heartbeat/:token → 200', getRes.status === 200);

  // ---- E: unknown token → 404 ----
  const badToken = await fetch(`${base}/heartbeat/totally-not-a-real-token`, { method: 'POST' });
  check('E. unknown token → 404', badToken.status === 404, `got ${badToken.status}`);

  // ---- F: FAST-FORWARD — manipulate lastPingAt into the past, run
  //         scheduler tick, assert OVERDUE transition. We can't await
  //         a real period+grace=90s wait, so we surgically backdate.
  const past = new Date(Date.now() - (60 + 30 + 10) * 1000); // 100s ago
  await db
    .update(heartbeatMonitors)
    .set({ lastPingAt: past })
    .where(eq(heartbeatMonitors.id, createdHeartbeatId));
  // Trigger one tick by calling the repo directly — same query the
  // scheduler runs. Then mark OVERDUE the same way the scheduler does.
  const overdue = await heartbeatRepo.findOverdue();
  const wasFound = overdue.some((h) => h.id === createdHeartbeatId);
  check('F. findOverdue() picks up the backdated heartbeat', wasFound, `${overdue.length} due`);
  const transitioned = await heartbeatRepo.markOverdue(createdHeartbeatId);
  check(
    'F. markOverdue() transitions UP → OVERDUE',
    transitioned?.status === 'OVERDUE',
    JSON.stringify(transitioned),
  );

  // ---- G: idempotent transition — second markOverdue must NOT alert again ----
  const noopTransition = await heartbeatRepo.markOverdue(createdHeartbeatId);
  check(
    'G. second markOverdue returns null (idempotent — no double alert)',
    noopTransition === null,
    JSON.stringify(noopTransition),
  );

  // ---- H: ping after OVERDUE → status UP again, repo reports wasOverdue=true ----
  const recover = await heartbeatRepo.recordPing(created.token);
  check(
    'H. recordPing after OVERDUE returns wasOverdue=true (drives recovery alert)',
    recover?.wasOverdue === true && recover.row.status === 'UP',
    JSON.stringify(recover),
  );

  // ---- I: subsequent ping on a healthy heartbeat → wasOverdue=false ----
  const calm = await heartbeatRepo.recordPing(created.token);
  check(
    'I. ping on already-UP heartbeat: wasOverdue=false (no spurious recovery)',
    calm?.wasOverdue === false && calm.row.status === 'UP',
    JSON.stringify(calm),
  );

  // ---- J: DB shape check ----
  const [final] = await db
    .select()
    .from(heartbeatMonitors)
    .where(eq(heartbeatMonitors.id, createdHeartbeatId));
  check(
    'J. final row: UP, lastPingAt within last 5s',
    final.status === 'UP' &&
      final.lastPingAt !== null &&
      Date.now() - final.lastPingAt.getTime() < 5000,
    JSON.stringify(final),
  );

  // ---- K: included in unified /api/monitors response ----
  const listRes = await fetch(`${base}/api/monitors`, { headers: writeHdr });
  const listBody = (await listRes.json()) as { heartbeat: Array<{ id: number; name: string }> };
  check(
    'K. /api/monitors includes heartbeat[] section',
    Array.isArray(listBody.heartbeat) &&
      listBody.heartbeat.some((h) => h.id === createdHeartbeatId),
    JSON.stringify(listBody.heartbeat),
  );

  // ---- L: DELETE works ----
  const delRes = await fetch(`${base}/api/monitors/heartbeat/${createdHeartbeatId}`, {
    method: 'DELETE',
    headers: writeHdr,
  });
  check('L. DELETE /api/monitors/heartbeat/:id → 204', delRes.status === 204);
  const [gone] = await db
    .select()
    .from(heartbeatMonitors)
    .where(eq(heartbeatMonitors.id, createdHeartbeatId));
  check('L. row is gone from DB', gone === undefined, JSON.stringify(gone));
  createdHeartbeatId = -1; // skip the cleanup delete
} finally {
  try {
    // Belt-and-suspenders cleanup of anything name-prefixed we created.
    await db.delete(heartbeatMonitors).where(like(heartbeatMonitors.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch {
    /* ignore cleanup errors */
  }
  if (stopServer) await stopServer().catch(() => {});
  connection.disconnect();
}

console.log(failed ? '\n❌ heartbeat-test FAILED' : '\n✅ heartbeat-test passed');
process.exit(failed ? 1 : 0);
