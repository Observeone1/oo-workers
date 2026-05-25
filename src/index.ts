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
  // Opt-in, scoped to the agent→master link only (see AgentConfig).
  const tlsInsecure = ['1', 'true', 'yes'].includes(
    (process.env.OO_AGENT_TLS_INSECURE ?? '').trim().toLowerCase(),
  );

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
    tlsInsecure,
  });
}

async function runMasterRole(): Promise<void> {
  const { startWorkers } = await import('./workers.ts');

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  logger.info('🚀 Starting oo-workers (master)');

  const stop = await startWorkers(redisUrl);

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
    await stop();
    process.exit(0);
  });
}
