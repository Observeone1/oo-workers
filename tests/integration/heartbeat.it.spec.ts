/**
 * End-to-end gating test for heartbeat monitors.
 * Ported from scripts/heartbeat-test.ts.
 * Needs session DB + Redis + HTTP server.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, like } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { heartbeatRepo } from '../../src/db/repositories/heartbeat.repo.ts';
import { heartbeatMonitors, users, sessions, apiKeys } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';

const ts = Date.now();
const TAG = `hbtest-${ts}`;
const EMAIL = `hb+${ts}@local.test`;
const PW = 'Hbpass123';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let writeHdr: Record<string, string>;
let userId = -1;
let createdHeartbeatId = -1;
let createdToken = '';

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

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
  writeHdr = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  try {
    await db.delete(heartbeatMonitors).where(like(heartbeatMonitors.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch { /* ignore */ }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('heartbeat monitors', () => {
  test('A. POST /api/monitors/heartbeat → 201, token + PENDING', async () => {
    const res = await fetch(`${base}/api/monitors/heartbeat`, {
      method: 'POST', headers: writeHdr,
      body: JSON.stringify({ name: `${TAG}-cron`, periodSeconds: 60, graceSeconds: 30 }),
    });
    const body = await res.json() as { id: number; token: string; status: string; periodSeconds: number; graceSeconds: number };
    expect(res.status).toBe(201);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.status).toBe('PENDING');
    expect(body.periodSeconds).toBe(60);
    expect(body.graceSeconds).toBe(30);
    createdHeartbeatId = body.id;
    createdToken = body.token;
  });

  test('B. period < 30 → 400', async () => {
    const r = await fetch(`${base}/api/monitors/heartbeat`, {
      method: 'POST', headers: writeHdr,
      body: JSON.stringify({ name: 'bad', periodSeconds: 5 }),
    });
    expect(r.status).toBe(400);
  });

  test('B. no name → 400', async () => {
    const r = await fetch(`${base}/api/monitors/heartbeat`, {
      method: 'POST', headers: writeHdr,
      body: JSON.stringify({ periodSeconds: 60 }),
    });
    expect(r.status).toBe(400);
  });

  test('C. POST /heartbeat/:token unauthenticated → 200, status UP', async () => {
    const r = await fetch(`${base}/heartbeat/${createdToken}`, { method: 'POST' });
    const body = await r.json() as { ok: boolean; status: string; lastPingAt: string };
    expect(r.status).toBe(200);
    expect(body.status).toBe('UP');
    expect(typeof body.lastPingAt).toBe('string');
  });

  test('D. GET /heartbeat/:token is read-only (lastPingAt unchanged)', async () => {
    const before = await db.select({ lastPingAt: heartbeatMonitors.lastPingAt })
      .from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    const beforeMs = before[0].lastPingAt?.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 1100));
    const r = await fetch(`${base}/heartbeat/${createdToken}`);
    expect(r.status).toBe(200);
    const after = await db.select({ lastPingAt: heartbeatMonitors.lastPingAt })
      .from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    expect(after[0].lastPingAt?.getTime()).toBe(beforeMs);
  }, 5_000);

  test('E. unknown token → 404', async () => {
    const r = await fetch(`${base}/heartbeat/totally-not-a-real-token`, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  test('F. findOverdue + markOverdue transitions UP → OVERDUE', async () => {
    const past = new Date(Date.now() - (60 + 30 + 10) * 1000);
    await db.update(heartbeatMonitors).set({ lastPingAt: past }).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    const overdue = await heartbeatRepo.findOverdue();
    expect(overdue.some((h) => h.id === createdHeartbeatId)).toBe(true);
    const t = await heartbeatRepo.markOverdue(createdHeartbeatId);
    expect(t?.status).toBe('OVERDUE');
  });

  test('G. second markOverdue is idempotent (no double alert)', async () => {
    const r = await heartbeatRepo.markOverdue(createdHeartbeatId);
    expect(r).toBeNull();
  });

  test('H. recordPing after OVERDUE returns wasOverdue=true', async () => {
    const r = await heartbeatRepo.recordPing(createdToken);
    expect(r?.wasOverdue).toBe(true);
    expect(r?.row.status).toBe('UP');
  });

  test('I. ping on already-UP heartbeat: wasOverdue=false', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const r = await heartbeatRepo.recordPing(createdToken);
    expect(r?.wasOverdue).toBe(false);
    expect(r?.row.status).toBe('UP');
  }, 5_000);

  test('J. final DB row is UP, lastPingAt recent', async () => {
    const [row] = await db.select().from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    expect(row.status).toBe('UP');
    expect(row.lastPingAt).not.toBeNull();
    expect(Date.now() - (row.lastPingAt?.getTime() ?? 0)).toBeLessThan(5000);
  });

  test('K. /api/monitors includes heartbeat section', async () => {
    const r = await fetch(`${base}/api/monitors`, { headers: writeHdr });
    const body = await r.json() as { heartbeat: Array<{ id: number }> };
    expect(Array.isArray(body.heartbeat)).toBe(true);
    expect(body.heartbeat.some((h) => h.id === createdHeartbeatId)).toBe(true);
  });

  test('M. burst debounce — 10 rapid pings, only first bumps lastPingAt', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const before = await db.select({ lastPingAt: heartbeatMonitors.lastPingAt })
      .from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    const beforeMs = before[0].lastPingAt?.getTime() ?? 0;
    const burst = await Promise.all(
      Array.from({ length: 10 }).map(() => fetch(`${base}/heartbeat/${createdToken}`, { method: 'POST' })),
    );
    expect(burst.every((r) => r.status === 200)).toBe(true);
    const after = await db.select({ lastPingAt: heartbeatMonitors.lastPingAt })
      .from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    expect(after[0].lastPingAt?.getTime() ?? 0).toBeGreaterThan(beforeMs);
    // 11th ping inside 1s window must not bump lastPingAt again
    const afterBurstMs = after[0].lastPingAt?.getTime() ?? 0;
    await fetch(`${base}/heartbeat/${createdToken}`, { method: 'POST' });
    const postDebounce = await db.select({ lastPingAt: heartbeatMonitors.lastPingAt })
      .from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    expect(postDebounce[0].lastPingAt?.getTime() ?? 0).toBe(afterBurstMs);
  }, 10_000);

  test('N. disabled heartbeat → POST + GET both 404', async () => {
    await db.update(heartbeatMonitors).set({ enabled: false }).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    const p = await fetch(`${base}/heartbeat/${createdToken}`, { method: 'POST' });
    const g = await fetch(`${base}/heartbeat/${createdToken}`);
    expect(p.status).toBe(404);
    expect(g.status).toBe(404);
    await db.update(heartbeatMonitors).set({ enabled: true }).where(eq(heartbeatMonitors.id, createdHeartbeatId));
  });

  test('L. DELETE /api/monitors/heartbeat/:id → 204, row gone', async () => {
    const r = await fetch(`${base}/api/monitors/heartbeat/${createdHeartbeatId}`, { method: 'DELETE', headers: writeHdr });
    expect(r.status).toBe(204);
    const [gone] = await db.select().from(heartbeatMonitors).where(eq(heartbeatMonitors.id, createdHeartbeatId));
    expect(gone).toBeUndefined();
    createdHeartbeatId = -1;
  });
});
