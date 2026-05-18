/**
 * Worker entrypoint — branches on OO_WORKER_ROLE.
 *
 *   role=master (default) → BullMQ workers + scheduler. Connects to Redis
 *     and Postgres. Same as before multi-region landed.
 *
 *   role=agent → Stateless probe loop. Long-polls a master via HTTP,
 *     runs probes locally, posts results back. No Redis, no Postgres,
 *     no scheduler. Required env: OO_MASTER_URL, OO_AGENT_KEY,
 *     OO_REGION_SLUG. See src/agent.ts and docker-compose.agent.yml.
 */

import { logger } from './utils/logger.ts';

const role = (process.env.OO_WORKER_ROLE || 'master').toLowerCase();

if (role === 'agent') {
  await runAgentRole();
} else if (role === 'master') {
  await runMasterRole();
} else {
  logger.error(`Unknown OO_WORKER_ROLE='${role}'. Expected 'master' or 'agent'.`);
  process.exit(2);
}

async function runAgentRole(): Promise<void> {
  const { runAgent } = await import('./agent.ts');
  const masterUrl = process.env.OO_MASTER_URL;
  const agentKey = process.env.OO_AGENT_KEY;
  const regionSlug = process.env.OO_REGION_SLUG;
  const pollWaitSec = Number(process.env.OO_AGENT_POLL_WAIT_SEC ?? '30');

  if (!masterUrl || !agentKey || !regionSlug) {
    logger.error(
      'agent role requires OO_MASTER_URL, OO_AGENT_KEY, OO_REGION_SLUG; refusing to start.',
    );
    process.exit(2);
  }

  await runAgent({
    masterUrl: masterUrl.replace(/\/+$/, ''),
    agentKey,
    regionSlug,
    pollWaitSec: Number.isFinite(pollWaitSec) && pollWaitSec >= 1 ? pollWaitSec : 30,
  });
}

async function runMasterRole(): Promise<void> {
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

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  logger.info('🚀 Starting oo-workers (master)');

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

  const stopScheduler = startScheduler(connection);

  // Phase 6 — kick off object-storage setup once after BullMQ is wired.
  // Bucket creation + script backfill both no-op when storage is unconfigured.
  // Don't block startup on either; log any error and continue.
  void (async () => {
    try {
      const { ensureBucket, isStorageConfigured } = await import('./services/object-storage.ts');
      if (!isStorageConfigured()) return;
      await ensureBucket();
      const { runBackfill } = await import('./services/storage-backfill.ts');
      await runBackfill();
    } catch (err) {
      logger.error(
        `object-storage init failed (continuing without it): ${err instanceof Error ? err.message : err}`,
      );
    }
  })();

  process.on('SIGTERM', async () => {
    logger.info('Shutting down workers...');
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
    process.exit(0);
  });
}
