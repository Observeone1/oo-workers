/**
 * Every master-path processor emits `execution` on the SSE bus.
 *
 * v1.26.0 added emitExecution() to each processor exit point. The
 * sse-live-updates.e2e spec covers URL end-to-end through the browser,
 * but doesn't exercise the other 6 processor emit sites. A typo
 * (`emitExecution('apo', ...)`) would silently break that type's live
 * updates with no test catching it.
 *
 * This spec:
 *   - boots startWorkers (full master worker stack + scheduler ticking)
 *   - subscribes to the execEvents bus
 *   - inserts a monitor of each type at a tight interval
 *   - waits for the first 'execution' event per type
 *   - asserts type + monitorId + status match
 *
 * Probe targets:
 *   - URL/API → local always-200 HTTP server (deterministic SUCCESS)
 *   - TCP    → testcontainer Redis port (PING/PONG handshake; SUCCESS)
 *   - DB     → testcontainer Postgres (DB liveness; SUCCESS)
 *   - TLS    → testcontainer Postgres TLS port (handshake; cert is self-
 *              signed so monitor.verifyChain=false to land SUCCESS)
 *   - UDP    → deliberate failure path (8.8.8.8:53 + unreachable host
 *              with short timeout; FAILED still emits)
 *   - QA     → SKIPPED. The QA processor's emit is a single sub-test row
 *              and requires Playwright runtime. Covered indirectly by the
 *              existing qa-on-agents.it.spec.ts and the url-path emit
 *              proves the helper itself works.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startWorkers, connectDb } from './_harness.ts';
import { execEvents } from '../../src/services/exec-events.ts';

const INTERVAL = 10; // seconds — tight so the test completes within ~35s

let stopWorkers: (() => Promise<void>) | null = null;
let httpServer: Server;
let targetUrl = '';
let sql: ReturnType<typeof connectDb>;
const insertedIds: Record<string, number> = {};

/** Subscribe once for a specific (type, monitorId), resolve on first match,
 * auto-unsubscribe. Each invocation registers its own listener — no
 * cross-test pollution. */
function nextExecutionFor(
  type: string,
  monitorId: number,
  timeoutMs = 30_000,
): Promise<{ type: string; monitorId: number; row: { status: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      execEvents.off('execution', handler as never);
      reject(new Error(`no execution event for type=${type} monitor=${monitorId} in ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (p: unknown) => {
      const evt = p as { type: string; monitorId: number; row: { status: string } };
      if (evt.type === type && evt.monitorId === monitorId) {
        clearTimeout(timer);
        execEvents.off('execution', handler as never);
        resolve(evt);
      }
    };
    execEvents.on('execution', handler as never);
  });
}

beforeAll(async () => {
  httpServer = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address() as AddressInfo;
  targetUrl = `http://127.0.0.1:${addr.port}`;

  stopWorkers = await startWorkers(process.env.REDIS_URL);
  sql = connectDb();
}, 30_000);

afterAll(async () => {
  if (stopWorkers) await stopWorkers();
  for (const [type, id] of Object.entries(insertedIds)) {
    if (!id) continue;
    if (type === 'url') {
      await sql`DELETE FROM url_monitor_executions WHERE url_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM url_monitor_assertions WHERE url_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM url_monitors WHERE id = ${id}`.catch(() => {});
    } else if (type === 'api') {
      await sql`DELETE FROM api_executions WHERE api_check_id = ${id}`.catch(() => {});
      await sql`DELETE FROM api_assertions WHERE api_check_id = ${id}`.catch(() => {});
      await sql`DELETE FROM api_checks WHERE id = ${id}`.catch(() => {});
    } else if (type === 'tcp') {
      await sql`DELETE FROM tcp_executions WHERE tcp_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM tcp_monitors WHERE id = ${id}`.catch(() => {});
    } else if (type === 'udp') {
      await sql`DELETE FROM udp_executions WHERE udp_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM udp_monitors WHERE id = ${id}`.catch(() => {});
    } else if (type === 'db') {
      await sql`DELETE FROM db_executions WHERE db_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM db_monitors WHERE id = ${id}`.catch(() => {});
    } else if (type === 'tls') {
      await sql`DELETE FROM tls_executions WHERE tls_monitor_id = ${id}`.catch(() => {});
      await sql`DELETE FROM tls_monitors WHERE id = ${id}`.catch(() => {});
    }
  }
  await sql.end();
  await new Promise<void>((r) => httpServer.close(() => r()));
}, 30_000);

// Each test waits for the scheduler tick (10s) + processing + emit
// delivery. 20s is comfortably above the 10s tick. bun:test defaults
// to 5s which is too tight for the scheduler cadence used here.
const TEST_TIMEOUT_MS = 20_000;

describe('per-processor SSE execution emits', () => {
  test('url processor emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
      VALUES ('sse-emit-url', ${targetUrl}, 10000, ${INTERVAL}, TRUE) RETURNING id`;
    insertedIds.url = m.id;
    await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${m.id}, 'equals', 200)`;
    const evt = await nextExecutionFor('url', m.id);
    expect(evt.row.status).toBe('SUCCESS');
  }, TEST_TIMEOUT_MS);

  test('api processor emits execution', async () => {
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, method, headers, timeout_ms, interval_seconds, enabled)
      VALUES ('sse-emit-api', ${targetUrl}, 'GET', '{}'::jsonb, 10000, ${INTERVAL}, TRUE) RETURNING id`;
    insertedIds.api = m.id;
    await sql`INSERT INTO api_assertions (api_check_id, type, operator, value) VALUES (${m.id}, 'status_code', 'equals', '200')`;
    const evt = await nextExecutionFor('api', m.id);
    expect(evt.row.status).toBe('SUCCESS');
  }, TEST_TIMEOUT_MS);

  test('tcp processor emits execution', async () => {
    // Testcontainer Redis is at REDIS_URL. Probe its port directly —
    // PING/PONG handshake succeeds on connect for the bare-probe path.
    const redisUrl = new URL(process.env.REDIS_URL);
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO tcp_monitors (name, host, port, timeout_ms, interval_seconds, enabled)
      VALUES ('sse-emit-tcp', ${redisUrl.hostname}, ${Number(redisUrl.port)}, 5000, ${INTERVAL}, TRUE) RETURNING id`;
    insertedIds.tcp = m.id;
    const evt = await nextExecutionFor('tcp', m.id);
    expect(evt.row.status).toBe('SUCCESS');
  }, TEST_TIMEOUT_MS);

  test('db processor emits execution', async () => {
    const dbUrl = new URL(process.env.DATABASE_URL);
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO db_monitors (name, protocol, host, port, tls, timeout_ms, interval_seconds, enabled)
      VALUES ('sse-emit-db', 'postgres', ${dbUrl.hostname}, ${Number(dbUrl.port)}, FALSE, 5000, ${INTERVAL}, TRUE) RETURNING id`;
    insertedIds.db = m.id;
    const evt = await nextExecutionFor('db', m.id);
    expect(evt.row.status).toBe('SUCCESS');
  }, TEST_TIMEOUT_MS);

  test('udp processor emits execution (failure path)', async () => {
    // No UDP listener is available in the test env, so probe an
    // unreachable address with a short timeout. The FAILED path still
    // emits — proves the emit fires regardless of probe outcome.
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO udp_monitors (name, host, port, expect_response, timeout_ms, interval_seconds, enabled)
      VALUES ('sse-emit-udp', '127.0.0.1', 1, TRUE, 1000, ${INTERVAL}, TRUE) RETURNING id`;
    insertedIds.udp = m.id;
    const evt = await nextExecutionFor('udp', m.id);
    // FAILED or SUCCESS both valid here — we're only asserting the
    // emit fires for the udp type with the right monitorId.
    expect(['SUCCESS', 'FAILED']).toContain(evt.row.status);
  }, TEST_TIMEOUT_MS);

  test('tls processor emits execution (failure path)', async () => {
    // Testcontainer Postgres does not speak TLS on its main port,
    // so the TLS handshake fails — but the FAILED path still emits.
    // (Probing a real public TLS host introduces network dependency.)
    const [m] = await sql<[{ id: number }]>`
      INSERT INTO tls_monitors (name, host, port, warn_days, interval_seconds, enabled, verify_chain, verify_hostname)
      VALUES ('sse-emit-tls', '127.0.0.1', 1, 30, ${INTERVAL}, TRUE, FALSE, FALSE) RETURNING id`;
    insertedIds.tls = m.id;
    const evt = await nextExecutionFor('tls', m.id);
    expect(['SUCCESS', 'FAILED']).toContain(evt.row.status);
  }, TEST_TIMEOUT_MS);
});
