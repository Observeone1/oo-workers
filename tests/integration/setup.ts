/**
 * Global setup for integration tests — loaded via --preload in the test:integration script.
 *
 * Starts one Postgres container, one Redis container, and one RustFS (S3-compatible)
 * container per test session (shared across all files in the bun test run). Stores
 * connection info in globalThis.__OO_IT_CTX__ so _harness.ts helpers can create
 * per-test databases and Redis namespaces.
 *
 * Teardown is handled automatically by testcontainers' Ryuk reaper when the process exits.
 */

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { runMigrations } from '../../src/db/migrate.ts';

const RUSTFS_ACCESS_KEY = 'oo-workers-access';
const RUSTFS_SECRET_KEY = 'oo-workers-secret-change-me';
const RUSTFS_BUCKET = 'oo-workers-test';

export interface IntegrationCtx {
  pgContainer: StartedTestContainer;
  redisContainer: StartedTestContainer;
  rustfsContainer: StartedTestContainer;
  pgAdminUrl: string;
  redisUrl: string;
  redisDbCounter: number;
}

declare global {
  var __OO_IT_CTX__: IntegrationCtx | undefined;
}

if (!globalThis.__OO_IT_CTX__) {
  // Start containers sequentially — testcontainers uses a process-wide flock
  // and concurrent start() calls within the same process deadlock on it.
  // Docker Desktop on WSL2: the default Wait.forListeningPort() probe hangs
  // because it uses a TCP socket check that doesn't resolve on this setup.
  // Use log-message or HTTP wait strategies instead.
  const pgContainer = await new GenericContainer('postgres:18-alpine')
    .withEnvironment({
      POSTGRES_USER: 'oo',
      POSTGRES_PASSWORD: 'oo',
      POSTGRES_DB: 'oo_it',
    })
    .withExposedPorts(5432)
    // Wait for 2 occurrences: postgres logs "ready" once during initdb temp
    // instance, then again when the real server is up and accepting queries.
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();

  const redisContainer = await new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  // RustFS is the S3-compatible object storage used in docker-compose.
  // Pin the exact tag (floating :latest caused prod outage 2026-05-21).
  // S3 returns 403 on unauthenticated GET / — use forStatusCodeMatching
  // to accept any non-5xx so we don't wait forever on a 403.
  const rustfsContainer = await new GenericContainer('rustfs/rustfs:1.0.0-beta.4')
    .withEnvironment({
      RUSTFS_VOLUMES: '/data',
      RUSTFS_ADDRESS: '0.0.0.0:9000',
      RUSTFS_ACCESS_KEY,
      RUSTFS_SECRET_KEY,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/', 9000).forStatusCodeMatching((code) => code < 500))
    .start();

  const pgHost = pgContainer.getHost();
  const pgPort = pgContainer.getMappedPort(5432);
  const pgAdminUrl = `postgres://oo:oo@${pgHost}:${pgPort}/oo_it`;

  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;

  const rustfsHost = rustfsContainer.getHost();
  const rustfsPort = rustfsContainer.getMappedPort(9000);

  await runMigrations(pgAdminUrl);

  globalThis.__OO_IT_CTX__ = { pgContainer, redisContainer, rustfsContainer, pgAdminUrl, redisUrl, redisDbCounter: 0 };

  // Set storage env vars BEFORE any test file imports object-storage.ts.
  // object-storage.ts readConfig() memoizes a disabled state on first call —
  // the env must be in place before module load, not just before the first test.
  process.env.OO_OBJECT_STORAGE_ENDPOINT = `http://${rustfsHost}:${rustfsPort}`;
  process.env.OO_OBJECT_STORAGE_REGION = 'us-east-1';
  process.env.OO_OBJECT_STORAGE_BUCKET = RUSTFS_BUCKET;
  process.env.OO_OBJECT_STORAGE_ACCESS_KEY = RUSTFS_ACCESS_KEY;
  process.env.OO_OBJECT_STORAGE_SECRET_KEY = RUSTFS_SECRET_KEY;
  process.env.OO_OBJECT_STORAGE_FORCE_PATH_STYLE = '1';

  // Dynamic import AFTER env is set so readConfig() memoizes the live values.
  const { ensureBucket } = await import('../../src/services/object-storage.ts');
  await ensureBucket();
}

// Expose the session DB + Redis URLs in env so test specs can import
// src/config/db.ts at the top level (the singleton reads DATABASE_URL at
// first import — it must be set before the test file's module is loaded).
const { pgAdminUrl: _pgUrl, redisUrl: _redisUrl } = globalThis.__OO_IT_CTX__;
process.env.DATABASE_URL = _pgUrl;
process.env.REDIS_URL = _redisUrl;
