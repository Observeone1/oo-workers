/**
 * Stalled-execution projection lands on the GET response.
 *
 * Unit tests in src/services/exec-projection.spec.ts already cover the
 * pure function. This spec proves the wiring: a master-path PENDING row
 * older than 2× interval, served through /api/monitors and
 * /api/monitors/url/:id, comes back projected as FAILED.
 *
 * Master path = region_id IS NULL. Pre-fix this was deliberately exempted.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { users, sessions } from '../../src/db/schema.ts';
import { authService } from '../../src/services/auth.service.ts';

const ts = Date.now();
const EMAIL = `stalled+${ts}@local.test`;
const PW = 'TestPass12345';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let hdr: Record<string, string>;
let userId = -1;
let sql: ReturnType<typeof postgres>;
let urlMonitorId = -1;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;
  sql = postgres(process.env.DATABASE_URL);

  const u = await authService.register(EMAIL, PW, 'Stalled Projection Test');
  userId = u.id;
  const token = await authService.createSession(u);
  hdr = { Authorization: `Bearer ${token}` };

  const [m] = await sql<[{ id: number }]>`
    INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
    VALUES ('stalled-fix', 'https://example.com', 15000, 60, FALSE)
    RETURNING id`;
  urlMonitorId = m.id;
}, 30_000);

afterAll(async () => {
  if (urlMonitorId > 0) {
    await sql`DELETE FROM url_monitors WHERE id = ${urlMonitorId}`.catch(() => {});
  }
  if (userId > 0) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await sql.end();
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

async function insertExec(opts: {
  ageSeconds: number;
  status?: string;
  regionId?: number | null;
}): Promise<number> {
  const startTime = new Date(Date.now() - opts.ageSeconds * 1000);
  const [row] = await sql<[{ id: number }]>`
    INSERT INTO url_monitor_executions (url_monitor_id, status, region_id, start_time)
    VALUES (${urlMonitorId}, ${opts.status ?? 'PENDING'}, ${opts.regionId ?? null}, ${startTime})
    RETURNING id`;
  return row.id;
}

async function getDetail() {
  const r = await fetch(`${base}/api/monitors/url/${urlMonitorId}`, { headers: hdr });
  return (await r.json()) as {
    monitor: { id: number; latest?: { status: string } | null };
    runs: Array<{ id: number; status: string; errorMessage: string | null }>;
  };
}

describe('stalled-execution projection through the HTTP route', () => {
  test('stale master-path PENDING (region_id NULL) → FAILED in runs and latest', async () => {
    await sql`DELETE FROM url_monitor_executions WHERE url_monitor_id = ${urlMonitorId}`;
    const stuckId = await insertExec({ ageSeconds: 5 * 60, regionId: null });

    const detail = await getDetail();
    const stuck = detail.runs.find((r) => r.id === stuckId);
    expect(stuck).toBeDefined();
    expect(stuck!.status).toBe('FAILED');
    expect(stuck!.errorMessage).toMatch(/stalled/i);

    // The list view's `latest` field has to honour the projection too —
    // that's the actually-visible-in-UI symptom.
    const listRes = await fetch(`${base}/api/monitors`, { headers: hdr });
    const list = (await listRes.json()) as {
      url: Array<{ id: number; latest: { status: string } | null }>;
    };
    const item = list.url.find((m) => m.id === urlMonitorId);
    expect(item?.latest?.status).toBe('FAILED');

    // DB row stays PENDING — projection is read-time only.
    const [dbRow] = await sql<[{ status: string }]>`
      SELECT status FROM url_monitor_executions WHERE id = ${stuckId}`;
    expect(dbRow.status).toBe('PENDING');
  });

  test('fresh master-path PENDING (under 2× interval) → stays PENDING', async () => {
    await sql`DELETE FROM url_monitor_executions WHERE url_monitor_id = ${urlMonitorId}`;
    const freshId = await insertExec({ ageSeconds: 30, regionId: null });

    const detail = await getDetail();
    const fresh = detail.runs.find((r) => r.id === freshId);
    expect(fresh?.status).toBe('PENDING');
  });

  // The regional-PENDING projection is covered by the unit tests in
  // src/services/exec-projection.spec.ts. Repeating it here would mean
  // standing up a `regions` row + its required api_key, which is more
  // setup than the assertion is worth — the pure-function path is the
  // same, only the input differs.
});
