/**
 * Scheduler — picks monitors whose interval has elapsed and enqueues jobs.
 *
 * Runs in the same process as the BullMQ workers. Ticks every TICK_MS, checks
 * each enabled monitor's last execution timestamp against its intervalSeconds,
 * and pushes a new execution row + job for the due ones.
 *
 * Dispatch is dual-path:
 *
 *   - **No regions attached** → BullMQ queue. Master's in-process workers
 *     (started in src/index.ts) consume from `url-monitor`, `api-check`, etc.
 *     This is the back-compat single-node path. BullMQ's jobId bucket
 *     dedup protects against the same monitor being enqueued twice in one
 *     interval.
 *
 *   - **Regions attached** → plain Redis list `oo:jobs:<slug>:<base>`.
 *     The agent long-poll endpoint pops from this list via BRPOPLPUSH.
 *     No BullMQ on the regional path — its retry/lock primitives don't
 *     compose with HTTP-mediated cross-process dispatch, and the agent
 *     retries naturally by reconnecting.
 *
 * The two systems are isolated by Redis key namespace; no code path reasons
 * about both at once.
 *
 * Known gap (defer to M2): plain Redis lists have no jobId dedup. With a
 * single scheduler this is fine — findDue() filters by ageSeconds so the
 * same monitor won't re-enqueue within a bucket. If you ever run HA
 * schedulers, wrap the LPUSH in `SETNX oo:scheduled:<bucket>:<m>:<r> 1
 * EX <interval>` for parity with BullMQ's jobId guarantee.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { DEFAULTS } from './constants.ts';

import { makeNonce, jobIdSuffix } from './scheduler-jobid.ts';
import type { FanOutTarget } from './scheduler-jobid.ts';
// Random 4-char suffix stamped on every job ID at boot time. BullMQ silently
// deduplicates by jobId — without this, a hard-killed process leaves stale
// waiting jobs in Redis, and on the next boot the scheduler generates the same
// wall-clock-bucketed ID, which is then deduplicated away forever (the monitor
// never runs again until the stale job is manually cleared). A per-boot nonce
// makes every boot's IDs distinct, so the drain below can clear the slate and
// fresh IDs never collide with the previous boot's artifacts.
const BOOT_NONCE = makeNonce();
import { urlMonitorRepo } from './db/repositories/url-monitor.repo.ts';
import { execEvents } from './services/exec-events.ts';
import { apiCheckRepo } from './db/repositories/api-check.repo.ts';
import { qaProjectRepo } from './db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from './db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from './db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from './db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from './db/repositories/tls-monitor.repo.ts';
import { heartbeatRepo } from './db/repositories/heartbeat.repo.ts';
import { dispatchAlert } from './services/alert-dispatch.ts';
import { monitorRegionRepo, regionRepo, type MonitorType } from './db/repositories/region.repo.ts';
import { logger } from './utils/logger.ts';

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? DEFAULTS.SCHEDULER_TICK_MS);

async function fanOutTargets(type: MonitorType, monitorId: number): Promise<FanOutTarget[]> {
  const rows = await monitorRegionRepo.forMonitor(type, monitorId);
  if (rows.length === 0) return [{ regionId: null, regionSlug: null }];
  return rows.map((r) => ({ regionId: r.id, regionSlug: r.slug }));
}

/**
 * One Redis list per region holds all job types — agents only need one
 * long-poll connection regardless of monitor count. The `type` field in
 * the payload tells the agent (and the master's result handler) which
 * processor / executions table to use.
 */
function regionalListKey(slug: string): string {
  return `oo:jobs:${slug}`;
}

type QueueFactory = (name: string) => Queue;

interface JobPayload {
  jobId: string;
  type: MonitorType;
  executionId: number;
  regionId: number | null;
  [k: string]: unknown;
}

async function dispatch(
  baseQueue: string,
  target: FanOutTarget,
  payload: JobPayload,
  removeOnComplete: number,
  getQueue: QueueFactory,
  connection: Redis,
) {
  if (target.regionSlug === null) {
    // Master in-process worker path — BullMQ semantics (retry, lock, dedup).
    const { jobId, type: _type, ...data } = payload;
    await getQueue(baseQueue).add('check', data, {
      jobId,
      removeOnComplete,
      removeOnFail: removeOnComplete,
    });
  } else {
    // Regional agent path — single combined Redis list per region. Agent
    // long-polls via BRPOPLPUSH and uses payload.type to route by monitor
    // type. baseQueue isn't part of the list key.
    await connection.lpush(regionalListKey(target.regionSlug), JSON.stringify(payload));
  }
}

const QUEUE_NAMES = [
  'url-monitor',
  'api-check',
  'qa-project',
  'tcp-monitor',
  'udp-monitor',
  'db-monitor',
  'tls-monitor',
] as const;

export async function startScheduler(connection: Redis) {
  // BullMQ queues only get created for the null-region path. Regional jobs
  // skip BullMQ entirely — see dispatch().
  const queues = new Map<string, Queue>();
  const getQueue: QueueFactory = (name) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      queues.set(name, q);
    }
    return q;
  };

  // Drain waiting jobs left over from the previous process. After a hard
  // kill (OOM, power-off), unprocessed jobs sit in the BullMQ wait list
  // indefinitely. On the next boot the scheduler would generate the same
  // wall-clock-bucketed IDs and BullMQ would deduplicate them — so those
  // monitors would silently never run until the stale entry expired or was
  // manually removed. Draining on startup clears the slate; the first tick
  // immediately re-enqueues everything that is due.
  await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      try {
        await getQueue(name).drain();
        logger.info(`startup: drained stale waiting jobs from ${name}`);
      } catch (err) {
        logger.warn(
          `startup: drain failed for ${name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );

  logger.info(`🕒 scheduler starting (tick every ${TICK_MS / 1000}s, boot-nonce ${BOOT_NONCE})`);

  // Consecutive-failure escalation. A persistent DB outage used to log
  // one error per tick and let operators discover hours later that no
  // monitor had been dispatched. Now: after CRITICAL_FAILURE_THRESHOLD
  // consecutive failed ticks we log a louder, more specific message
  // every escalation step (3, 6, 12, 24, ...). The catch still keeps
  // the loop alive on transient blips.
  const CRITICAL_FAILURE_THRESHOLD = 3;
  let consecutiveFailures = 0;
  let lastEscalation = 0;

  const tick = async () => {
    try {
      await Promise.all([
        tickUrlMonitors(getQueue, connection),
        tickApiChecks(getQueue, connection),
        tickQaProjects(getQueue, connection),
        tickTcpMonitors(getQueue, connection),
        tickUdpMonitors(getQueue, connection),
        tickDbMonitors(getQueue, connection),
        tickTlsMonitors(getQueue, connection),
        // Heartbeats are inverted-direction (service pings us) — no
        // BullMQ jobs to dispatch, just an overdue sweep that fires
        // outage alerts via the existing channel system.
        tickHeartbeats(),
        // Region online/offline sweep — fires SSE `region` events on
        // every transition so the navbar badge updates live without
        // the dashboard polling every 30s.
        tickRegionStatus(),
      ]);
      if (consecutiveFailures > 0) {
        logger.info(`scheduler recovered after ${consecutiveFailures} consecutive failure(s)`);
        consecutiveFailures = 0;
        lastEscalation = 0;
      }
    } catch (err) {
      consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      // First few failures: standard error log. Past the threshold:
      // also log at every doubling so operators can't miss it.
      logger.error(`scheduler tick failed (#${consecutiveFailures}): ${msg}`);
      if (consecutiveFailures >= CRITICAL_FAILURE_THRESHOLD) {
        // Escalate at 3, 6, 12, 24, 48... (each doubling past the
        // threshold). Keeps the noise floor low for ongoing outages
        // while keeping the signal high enough to page an operator
        // watching tail-N logs.
        if (consecutiveFailures === lastEscalation * 2 || lastEscalation === 0) {
          logger.error(
            `🚨 SCHEDULER STALLED: ${consecutiveFailures} consecutive failed ticks ` +
              `(~${Math.round((consecutiveFailures * TICK_MS) / 1000)}s of zero dispatch). ` +
              `Investigate Postgres/Redis health — no monitors are being scheduled.`,
          );
          lastEscalation = consecutiveFailures;
        }
      }
    }
  };

  tick();
  const handle = setInterval(tick, TICK_MS);

  return async () => {
    clearInterval(handle);
    await Promise.all(Array.from(queues.values()).map((q) => q.close()));
  };
}

// ---------------- url-monitor ----------------
async function tickUrlMonitors(getQueue: QueueFactory, connection: Redis) {
  const due = await urlMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const assertions = await urlMonitorRepo.findAssertionsByMonitorId(m.id);
    const targets = await fanOutTargets('url', m.id);
    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await urlMonitorRepo.createExecution(m.id, 'PENDING', target.regionId);
      await dispatch(
        'url-monitor',
        target,
        {
          jobId: `url:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'url',
          executionId: exec.id,
          regionId: target.regionId,
          monitor: { id: m.id, url: m.url, timeoutMs: m.timeoutMs },
          assertions,
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled url-monitor #${m.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- api-check ----------------
async function tickApiChecks(getQueue: QueueFactory, connection: Redis) {
  const due = await apiCheckRepo.findDue();

  for (const c of due) {
    if (c.ageSeconds !== null && c.ageSeconds < c.intervalSeconds) continue;

    const assertions = await apiCheckRepo.findAssertionsByCheckId(c.id);
    const targets = await fanOutTargets('api', c.id);
    const bucket = Math.floor(Date.now() / (c.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await apiCheckRepo.createExecution(c.id, 'PENDING', target.regionId);
      await dispatch(
        'api-check',
        target,
        {
          jobId: `api:${c.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'api',
          executionId: exec.id,
          regionId: target.regionId,
          apiCheck: {
            id: c.id,
            url: c.url,
            method: c.method,
            headers: c.headers,
            body: c.body,
            timeoutMs: c.timeoutMs,
          },
          assertions,
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled api-check #${c.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- tcp-monitor ----------------
async function tickTcpMonitors(getQueue: QueueFactory, connection: Redis) {
  const due = await tcpMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const targets = await fanOutTargets('tcp', m.id);
    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await tcpMonitorRepo.createExecution(m.id, 'PENDING', target.regionId);
      await dispatch(
        'tcp-monitor',
        target,
        {
          jobId: `tcp:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'tcp',
          executionId: exec.id,
          regionId: target.regionId,
          monitor: {
            id: m.id,
            host: m.host,
            port: m.port,
            payloadHex: m.payloadHex,
            expectBanner: m.expectBanner,
            timeoutMs: m.timeoutMs,
          },
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled tcp-monitor #${m.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- udp-monitor ----------------
async function tickUdpMonitors(getQueue: QueueFactory, connection: Redis) {
  const due = await udpMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const targets = await fanOutTargets('udp', m.id);
    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await udpMonitorRepo.createExecution(m.id, 'PENDING', target.regionId);
      await dispatch(
        'udp-monitor',
        target,
        {
          jobId: `udp:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'udp',
          executionId: exec.id,
          regionId: target.regionId,
          monitor: {
            id: m.id,
            host: m.host,
            port: m.port,
            payloadHex: m.payloadHex,
            expectResponse: m.expectResponse,
            timeoutMs: m.timeoutMs,
          },
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled udp-monitor #${m.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- db-monitor ----------------
async function tickDbMonitors(getQueue: QueueFactory, connection: Redis) {
  const due = await dbMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const targets = await fanOutTargets('db', m.id);
    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await dbMonitorRepo.createExecution(m.id, 'PENDING', target.regionId);
      await dispatch(
        'db-monitor',
        target,
        {
          jobId: `db:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'db',
          executionId: exec.id,
          regionId: target.regionId,
          monitor: {
            id: m.id,
            protocol: m.protocol,
            tls: m.tls,
            host: m.host,
            port: m.port,
            timeoutMs: m.timeoutMs,
          },
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled db-monitor #${m.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

async function tickTlsMonitors(getQueue: QueueFactory, connection: Redis) {
  const due = await tlsMonitorRepo.findDue();

  for (const m of due) {
    if (m.ageSeconds !== null && m.ageSeconds < m.intervalSeconds) continue;

    const targets = await fanOutTargets('tls', m.id);
    const bucket = Math.floor(Date.now() / (m.intervalSeconds * 1000));

    for (const target of targets) {
      const [exec] = await tlsMonitorRepo.createExecution(m.id, 'PENDING', target.regionId);
      await dispatch(
        'tls-monitor',
        target,
        {
          jobId: `tls:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'tls',
          executionId: exec.id,
          regionId: target.regionId,
          monitor: {
            id: m.id,
            host: m.host,
            port: m.port,
            servername: m.servername,
            warnDays: m.warnDays,
            timeoutMs: m.timeoutMs,
            verifyChain: m.verifyChain,
            verifyHostname: m.verifyHostname,
            expectCnRegex: m.expectCnRegex,
          },
        },
        200,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled tls-monitor #${m.id} → exec #${exec.id}${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- qa-project ----------------
async function tickQaProjects(getQueue: QueueFactory, connection: Redis) {
  const due = await qaProjectRepo.findDue();

  for (const p of due) {
    if (p.ageSeconds !== null && p.ageSeconds < p.intervalSeconds) continue;

    const tests = await qaProjectRepo.findTestsByProjectId(p.id, { includeScript: true });
    if (tests.length === 0) continue;

    const targets = await fanOutTargets('qa', p.id);
    const bucket = Math.floor(Date.now() / (p.intervalSeconds * 1000));

    for (const target of targets) {
      // QA project doesn't pre-create an exec row in the scheduler — the
      // processor does, per test. So no createExecution() here.
      await dispatch(
        'qa-project',
        target,
        {
          jobId: `qa:${p.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`,
          type: 'qa',
          executionId: 0, // synthetic; QA processor creates exec rows per test
          regionId: target.regionId,
          kind: 'qa-project-run',
          projectId: p.id,
          targetUrl: p.targetUrl,
          credentials: p.credentials ?? undefined,
          config: p.config ?? {},
          tests,
          triggeredAt: new Date().toISOString(),
        },
        50,
        getQueue,
        connection,
      );
      logger.info(
        `scheduled qa-project #${p.id} with ${tests.length} test(s)${
          target.regionSlug ? ` [${target.regionSlug}]` : ''
        }`,
      );
    }
  }
}

// ---------------- heartbeat ----------------
// Roadmap 8. Heartbeats are inverted-direction monitors — the service
// pings POST /heartbeat/:token, the worker tracks last_ping_at. This
// tick sweeps for enabled UP heartbeats whose
// (now - last_ping_at) > (period + grace), transitions them to OVERDUE,
// and fires an outage alert via the existing channel system. The state
// transition is idempotent (markOverdue returns null if status already
// OVERDUE) so a heartbeat alerts ONCE per outage, not on every tick.
// In-memory map of region id → last-known online state. Initialised on
// first sweep; subsequent sweeps detect transitions by comparing to the
// stored value. Re-derived from `lastSeenAt` (no schema change needed).
const REGION_ONLINE_THRESHOLD_MS = 60_000;
const lastOnlineState = new Map<number, boolean>();
/** Exported for tests. Internal use only — the scheduler tick calls this. */
export async function tickRegionStatus(): Promise<void> {
  const regions = await regionRepo.list();
  const now = Date.now();
  for (const r of regions) {
    const isOnline = r.lastSeenAt
      ? now - r.lastSeenAt.getTime() < REGION_ONLINE_THRESHOLD_MS
      : false;
    const prev = lastOnlineState.get(r.id);
    if (prev === undefined) {
      // First sweep — record state, don't fire (no transition).
      lastOnlineState.set(r.id, isOnline);
      continue;
    }
    if (prev !== isOnline) {
      lastOnlineState.set(r.id, isOnline);
      execEvents.emit('region', {
        regionId: r.id,
        status: isOnline ? 'online' : 'offline',
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      });
      logger.info(`region #${r.id} (${r.slug}) → ${isOnline ? 'online' : 'offline'}`);
    }
  }
}

async function tickHeartbeats(): Promise<void> {
  const overdue = await heartbeatRepo.findOverdue();
  for (const h of overdue) {
    const transitioned = await heartbeatRepo.markOverdue(h.id);
    if (!transitioned) continue; // someone else got there (or already OVERDUE)
    logger.info(`heartbeat #${h.id} (${h.name}) → OVERDUE`);
    execEvents.emit('monitor-state', {
      type: 'heartbeat',
      monitorId: h.id,
      status: 'OVERDUE',
      lastTransitionAt: new Date().toISOString(),
    });
    await dispatchAlert({
      monitor: { type: 'heartbeat', id: h.id, name: h.name, target: h.name },
      event: 'outage',
      status: 'FAILED',
      errorMessage:
        h.lastPingAt === null
          ? 'no ping received yet'
          : `no ping in ${Math.round(
              (Date.now() - h.lastPingAt.getTime()) / 1000,
            )}s (expected every ${h.periodSeconds}s + ${h.graceSeconds}s grace)`,
      startTime: new Date().toISOString(),
    });
  }
}
