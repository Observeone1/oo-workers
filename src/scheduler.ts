/**
 * Scheduler — picks monitors whose interval has elapsed and enqueues jobs.
 *
 * Runs in the same process as the BullMQ workers. Ticks every TICK_MS, checks
 * each enabled monitor's last execution timestamp against its interval_seconds,
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
    if (m.age_seconds !== null && m.age_seconds < m.interval_seconds) continue;

    const assertions = await urlMonitorRepo.findAssertionsByMonitorId(m.id);
    const [exec] = await urlMonitorRepo.createExecution(m.id, 'pending');

    const bucket = Math.floor(Date.now() / (m.interval_seconds * 1000));
    await queue.add(
      'check',
      {
        executionId: exec.id,
        monitor: { id: m.id, url: m.url, timeout_ms: m.timeout_ms },
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
    if (c.age_seconds !== null && c.age_seconds < c.interval_seconds) continue;

    const assertions = await apiCheckRepo.findAssertionsByCheckId(c.id);
    const [exec] = await apiCheckRepo.createExecution(c.id, 'pending');

    const bucket = Math.floor(Date.now() / (c.interval_seconds * 1000));
    await queue.add(
      'check',
      {
        executionId: exec.id,
        apiCheck: {
          id: c.id, url: c.url, method: c.method, headers: c.headers,
          body: c.body, timeout_ms: c.timeout_ms,
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
    if (p.age_seconds !== null && p.age_seconds < p.interval_seconds) continue;

    const tests = await qaProjectRepo.findTestsWithScriptByProjectId(p.id);
    if (tests.length === 0) continue;

    const bucket = Math.floor(Date.now() / (p.interval_seconds * 1000));
    await queue.add(
      'run',
      {
        type: 'qa-project-run',
        project_id: p.id,
        target_url: p.target_url,
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
