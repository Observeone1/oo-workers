/**
 * Global setup for integration tests — loaded via --preload in the test:integration script.
 *
 * Starts one Postgres container and one Redis container per test session (shared across
 * all files in the bun test run). Stores connection info in globalThis.__OO_IT_CTX__ so
 * _harness.ts helpers can create per-test databases and Redis namespaces.
 *
 * Teardown is handled automatically by testcontainers' Ryuk reaper when the process exits.
 */

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { runMigrations } from '../../src/db/migrate.ts';

export interface IntegrationCtx {
  pgContainer: StartedTestContainer;
  redisContainer: StartedTestContainer;
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
  // Use log-message wait strategies instead.
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

  const pgHost = pgContainer.getHost();
  const pgPort = pgContainer.getMappedPort(5432);
  const pgAdminUrl = `postgres://oo:oo@${pgHost}:${pgPort}/oo_it`;

  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;

  await runMigrations(pgAdminUrl);

  globalThis.__OO_IT_CTX__ = { pgContainer, redisContainer, pgAdminUrl, redisUrl, redisDbCounter: 0 };
}

// Expose the session DB + Redis URLs in env so test specs can import
// src/config/db.ts at the top level (the singleton reads DATABASE_URL at
// first import — it must be set before the test file's module is loaded).
const { pgAdminUrl: _pgUrl, redisUrl: _redisUrl } = globalThis.__OO_IT_CTX__;
process.env.DATABASE_URL = _pgUrl;
process.env.REDIS_URL = _redisUrl;
