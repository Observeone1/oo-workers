/**
 * Scheduler integration test.
 * Ported from scripts/scheduler-test.ts.
 *
 * Verifies the scheduler tick loop (started by startWorkers) automatically
 * enqueues url-monitor and api-check jobs without any manual Queue.add().
 *
 * Uses a local always-200 HTTP server as the probe target — no external
 * network dependency, deterministic SUCCESS assertions.
 *
 * Cleanup order: stopWorkers() FIRST so the scheduler cannot re-enqueue
 * between the DB deletes; then delete executions + assertions + monitors.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { startWorkers } from './_harness.ts';

const INTERVAL = 10; // seconds — tight so the test completes in ~35s
const WAIT_TICKS = 2; // expect at least this many executions
const WAIT_MS = (INTERVAL * WAIT_TICKS + 15) * 1000; // 35 000 ms

let stopWorkers: (() => Promise<void>) | null = null;
let httpServer: Server;
let targetUrl = '';
let createdUrlId: number | null = null;
let createdApiId: number | null = null;

async function cleanup(sql: ReturnType<typeof postgres>) {
  if (createdUrlId != null) {
    await sql`DELETE FROM url_monitor_executions  WHERE url_monitor_id = ${createdUrlId}`.catch(() => {});
    await sql`DELETE FROM url_monitor_assertions  WHERE url_monitor_id = ${createdUrlId}`.catch(() => {});
    await sql`DELETE FROM url_monitors            WHERE id = ${createdUrlId}`.catch(() => {});
    createdUrlId = null;
  }
  if (createdApiId != null) {
    await sql`DELETE FROM api_executions WHERE api_check_id = ${createdApiId}`.catch(() => {});
    await sql`DELETE FROM api_assertions WHERE api_check_id = ${createdApiId}`.catch(() => {});
    await sql`DELETE FROM api_checks     WHERE id = ${createdApiId}`.catch(() => {});
    createdApiId = null;
  }
}

beforeAll(async () => {
  httpServer = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address() as AddressInfo;
  targetUrl = `http://127.0.0.1:${addr.port}`;

  stopWorkers = await startWorkers(process.env.REDIS_URL!);
}, 30_000);

afterAll(async () => {
  // Stop workers FIRST — prevents scheduler from re-enqueuing during DB deletes.
  if (stopWorkers) await stopWorkers();

  const sql = postgres(process.env.DATABASE_URL!);
  await cleanup(sql);
  await sql.end();

  await new Promise<void>((r) => httpServer.close(() => r()));
}, 30_000);

describe('scheduler', () => {
  test(
    `fires url-monitor and api-check within ${WAIT_MS / 1000}s (interval=${INTERVAL}s)`,
    async () => {
      const sql = postgres(process.env.DATABASE_URL!);

      const [urlMon] = await sql`
        INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
        VALUES ('sched-it-url', ${targetUrl}, 10000, ${INTERVAL}, TRUE)
        RETURNING id
      `;
      createdUrlId = urlMon.id;
      await sql`
        INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code)
        VALUES (${urlMon.id}, 'equals', 200)
      `;

      const [apiChk] = await sql`
        INSERT INTO api_checks (name, url, method, headers, timeout_ms, interval_seconds, enabled)
        VALUES ('sched-it-api', ${targetUrl}, 'GET', '{}'::jsonb, 10000, ${INTERVAL}, TRUE)
        RETURNING id
      `;
      createdApiId = apiChk.id;
      await sql`
        INSERT INTO api_assertions (api_check_id, type, operator, value)
        VALUES (${apiChk.id}, 'status_code', 'equals', '200')
      `;

      await sql.end();

      const sql2 = postgres(process.env.DATABASE_URL!);
      const deadline = Date.now() + WAIT_MS;
      let urlRow: { n: string; ok: string } = { n: '0', ok: '0' };
      let apiRow: { n: string; ok: string } = { n: '0', ok: '0' };
      while (Date.now() < deadline) {
        [urlRow] = await sql2`
          SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'SUCCESS') AS ok
          FROM url_monitor_executions WHERE url_monitor_id = ${createdUrlId!}
        `;
        [apiRow] = await sql2`
          SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'SUCCESS') AS ok
          FROM api_executions WHERE api_check_id = ${createdApiId!}
        `;
        if (Number(urlRow.n) >= WAIT_TICKS && Number(apiRow.n) >= WAIT_TICKS) break;
        await Bun.sleep(2_000);
      }
      await sql2.end();

      const urlN = Number(urlRow.n);
      const urlOk = Number(urlRow.ok);
      const apiN = Number(apiRow.n);
      const apiOk = Number(apiRow.ok);

      expect(urlN, `url executions ≥ ${WAIT_TICKS - 1}`).toBeGreaterThanOrEqual(WAIT_TICKS - 1);
      expect(urlOk, 'all url executions SUCCESS').toBe(urlN);
      expect(apiN, `api executions ≥ ${WAIT_TICKS - 1}`).toBeGreaterThanOrEqual(WAIT_TICKS - 1);
      expect(apiOk, 'all api executions SUCCESS').toBe(apiN);
    },
    WAIT_MS + 10_000,
  );
});
