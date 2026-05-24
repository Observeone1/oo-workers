/**
 * Load + edge-case worker tests.
 * Ported from scripts/load.ts.
 *
 * Exercises:
 *   1. Concurrency burst   — 20 url-monitor jobs in parallel
 *   2. Failure modes        — DNS failure, wrong-status assertion
 *   3. Assertion variety    — status / time / text / header in one api-check
 *   4. JSON-path assertion  — local JSON server (no external dependency)
 *
 * All probe targets are localhost servers stood up by this spec.
 * Browser parallelism (scenario 5 in the original load.ts) requires
 * Playwright and is exercised separately in qa-on-agents.it.spec.ts.
 *
 * Uses the session DB (db.ts singleton) + a dedicated Redis DB index.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { acquireRedisDb, startWorkers } from './_harness.ts';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let stopWorkers: () => Promise<void>;
let ok200Server: Server;
let jsonServer: Server;
let ok200Url = '';
let jsonUrl = '';

function poll<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const v = await fn();
      if (v !== null) return resolve(v);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

beforeAll(async () => {
  ok200Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'hello' }).end('OK response');
  });
  await new Promise<void>((r) => ok200Server.listen(0, '127.0.0.1', r));
  ok200Url = `http://127.0.0.1:${(ok200Server.address() as AddressInfo).port}`;

  jsonServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'ok', value: 42 }));
  });
  await new Promise<void>((r) => jsonServer.listen(0, '127.0.0.1', r));
  jsonUrl = `http://127.0.0.1:${(jsonServer.address() as AddressInfo).port}`;

  redisCtx = await acquireRedisDb();
  process.env.REDIS_URL = redisCtx.redisUrl;
  stopWorkers = await startWorkers(redisCtx.redisUrl);
}, 30_000);

afterAll(async () => {
  await stopWorkers();
  await redisCtx.releaseDb();
  await new Promise<void>((r) => ok200Server.close(() => r()));
  await new Promise<void>((r) => jsonServer.close(() => r()));
}, 30_000);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeQueue(name: string) {
  const conn = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
  const q = new Queue(name, { connection: conn });
  return { q, conn };
}

// ── scenarios ────────────────────────────────────────────────────────────────

describe('load', () => {
  test('1. concurrency burst: 20 url-monitor jobs all succeed', async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const N = 20;

    // enabled=FALSE prevents the scheduler from auto-enqueueing extra executions
    // which would make the exact-count assertion non-deterministic.
    const [monitor] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, enabled)
      VALUES ('load-burst', ${ok200Url}, 10000, FALSE)
      RETURNING id
    `;

    const execIds: number[] = [];
    for (let i = 0; i < N; i++) {
      const [e] = await sql<[{ id: number }]>`
        INSERT INTO url_monitor_executions (url_monitor_id, status)
        VALUES (${monitor.id}, 'PENDING')
        RETURNING id
      `;
      execIds.push(e.id);
    }

    const { q, conn } = makeQueue('url-monitor');
    await Promise.all(
      execIds.map((executionId) =>
        q.add('check', {
          executionId,
          monitor: { id: monitor.id, url: ok200Url, timeoutMs: 10000 },
          assertions: [],
        }),
      ),
    );
    await q.close();
    await conn.quit();

    const done = await poll(async () => {
      const [row] = await sql<[{ done: string }]>`
        SELECT COUNT(*) FILTER (WHERE status != 'PENDING') AS done
        FROM url_monitor_executions WHERE url_monitor_id = ${monitor.id}
      `;
      return Number(row.done) === N ? true : null;
    }, 60_000);

    const rows = await sql`
      SELECT status FROM url_monitor_executions WHERE url_monitor_id = ${monitor.id}
    `;
    await sql.end();

    expect(done).toBe(true);
    const successes = rows.filter((r) => r.status === 'SUCCESS').length;
    expect(successes).toBe(N);
  }, 70_000);

  test('2a. failure mode: DNS error → FAILED execution', async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const [monitor] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, enabled)
      VALUES ('load-dns-fail', 'https://this-host-does-not-exist-xyz.invalid', 5000, FALSE)
      RETURNING id
    `;
    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO url_monitor_executions (url_monitor_id, status)
      VALUES (${monitor.id}, 'PENDING') RETURNING id
    `;

    const { q, conn } = makeQueue('url-monitor');
    await q.add('check', {
      executionId: exec.id,
      monitor: { id: monitor.id, url: 'https://this-host-does-not-exist-xyz.invalid', timeoutMs: 5000 },
      assertions: [],
    });
    await q.close();
    await conn.quit();

    const result = await poll(async () => {
      const [row] = await sql`SELECT status FROM url_monitor_executions WHERE id = ${exec.id}`;
      return row.status !== 'PENDING' ? row.status : null;
    }, 20_000);
    await sql.end();

    expect(result).toBe('FAILED');
  }, 30_000);

  test('2b. failure mode: wrong-status assertion → FAILED execution', async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const [monitor] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, enabled)
      VALUES ('load-wrong-assert', ${ok200Url}, 5000, FALSE)
      RETURNING id
    `;
    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO url_monitor_executions (url_monitor_id, status)
      VALUES (${monitor.id}, 'PENDING') RETURNING id
    `;

    const { q, conn } = makeQueue('url-monitor');
    await q.add('check', {
      executionId: exec.id,
      monitor: { id: monitor.id, url: ok200Url, timeoutMs: 5000 },
      assertions: [{ operator: 'equals', statusCode: 404 }],
    });
    await q.close();
    await conn.quit();

    const result = await poll(async () => {
      const [row] = await sql`SELECT status FROM url_monitor_executions WHERE id = ${exec.id}`;
      return row.status !== 'PENDING' ? row.status : null;
    }, 20_000);
    await sql.end();

    expect(result).toBe('FAILED');
  }, 30_000);

  test('3. assertion variety: status + time + text + header all pass', async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const [check] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, method, headers, timeout_ms, enabled)
      VALUES ('load-multi-assert', ${ok200Url}, 'GET', '{}'::jsonb, 10000, FALSE)
      RETURNING id
    `;
    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO api_executions (api_check_id, status)
      VALUES (${check.id}, 'PENDING') RETURNING id
    `;

    const assertions = [
      { type: 'status_code',   operator: 'equals',      path: null,        value: '200'        },
      { type: 'response_time', operator: 'less_than',   path: null,        value: '10000'      },
      { type: 'text_contains', operator: 'contains',    path: null,        value: 'OK response' },
      { type: 'text_contains', operator: 'not_contains', path: null,       value: 'definitely-not-here' },
      { type: 'header',        operator: 'contains',    path: 'x-custom',  value: 'hello'      },
    ];

    const { q, conn } = makeQueue('api-check');
    await q.add('check', {
      executionId: exec.id,
      apiCheck: { id: check.id, url: ok200Url, method: 'GET', headers: {}, timeoutMs: 10000 },
      assertions,
    });
    await q.close();
    await conn.quit();

    const result = await poll(async () => {
      const [row] = await sql`SELECT status, assertion_results FROM api_executions WHERE id = ${exec.id}`;
      return row.status !== 'PENDING' ? row : null;
    }, 20_000);
    await sql.end();

    expect(result?.status).toBe('SUCCESS');
    const passed = (result?.assertion_results ?? []).filter((a: { passed: boolean }) => a.passed).length;
    expect(passed).toBe(assertions.length);
  }, 30_000);

  test('4. json-path assertion: exists check against local JSON endpoint', async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const [check] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, method, headers, timeout_ms, enabled)
      VALUES ('load-json-path', ${jsonUrl}, 'GET', '{"Accept":"application/json"}'::jsonb, 10000, FALSE)
      RETURNING id
    `;
    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO api_executions (api_check_id, status)
      VALUES (${check.id}, 'PENDING') RETURNING id
    `;

    const assertions = [
      { type: 'status_code', operator: 'equals', path: null,     value: '200' },
      { type: 'json_path',   operator: 'exists', path: '$.status', value: null },
      { type: 'json_path',   operator: 'exists', path: '$.value',  value: null },
    ];

    const { q, conn } = makeQueue('api-check');
    await q.add('check', {
      executionId: exec.id,
      apiCheck: { id: check.id, url: jsonUrl, method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 10000 },
      assertions,
    });
    await q.close();
    await conn.quit();

    const result = await poll(async () => {
      const [row] = await sql`SELECT status, assertion_results FROM api_executions WHERE id = ${exec.id}`;
      return row.status !== 'PENDING' ? row : null;
    }, 20_000);
    await sql.end();

    expect(result?.status).toBe('SUCCESS');
    const passed = (result?.assertion_results ?? []).filter((a: { passed: boolean }) => a.passed).length;
    expect(passed).toBe(assertions.length);
  }, 30_000);
});
