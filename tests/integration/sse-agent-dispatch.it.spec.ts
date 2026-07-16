/**
 * Multi-region writeAgentResult emits `execution` on the SSE bus.
 *
 * v1.26.1 added emitExecution(...) to each of the 6 type branches in
 * services/agent-dispatch.ts:writeAgentResult (url/api/tcp/udp/db/tls;
 * qa-agent's per-test row was intentionally deferred). The code compiles
 * but the multi-region paths were shipped without observation — a typo
 * in the `type` label would silently break live updates for regional
 * probe results.
 *
 * This spec exercises writeAgentResult directly with stubbed payloads
 * — no agent HTTP layer, no scheduler. For each type:
 *
 *   1. Insert a region + a monitor + a PENDING execution row scoped
 *      to that region.
 *   2. Subscribe to the bus for (type, monitorId).
 *   3. Call writeAgentResult(regionId, { type, executionId, ... }).
 *   4. Assert the event fires with type, monitorId, status, regionId.
 *
 * Cleanup is done in afterAll. No worker startup needed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { acquireRedisDb } from './_harness.ts';
import { execEvents } from '../../src/services/exec-events.ts';
import { writeAgentResult } from '../../src/services/agent-dispatch.ts';

const TAG = `sse-ad-${Date.now()}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let sql: ReturnType<typeof postgres>;
let regionId = 0;
const insertedMonitorIds: Record<string, number> = {};

function nextExecutionFor(
  type: string,
  monitorId: number,
  timeoutMs = 5_000,
): Promise<{ type: string; monitorId: number; row: { status: string; regionId?: number | null } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      execEvents.off('execution', handler as never);
      reject(new Error(`no execution event for type=${type} monitor=${monitorId} in ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (p: unknown) => {
      const evt = p as { type: string; monitorId: number; row: { status: string; regionId?: number | null } };
      if (evt.type === type && evt.monitorId === monitorId) {
        clearTimeout(timer);
        execEvents.off('execution', handler as never);
        resolve(evt);
      }
    };
    execEvents.on('execution', handler as never);
  });
}

let apiKeyId = 0;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  sql = postgres(process.env.DATABASE_URL);

  // regions.api_key_id is NOT NULL with FK to api_keys. Seed a throwaway
  // key first so the region insert satisfies the constraint.
  const [key] = await sql<[{ id: number }]>`
    INSERT INTO api_keys (name, key_prefix, key_hash, scopes)
    VALUES (${`${TAG}-key`}, ${`oo_${TAG.slice(0, 8)}`}, 'unused-hash', ARRAY['agent']::text[])
    RETURNING id`;
  apiKeyId = key.id;

  const [region] = await sql<[{ id: number }]>`
    INSERT INTO regions (slug, label, api_key_id)
    VALUES (${TAG}, 'Test Region', ${apiKeyId})
    RETURNING id`;
  regionId = region.id;
}, 30_000);

afterAll(async () => {
  // Clean up monitor + execution rows per type
  for (const [type, id] of Object.entries(insertedMonitorIds)) {
    if (!id) continue;
    const table = `${type}_monitors`;
    const execTable = `${type === 'api' ? 'api_executions' : type === 'url' ? 'url_monitor_executions' : `${type}_executions`}`;
    const fkCol = type === 'api' ? 'api_check_id' : `${type}_monitor_id`;
    if (type === 'api') {
      await sql.unsafe(`DELETE FROM api_executions WHERE api_check_id = ${id}`).catch(() => {});
      await sql.unsafe(`DELETE FROM api_checks WHERE id = ${id}`).catch(() => {});
    } else if (type === 'url') {
      await sql.unsafe(`DELETE FROM url_monitor_executions WHERE url_monitor_id = ${id}`).catch(() => {});
      await sql.unsafe(`DELETE FROM url_monitors WHERE id = ${id}`).catch(() => {});
    } else {
      await sql.unsafe(`DELETE FROM ${execTable} WHERE ${fkCol} = ${id}`).catch(() => {});
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ${id}`).catch(() => {});
    }
  }
  if (regionId) await sql`DELETE FROM regions WHERE id = ${regionId}`.catch(() => {});
  if (apiKeyId) await sql`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
  await sql.end();
  await redisCtx.releaseDb();
}, 30_000);

describe('writeAgentResult emits execution per type', () => {
  test('url branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
      VALUES (${`${TAG}-url`}, 'https://example.com', 10000, 60, TRUE) RETURNING id`;
    insertedMonitorIds.url = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO url_monitor_executions (url_monitor_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('url', m.id);
    const result = await writeAgentResult(regionId, {
      type: 'url',
      executionId: e.id,
      status: 'SUCCESS',
      statusCode: 200,
      latencyMs: 42,
      assertionResults: [],
    });
    expect(result.updated).toBe(true);
    const evt = await wait;
    expect(evt.row.status).toBe('SUCCESS');
    expect(evt.row.regionId).toBe(regionId);
  });

  test('api branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, method, headers, timeout_ms, interval_seconds, enabled)
      VALUES (${`${TAG}-api`}, 'https://example.com', 'GET', '{}'::jsonb, 10000, 60, TRUE) RETURNING id`;
    insertedMonitorIds.api = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO api_executions (api_check_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('api', m.id);
    const result = await writeAgentResult(regionId, {
      type: 'api',
      executionId: e.id,
      status: 'SUCCESS',
      responseStatus: 200,
      responseTimeMs: 55,
      assertionResults: [],
    });
    expect(result.updated).toBe(true);
    const evt = await wait;
    expect(evt.row.regionId).toBe(regionId);
  });

  test('tcp branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO tcp_monitors (name, host, port, timeout_ms, interval_seconds, enabled)
      VALUES (${`${TAG}-tcp`}, 'example.com', 80, 5000, 60, TRUE) RETURNING id`;
    insertedMonitorIds.tcp = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO tcp_executions (tcp_monitor_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('tcp', m.id);
    await writeAgentResult(regionId, {
      type: 'tcp',
      executionId: e.id,
      status: 'SUCCESS',
      latencyMs: 8,
    });
    const evt = await wait;
    expect(evt.row.regionId).toBe(regionId);
  });

  test('udp branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO udp_monitors (name, host, port, expect_response, timeout_ms, interval_seconds, enabled)
      VALUES (${`${TAG}-udp`}, '8.8.8.8', 53, FALSE, 5000, 60, TRUE) RETURNING id`;
    insertedMonitorIds.udp = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO udp_executions (udp_monitor_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('udp', m.id);
    await writeAgentResult(regionId, {
      type: 'udp',
      executionId: e.id,
      status: 'FAILED',
      errorMessage: 'timeout',
    });
    const evt = await wait;
    expect(evt.row.status).toBe('FAILED');
  });

  test('db branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO db_monitors (name, protocol, host, port, tls, timeout_ms, interval_seconds, enabled)
      VALUES (${`${TAG}-db`}, 'postgres', 'localhost', 5432, FALSE, 5000, 60, TRUE) RETURNING id`;
    insertedMonitorIds.db = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO db_executions (db_monitor_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('db', m.id);
    await writeAgentResult(regionId, {
      type: 'db',
      executionId: e.id,
      status: 'SUCCESS',
      latencyMs: 3,
    });
    const evt = await wait;
    expect(evt.row.regionId).toBe(regionId);
  });

  test('tls branch emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO tls_monitors (name, host, port, warn_days, interval_seconds, enabled, verify_chain, verify_hostname)
      VALUES (${`${TAG}-tls`}, 'example.com', 443, 30, 60, TRUE, TRUE, TRUE) RETURNING id`;
    insertedMonitorIds.tls = m.id;
    const [e] = await sql<[{ id: number }]>`
      INSERT INTO tls_executions (tls_monitor_id, status, region_id)
      VALUES (${m.id}, 'PENDING', ${regionId}) RETURNING id`;
    const wait = nextExecutionFor('tls', m.id);
    await writeAgentResult(regionId, {
      type: 'tls',
      executionId: e.id,
      status: 'SUCCESS',
      latencyMs: 100,
      daysRemaining: 90,
      validTo: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    });
    const evt = await wait;
    expect(evt.row.regionId).toBe(regionId);
  });
});
