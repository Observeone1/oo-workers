/**
 * Per-test helpers for integration tests.
 *
 * Each .it.spec.ts calls createTestDb() / acquireRedisDb() in beforeAll,
 * and the corresponding dropDb() / releaseDb() in afterAll.
 * No TAG prefix discipline needed — DROP DATABASE handles all cleanup.
 *
 * startServer is dynamically imported so src/config/db.ts (singleton) is
 * not loaded until DATABASE_URL has been set in beforeAll.
 */

import { createServer } from 'node:net';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { runMigrations } from '../../src/db/migrate.ts';
import { startWorkers } from '../../src/workers.ts';
import type { IntegrationCtx } from './setup.ts';

export { startWorkers };

function ctx(): IntegrationCtx {
  const c = globalThis.__OO_IT_CTX__;
  if (!c)
    throw new Error(
      'Integration context not initialised — run with --preload ./tests/integration/setup.ts',
    );
  return c;
}

export function freePort(): Promise<number> {
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

export async function createTestDb(): Promise<{
  databaseUrl: string;
  dropDb: () => Promise<void>;
}> {
  const { pgAdminUrl } = ctx();
  const dbName = `oo_it_${Math.random().toString(36).slice(2, 10)}`;

  const adminSql = postgres(pgAdminUrl);
  await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminSql.end();

  const url = new URL(pgAdminUrl);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  await runMigrations(databaseUrl);

  return {
    databaseUrl,
    dropDb: async () => {
      const sql = postgres(pgAdminUrl);
      // WITH (FORCE) terminates existing connections before dropping (PG 13+).
      await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await sql.end();
    },
  };
}

let _redisDbCounter = 0;

export async function acquireRedisDb(): Promise<{
  redisUrl: string;
  releaseDb: () => Promise<void>;
}> {
  const { redisUrl: baseUrl } = ctx();
  const dbIndex = _redisDbCounter++ % 16;
  const redisUrl = `${baseUrl}/${dbIndex}`;

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.flushdb();
  await redis.quit();

  return {
    redisUrl,
    releaseDb: async () => {
      const r = new Redis(redisUrl, { maxRetriesPerRequest: null });
      await r.flushdb();
      await r.quit();
    },
  };
}

export async function startTestServer(redisUrl: string): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const { startServer } = await import('../../src/server.ts');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const port = await freePort();
  const stopFn = startServer(connection, port);
  await new Promise((r) => setTimeout(r, 150));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await stopFn();
      connection.disconnect();
    },
  };
}
