/**
 * Worker entrypoint — BullMQ workers + scheduler. No HTTP server.
 * The UI lives in a separate service (src/ui-server.ts).
 */

import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import { logger } from './utils/logger.ts';
import { apiCheckProcessor } from './processors/api-check.processor.ts';
import { urlMonitorProcessor } from './processors/url-monitor.processor.ts';
import { createQaProjectProcessor } from './processors/qa-project.processor.ts';
import { startScheduler } from './scheduler.ts';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

logger.info('🚀 Starting oo-workers (worker)');

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const apiCheckWorker = new Worker('api-check', apiCheckProcessor, {
  connection,
  concurrency: parseInt(process.env.API_CHECK_CONCURRENCY || '10'),
});

const urlMonitorWorker = new Worker('url-monitor', urlMonitorProcessor, {
  connection,
  concurrency: parseInt(process.env.URL_MONITOR_CONCURRENCY || '20'),
});

const qaProjectWorker = new Worker('qa-project', createQaProjectProcessor(connection), {
  connection,
  concurrency: parseInt(process.env.QA_PROJECT_CONCURRENCY || '5'),
});

apiCheckWorker.on('completed', (job) => logger.info(`✅ api-check #${job.id} completed`));
apiCheckWorker.on('failed', (job, err) => logger.error(`❌ api-check #${job?.id} failed: ${err.message}`));

urlMonitorWorker.on('completed', (job) => logger.info(`✅ url-monitor #${job.id} completed`));
urlMonitorWorker.on('failed', (job, err) => logger.error(`❌ url-monitor #${job?.id} failed: ${err.message}`));

qaProjectWorker.on('completed', (job) => logger.info(`✅ qa-project #${job.id} completed`));
qaProjectWorker.on('failed', (job, err) => logger.error(`❌ qa-project #${job?.id} failed: ${err.message}`));

const stopScheduler = startScheduler(connection);

process.on('SIGTERM', async () => {
  logger.info('Shutting down workers...');
  await stopScheduler();
  await Promise.all([
    apiCheckWorker.close(),
    urlMonitorWorker.close(),
    qaProjectWorker.close(),
  ]);
  process.exit(0);
});
