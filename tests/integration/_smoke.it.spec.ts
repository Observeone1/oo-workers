/**
 * Phase 0 harness smoke test.
 *
 * Three concerns:
 *  1. Container connectivity — Postgres reachable, schema applied, Redis PONG.
 *  2. url-monitor worker round-trip — job processes end-to-end.
 *  3. api-check worker round-trip — confirms a second queue type works.
 *
 * Tests 2 and 3 share one startWorkers() call (same beforeAll).
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { createTestDb, acquireRedisDb, startWorkers } from './_harness.ts';

// ── 1. Connectivity ──────────────────────────────────────────────────────────

describe('container connectivity', () => {
  let dbCtx: Awaited<ReturnType<typeof createTestDb>>;
  let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;

  beforeAll(async () => {
    dbCtx = await createTestDb();
    redisCtx = await acquireRedisDb();
  });

  afterAll(async () => {
    await redisCtx.releaseDb();
    await dbCtx.dropDb();
  });

  test('postgres responds to SELECT 1', async () => {
    const sql = postgres(dbCtx.databaseUrl);
    const [{ n }] = await sql<[{ n: number }]>`SELECT 1 AS n`;
    await sql.end();
    expect(n).toBe(1);
  });

  test('schema migrations applied (schema_migrations table has rows)', async () => {
    const sql = postgres(dbCtx.databaseUrl);
    const [{ c }] = await sql<[{ c: string }]>`SELECT count(*) AS c FROM schema_migrations`;
    await sql.end();
    expect(Number(c)).toBeGreaterThan(0);
  });

  test('redis responds to PING', async () => {
    const redis = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
    const pong = await redis.ping();
    await redis.quit();
    expect(pong).toBe('PONG');
  });
});

// ── 2. Worker round-trip ─────────────────────────────────────────────────────

describe('worker round-trips', () => {
  // Use the session DB (set by setup.ts in DATABASE_URL). When running in a
  // full suite, src/config/db.ts is already a singleton pointing at the session
  // DB. Using a per-test DB would diverge: workers write to the singleton DB
  // while the poll loop reads from a different URL, so the job never appears done.
  let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
  let stopWorkers: () => Promise<void>;

  beforeAll(async () => {
    redisCtx = await acquireRedisDb();
    process.env.REDIS_URL = redisCtx.redisUrl;
    stopWorkers = await startWorkers(redisCtx.redisUrl);
  });

  afterAll(async () => {
    await stopWorkers();
    await redisCtx.releaseDb();
  }, 30_000);

  test('url-monitor job completes and execution row leaves PENDING', async () => {
    const sql = postgres(process.env.DATABASE_URL!);

    const [monitor] = await sql<[{ id: number; url: string; timeout_ms: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms)
      VALUES ('smoke-worker', 'https://example.com', 15000)
      RETURNING id, url, timeout_ms
    `;

    const [assertion] = await sql<[{ id: number }]>`
      INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code)
      VALUES (${monitor.id}, 'equals', 200)
      RETURNING id
    `;

    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO url_monitor_executions (url_monitor_id, status)
      VALUES (${monitor.id}, 'PENDING')
      RETURNING id
    `;

    const connection = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('url-monitor', { connection });
    await queue.add('check', {
      executionId: exec.id,
      monitor: { id: monitor.id, url: monitor.url, timeoutMs: monitor.timeout_ms },
      assertions: [{ id: assertion.id, operator: 'equals', statusCode: 200 }],
    });
    await queue.close();
    await connection.quit();

    // Poll until the execution leaves PENDING (success or failure both prove the worker ran).
    const start = Date.now();
    let finalStatus: string | null = null;
    while (Date.now() - start < 30_000) {
      const [row] = await sql<[{ status: string }]>`
        SELECT status FROM url_monitor_executions WHERE id = ${exec.id}
      `;
      if (row.status !== 'PENDING') {
        finalStatus = row.status;
        break;
      }
      await Bun.sleep(500);
    }

    await sql.end();

    expect(finalStatus).toBe('SUCCESS');
  }, 35_000);

  test('api-check job completes and execution row leaves PENDING', async () => {
    const sql = postgres(process.env.DATABASE_URL!);

    const [check] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, method, headers, timeout_ms)
      VALUES ('smoke-api', 'https://example.com', 'GET', '{}'::jsonb, 15000)
      RETURNING id
    `;

    const [exec] = await sql<[{ id: number }]>`
      INSERT INTO api_executions (api_check_id, status)
      VALUES (${check.id}, 'PENDING')
      RETURNING id
    `;

    const connection = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('api-check', { connection });
    await queue.add('check', {
      executionId: exec.id,
      apiCheck: { id: check.id, url: 'https://example.com', method: 'GET', headers: {}, timeoutMs: 15000 },
      assertions: [{ type: 'status_code', operator: 'equals', path: null, value: '200' }],
    });
    await queue.close();
    await connection.quit();

    const start = Date.now();
    let finalStatus: string | null = null;
    while (Date.now() - start < 30_000) {
      const [row] = await sql<[{ status: string }]>`
        SELECT status FROM api_executions WHERE id = ${exec.id}
      `;
      if (row.status !== 'PENDING') {
        finalStatus = row.status;
        break;
      }
      await Bun.sleep(500);
    }

    await sql.end();

    expect(finalStatus).toBe('SUCCESS');
  }, 35_000);
});
