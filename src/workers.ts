/**
 * BullMQ worker + scheduler bootstrap extracted from src/index.ts.
 *
 * Exported so integration tests can import startWorkers() without triggering
 * the src/index.ts entrypoint side-effects (role detection, SIGTERM handler,
 * object-storage init).
 */

import { logger } from './utils/logger.ts';

export async function startWorkers(redisUrl: string): Promise<() => Promise<void>> {
  const { Redis } = await import('ioredis');
  const { Worker } = await import('bullmq');
  const { apiCheckProcessor } = await import('./processors/api-check.processor.ts');
  const { urlMonitorProcessor } = await import('./processors/url-monitor.processor.ts');
  const { createQaProjectProcessor } = await import('./processors/qa-project.processor.ts');
  const { tcpMonitorProcessor } = await import('./processors/tcp-monitor.processor.ts');
  const { udpMonitorProcessor } = await import('./processors/udp-monitor.processor.ts');
  const { dbMonitorProcessor } = await import('./processors/db-monitor.processor.ts');
  const { tlsMonitorProcessor } = await import('./processors/tls-monitor.processor.ts');
  const { startScheduler } = await import('./scheduler.ts');
  const { initEventBus, resetEventBus } = await import('./services/exec-events.ts');

  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  // Bridge the SSE event bus across processes: this worker emits scheduler
  // and processor events; the ui process serves /api/events to browsers.
  initEventBus(connection);

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

  const tcpMonitorWorker = new Worker('tcp-monitor', tcpMonitorProcessor, {
    connection,
    concurrency: parseInt(process.env.TCP_MONITOR_CONCURRENCY || '20'),
  });

  const udpMonitorWorker = new Worker('udp-monitor', udpMonitorProcessor, {
    connection,
    concurrency: parseInt(process.env.UDP_MONITOR_CONCURRENCY || '20'),
  });

  const dbMonitorWorker = new Worker('db-monitor', dbMonitorProcessor, {
    connection,
    concurrency: parseInt(process.env.DB_MONITOR_CONCURRENCY || '20'),
  });

  const tlsMonitorWorker = new Worker('tls-monitor', tlsMonitorProcessor, {
    connection,
    concurrency: parseInt(process.env.TLS_MONITOR_CONCURRENCY || '20'),
  });

  apiCheckWorker.on('completed', (job) => logger.info(`✅ api-check #${job.id} completed`));
  apiCheckWorker.on('failed', (job, err) =>
    logger.error(`❌ api-check #${job?.id} failed: ${err.message}`),
  );

  urlMonitorWorker.on('completed', (job) => logger.info(`✅ url-monitor #${job.id} completed`));
  urlMonitorWorker.on('failed', (job, err) =>
    logger.error(`❌ url-monitor #${job?.id} failed: ${err.message}`),
  );

  qaProjectWorker.on('completed', (job) => logger.info(`✅ qa-project #${job.id} completed`));
  qaProjectWorker.on('failed', (job, err) =>
    logger.error(`❌ qa-project #${job?.id} failed: ${err.message}`),
  );

  tcpMonitorWorker.on('completed', (job) => logger.info(`✅ tcp-monitor #${job.id} completed`));
  tcpMonitorWorker.on('failed', (job, err) =>
    logger.error(`❌ tcp-monitor #${job?.id} failed: ${err.message}`),
  );

  udpMonitorWorker.on('completed', (job) => logger.info(`✅ udp-monitor #${job.id} completed`));
  udpMonitorWorker.on('failed', (job, err) =>
    logger.error(`❌ udp-monitor #${job?.id} failed: ${err.message}`),
  );

  dbMonitorWorker.on('completed', (job) => logger.info(`✅ db-monitor #${job.id} completed`));
  dbMonitorWorker.on('failed', (job, err) =>
    logger.error(`❌ db-monitor #${job?.id} failed: ${err.message}`),
  );
  tlsMonitorWorker.on('completed', (job) => logger.info(`✅ tls-monitor #${job.id} completed`));
  tlsMonitorWorker.on('failed', (job, err) =>
    logger.error(`❌ tls-monitor #${job?.id} failed: ${err.message}`),
  );

  const stopScheduler = await startScheduler(connection);

  return async () => {
    await stopScheduler();
    await Promise.all([
      apiCheckWorker.close(),
      urlMonitorWorker.close(),
      qaProjectWorker.close(),
      tcpMonitorWorker.close(),
      udpMonitorWorker.close(),
      dbMonitorWorker.close(),
      tlsMonitorWorker.close(),
    ]);
    // Unwire the event bus before closing the connection it publishes on.
    // Symmetric with the initEventBus() above; in production the process
    // is exiting anyway, but in tests (which call this stop() in afterAll)
    // it stops a closed connection from dangling as the global publisher
    // and polluting the next file in the shared bun-test process.
    resetEventBus();
    connection.quit();
  };
}
