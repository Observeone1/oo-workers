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
import { sql } from './config/db.ts';
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
  const due = await sql`
    SELECT m.id, m.url, m.timeout_ms, m.interval_seconds,
           (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_time)))::bigint
              FROM url_monitor_executions WHERE url_monitor_id = m.id) AS age_seconds
    FROM url_monitors m
    WHERE m.enabled = TRUE
  `;

  for (const m of due as any[]) {
    if (m.age_seconds !== null && m.age_seconds < m.interval_seconds) continue;

    const assertions = await sql`
      SELECT id, operator, status_code FROM url_monitor_assertions WHERE url_monitor_id = ${m.id}
    `;
    const [exec] = await sql`
      INSERT INTO url_monitor_executions (url_monitor_id, status) VALUES (${m.id}, 'pending') RETURNING id
    `;

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
  const due = await sql`
    SELECT c.id, c.url, c.method, c.headers, c.body, c.timeout_ms, c.interval_seconds,
           (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_time)))::bigint
              FROM api_executions WHERE api_check_id = c.id) AS age_seconds
    FROM api_checks c
    WHERE c.enabled = TRUE
  `;

  for (const c of due as any[]) {
    if (c.age_seconds !== null && c.age_seconds < c.interval_seconds) continue;

    const assertions = await sql`
      SELECT id, type, operator, path, value FROM api_assertions WHERE api_check_id = ${c.id}
    `;
    const [exec] = await sql`
      INSERT INTO api_executions (api_check_id, status) VALUES (${c.id}, 'pending') RETURNING id
    `;

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
  const due = await sql`
    SELECT p.id, p.target_url, p.credentials, p.config, p.interval_seconds, p.last_run_at,
           EXTRACT(EPOCH FROM (NOW() - p.last_run_at))::bigint AS age_seconds
    FROM qa_projects p
    WHERE p.enabled = TRUE
  `;

  for (const p of due as any[]) {
    if (p.age_seconds !== null && p.age_seconds < p.interval_seconds) continue;

    const tests = await sql`
      SELECT id, test_name AS name, script FROM qa_generated_tests WHERE project_id = ${p.id}
    `;
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
