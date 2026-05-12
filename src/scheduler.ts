/**
 * Scheduler — picks monitors whose interval has elapsed and enqueues jobs.
 *
 * Runs in the same process as the BullMQ workers. Ticks every TICK_MS, checks
 * each enabled monitor's last execution timestamp against its intervalSeconds,
 * and pushes a new execution row + BullMQ job for the due ones.
 *
 * Deduplication: BullMQ jobId includes a minute-bucket timestamp so a slow
 * tick (or two schedulers in HA) can't double-enqueue the same monitor for
 * the same window.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { urlMonitorRepo } from './db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from './db/repositories/api-check.repo.ts';
import { qaProjectRepo } from './db/repositories/qa-project.repo.ts';
import { logger } from './utils/logger.ts';

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 5_000);

export function startScheduler(connection: Redis) {
  const urlQ = new Queue('url-monitor', { connection });
  const apiQ = new Queue('api-check', { connection });
  const qaQ = new Queue('qa-project', { connection });

  logger.info(`🕒 scheduler starting (tick every ${TICK_MS / 1000}s)`);

  const tick = async () => {
    try {
      await Promise.all([
        tickUrlMonitors(urlQ),
        tickApiChecks(apiQ),
        tickQaProjects(qaQ),
      ]);
    } catch (err) {
      logger.error(`scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tick();
  const handle = setInterval(tick, TICK_MS);

  return async () => {
    clearInterval(handle);
    await Promise.all([urlQ.close(), apiQ.close(), qaQ.close()]);
  };
}

// ---------------- url-monitor ----------------
async function tickUrlMonitors(queue: Queue) {
  const due = await urlMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const assertions = await urlMonitorRepo.findAssertionsByMonitorId(m.id);
    const [exec] = await urlMonitorRepo.createExecution(m.id, 'PENDING');

    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));
    await queue.add(
      'check',
      {
        executionId: exec.id,
        monitor: { id: m.id, url: m.url, timeout_ms: m.timeoutMs },
        assertions,
      },
      { jobId: `url:${m.id}:${bucket}`, removeOnComplete: 200, removeOnFail: 200 },
    );
    logger.info(`scheduled url-monitor #${m.id} → exec #${exec.id}`);
  }
}

// ---------------- api-check ----------------
async function tickApiChecks(queue: Queue) {
  const due = await apiCheckRepo.findDue();

  for (const c of due) {
    if (c.ageSeconds !== null && c.ageSeconds < c.intervalSeconds) continue;

    const assertions = await apiCheckRepo.findAssertionsByCheckId(c.id);
    const [exec] = await apiCheckRepo.createExecution(c.id, 'PENDING');

    const bucket = Math.floor(Date.now() / (c.intervalSeconds * 1000));
    await queue.add(
      'check',
      {
        executionId: exec.id,
        apiCheck: {
          id: c.id, url: c.url, method: c.method, headers: c.headers,
          body: c.body, timeout_ms: c.timeoutMs,
        },
        assertions,
      },
      { jobId: `api:${c.id}:${bucket}`, removeOnComplete: 200, removeOnFail: 200 },
    );
    logger.info(`scheduled api-check #${c.id} → exec #${exec.id}`);
  }
}

// ---------------- qa-project ----------------
async function tickQaProjects(queue: Queue) {
  const due = await qaProjectRepo.findDue();

  for (const p of due) {
    if (p.ageSeconds !== null && p.ageSeconds < p.intervalSeconds) continue;

    const tests = await qaProjectRepo.findTestsWithScriptByProjectId(p.id);
    if (tests.length === 0) continue;

    const bucket = Math.floor(Date.now() / (p.intervalSeconds * 1000));
    await queue.add(
      'run',
      {
        type: 'qa-project-run',
        project_id: p.id,
        target_url: p.targetUrl,
        credentials: p.credentials ?? undefined,
        config: p.config ?? {},
        tests,
        triggered_at: new Date().toISOString(),
      },
      { jobId: `qa:${p.id}:${bucket}`, removeOnComplete: 50, removeOnFail: 50 },
    );
    logger.info(`scheduled qa-project #${p.id} with ${tests.length} test(s)`);
  }
}
