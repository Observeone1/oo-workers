/**
 * UI entrypoint — HTTP server only.
 * Talks to the same Postgres + Redis as the worker; doesn't run any
 * BullMQ Worker (it only pushes jobs via Queue from server.ts).
 */

import { Redis } from 'ioredis';
import { logger } from './utils/logger.ts';
import { startServer } from './server.ts';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const port = Number(process.env.PORT ?? 3001);

logger.info('🌐 Starting oo-workers (ui)');

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const stopServer = startServer(connection, port);

process.on('SIGTERM', async () => {
  logger.info('Shutting down UI server...');
  await stopServer();
  await connection.quit();
  process.exit(0);
});
