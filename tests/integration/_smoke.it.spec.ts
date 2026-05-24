/**
 * Phase 0 harness smoke test.
 *
 * Two concerns:
 *  1. Container connectivity — Postgres reachable, schema applied, Redis PONG.
 *  2. Worker round-trip — startWorkers() processes a url-monitor job end-to-end.
 *     This is the anti-regression proof that extracting startWorkers() from
 *     src/index.ts didn't break production worker behaviour.
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

describe('url-monitor worker round-trip', () => {
  let dbCtx: Awaited<ReturnType<typeof createTestDb>>;
  let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
  let stopWorkers: () => Promise<void>;

  beforeAll(async () => {
    dbCtx = await createTestDb();
    redisCtx = await acquireRedisDb();

    // Set DATABASE_URL before startWorkers() so processors load src/config/db.ts
    // with the correct test database URL on their first import.
    process.env.DATABASE_URL = dbCtx.databaseUrl;
    process.env.REDIS_URL = redisCtx.redisUrl;

    stopWorkers = await startWorkers(redisCtx.redisUrl);
  });

  afterAll(async () => {
    await stopWorkers();
    await redisCtx.releaseDb();
    await dbCtx.dropDb();
  }, 30_000);

  test('url-monitor job completes and execution row leaves PENDING', async () => {
    const sql = postgres(dbCtx.databaseUrl);

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
});
