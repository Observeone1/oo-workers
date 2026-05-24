/**
 * Live-server gating test for SaaS→self-host heartbeat import.
 * Ported from scripts/import-heartbeat-e2e-test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { heartbeatMonitors, users, sessions, apiKeys } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';

const ts = Date.now();
const TAG = `hbimport-${ts}`;
const EMAIL = `hbimport+${ts}@local.test`;
const PW = 'Hbpass123';
const FIXED_TOKEN = `e2e-import-token-${randomBytes(8).toString('hex')}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let writeHdr: Record<string, string>;
let userId = -1;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL, PW, 'Heartbeat Import Test');
  userId = u.id;
  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({ name: TAG, keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN), keyHash, scopes: ['write'] });
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

const importPayload = (heartbeats: unknown[]) => JSON.stringify({
  version: 1, urlMonitors: [], apiChecks: [], qaProjects: [], channels: [], heartbeats,
});

describe('import-heartbeat-e2e', () => {
  test('A. import with ping_key → 200, heartbeat=1', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: writeHdr,
      body: importPayload([{ name: `${TAG}-kept`, description: 'imported', periodSeconds: 120, graceSeconds: 30, token: FIXED_TOKEN }]),
    });
    const body = await res.json() as { heartbeat?: number; skipped?: string[] };
    expect(res.status).toBe(200);
    expect(body.heartbeat).toBe(1);
    expect((body.skipped ?? []).length).toBe(0);
  });

  test('B. imported row has the SUPPLIED token (preserves URL)', async () => {
    const res = await fetch(`${base}/api/monitors`, { headers: writeHdr });
    const body = await res.json() as { heartbeat: Array<{ name: string; token: string; status: string }> };
    const row = body.heartbeat.find((h) => h.name === `${TAG}-kept`);
    expect(row).toBeDefined();
    expect(row?.token).toBe(FIXED_TOKEN);
    expect(row?.status).toBe('PENDING');
  });

  test('C. POST /heartbeat/<preserved-token> → 200, status UP', async () => {
    const r = await fetch(`${base}/heartbeat/${FIXED_TOKEN}`, { method: 'POST' });
    const body = await r.json() as { status: string };
    expect(r.status).toBe(200);
    expect(body.status).toBe('UP');
  });

  test('D. import WITHOUT token → fresh token generated (not FIXED_TOKEN)', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: writeHdr,
      body: importPayload([{ name: `${TAG}-fresh`, periodSeconds: 60, graceSeconds: 30 }]),
    });
    expect(res.status).toBe(200);
    const list = await (await fetch(`${base}/api/monitors`, { headers: writeHdr })).json() as { heartbeat: Array<{ name: string; token: string }> };
    const row = list.heartbeat.find((h) => h.name === `${TAG}-fresh`);
    expect(row).toBeDefined();
    expect(row?.token).not.toBe(FIXED_TOKEN);
    expect(row?.token.length).toBeGreaterThanOrEqual(40);
    expect(/^[A-Za-z0-9_-]+$/.test(row?.token ?? '')).toBe(true);
  });

  test('E. period < 30 → skipped, no row created', async () => {
    const badName = `${TAG}-bad`;
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: writeHdr,
      body: importPayload([{ name: badName, periodSeconds: 5, graceSeconds: 30 }]),
    });
    const body = await res.json() as { heartbeat?: number; skipped?: string[] };
    expect(body.heartbeat).toBe(0);
    expect((body.skipped ?? []).some((s) => s.includes(badName))).toBe(true);
    const list = await (await fetch(`${base}/api/monitors`, { headers: writeHdr })).json() as { heartbeat: Array<{ name: string }> };
    expect(list.heartbeat.find((h) => h.name === badName)).toBeUndefined();
  });
});
