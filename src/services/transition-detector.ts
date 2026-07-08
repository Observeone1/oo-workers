/**
 * Status transition detection — given a just-written execution row,
 * look up the immediately-previous execution for the same monitor and
 * decide whether this is an outage (SUCCESS → FAILED), recovery
 * (FAILED → SUCCESS), or noop (no change / first run).
 *
 * On transition, hands off to alert-dispatch.ts. Best-effort and
 * isolated — never throws back into the processor that called it, so
 * a busted alert path can't break the result-write code path.
 *
 * SUCCESS/FAILED equivalence: QA runs use 'passed'/'failed' lowercase.
 * normalizeOutcome() folds both vocabularies into 'up' | 'down'.
 */

import { and, desc, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { db } from '../config/db.ts';
import {
  apiChecks,
  apiExecutions,
  dbExecutions,
  dbMonitors,
  qaProjects,
  qaRuns,
  qaTestExecutions,
  regions,
  tcpExecutions,
  tcpMonitors,
  tlsExecutions,
  tlsMonitors,
  udpExecutions,
  udpMonitors,
  urlMonitorExecutions,
  urlMonitors,
} from '../db/schema.ts';
import { logger } from '../utils/logger.ts';
import { dispatchAlert } from './alert-dispatch.ts';
import type { MonitorType } from '../db/repositories/alert-channel.repo.ts';

type Outcome = 'up' | 'down' | 'other';

function normalizeOutcome(status: string): Outcome {
  const s = status.toUpperCase();
  if (s === 'SUCCESS' || s === 'PASSED') return 'up';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'ERROR') return 'down';
  return 'other';
}

/** Returns the status of the most recent OTHER execution for this monitor, or null. */
async function previousStatus(
  monitorType: MonitorType,
  monitorId: number,
  currentExecutionId: number,
): Promise<string | null> {
  if (monitorType === 'url') {
    const rows = await db
      .select({ status: urlMonitorExecutions.status })
      .from(urlMonitorExecutions)
      .where(
        and(
          eq(urlMonitorExecutions.urlMonitorId, monitorId),
          ne(urlMonitorExecutions.id, currentExecutionId),
        ),
      )
      .orderBy(desc(urlMonitorExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  if (monitorType === 'api') {
    const rows = await db
      .select({ status: apiExecutions.status })
      .from(apiExecutions)
      .where(and(eq(apiExecutions.apiCheckId, monitorId), ne(apiExecutions.id, currentExecutionId)))
      .orderBy(desc(apiExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  if (monitorType === 'tcp') {
    const rows = await db
      .select({ status: tcpExecutions.status })
      .from(tcpExecutions)
      .where(
        and(eq(tcpExecutions.tcpMonitorId, monitorId), ne(tcpExecutions.id, currentExecutionId)),
      )
      .orderBy(desc(tcpExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  if (monitorType === 'udp') {
    const rows = await db
      .select({ status: udpExecutions.status })
      .from(udpExecutions)
      .where(
        and(eq(udpExecutions.udpMonitorId, monitorId), ne(udpExecutions.id, currentExecutionId)),
      )
      .orderBy(desc(udpExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  if (monitorType === 'db') {
    const rows = await db
      .select({ status: dbExecutions.status })
      .from(dbExecutions)
      .where(and(eq(dbExecutions.dbMonitorId, monitorId), ne(dbExecutions.id, currentExecutionId)))
      .orderBy(desc(dbExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  if (monitorType === 'tls') {
    const rows = await db
      .select({ status: tlsExecutions.status })
      .from(tlsExecutions)
      .where(
        and(eq(tlsExecutions.tlsMonitorId, monitorId), ne(tlsExecutions.id, currentExecutionId)),
      )
      .orderBy(desc(tlsExecutions.startTime))
      .limit(1);
    return rows[0]?.status ?? null;
  }
  // qa — exec rows are per-test; alert when *any* test in the project flips.
  // For "did this project's last run pass overall" semantics, prefer
  // qa_test_executions ordered by startedAt with project_id filter.
  const rows = await db
    .select({ status: qaTestExecutions.status })
    .from(qaTestExecutions)
    .where(
      and(eq(qaTestExecutions.projectId, monitorId), ne(qaTestExecutions.id, currentExecutionId)),
    )
    .orderBy(desc(qaTestExecutions.startedAt))
    .limit(1);
  return rows[0]?.status ?? null;
}

async function monitorMeta(
  monitorType: MonitorType,
  monitorId: number,
): Promise<{ name: string; target: string } | null> {
  if (monitorType === 'url') {
    const [r] = await db
      .select({ name: urlMonitors.name, url: urlMonitors.url })
      .from(urlMonitors)
      .where(eq(urlMonitors.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: r.url } : null;
  }
  if (monitorType === 'api') {
    const [r] = await db
      .select({ name: apiChecks.name, url: apiChecks.url })
      .from(apiChecks)
      .where(eq(apiChecks.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: r.url } : null;
  }
  if (monitorType === 'tcp') {
    const [r] = await db
      .select({ name: tcpMonitors.name, host: tcpMonitors.host, port: tcpMonitors.port })
      .from(tcpMonitors)
      .where(eq(tcpMonitors.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: `${r.host}:${r.port}` } : null;
  }
  if (monitorType === 'udp') {
    const [r] = await db
      .select({ name: udpMonitors.name, host: udpMonitors.host, port: udpMonitors.port })
      .from(udpMonitors)
      .where(eq(udpMonitors.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: `${r.host}:${r.port}` } : null;
  }
  if (monitorType === 'db') {
    const [r] = await db
      .select({
        name: dbMonitors.name,
        protocol: dbMonitors.protocol,
        host: dbMonitors.host,
        port: dbMonitors.port,
      })
      .from(dbMonitors)
      .where(eq(dbMonitors.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: `${r.protocol} ${r.host}:${r.port}` } : null;
  }
  if (monitorType === 'tls') {
    const [r] = await db
      .select({ name: tlsMonitors.name, host: tlsMonitors.host, port: tlsMonitors.port })
      .from(tlsMonitors)
      .where(eq(tlsMonitors.id, monitorId))
      .limit(1);
    return r ? { name: r.name, target: `${r.host}:${r.port}` } : null;
  }
  // qa
  const [r] = await db
    .select({ name: qaProjects.name })
    .from(qaProjects)
    .where(eq(qaProjects.id, monitorId))
    .limit(1);
  return r ? { name: r.name, target: 'browser script' } : null;
}

async function regionSlugById(regionId: number | null | undefined): Promise<string | null> {
  if (regionId == null) return null;
  const [r] = await db
    .select({ slug: regions.slug })
    .from(regions)
    .where(eq(regions.id, regionId))
    .limit(1);
  return r?.slug ?? null;
}

interface TransitionDetail {
  statusCode?: number | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  regionId?: number | null;
  startTime?: Date;
}

/**
 * Hook this after writing an execution row. Looks up the previous status,
 * decides outage / recovery / noop, dispatches if needed. Swallows all errors
 * — alert paths must not block result writes.
 */
export async function maybeAlertOnTransition(
  monitorType: MonitorType,
  monitorId: number,
  currentExecutionId: number,
  currentStatus: string,
  detail: TransitionDetail = {},
): Promise<void> {
  try {
    const curOutcome = normalizeOutcome(currentStatus);
    if (curOutcome === 'other') return;
    const prev = await previousStatus(monitorType, monitorId, currentExecutionId);
    if (prev === null) return; // first run — no transition
    const prevOutcome = normalizeOutcome(prev);
    if (prevOutcome === 'other') return;
    if (prevOutcome === curOutcome) return;
    const event: 'outage' | 'recovery' = curOutcome === 'down' ? 'outage' : 'recovery';
    const meta = await monitorMeta(monitorType, monitorId);
    if (!meta) return;
    const regionSlug = await regionSlugById(detail.regionId);
    await dispatchAlert({
      monitor: { type: monitorType, id: monitorId, name: meta.name, target: meta.target },
      event,
      status: currentStatus,
      statusCode: detail.statusCode ?? null,
      errorMessage: detail.errorMessage ?? null,
      durationMs: detail.durationMs ?? null,
      startTime: (detail.startTime ?? new Date()).toISOString(),
      regionSlug,
    });
  } catch (err) {
    logger.error(
      `transition-detector: ${monitorType}#${monitorId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * QA-project alerting. Unlike url/api/tcp/udp/db (one probe = one exec
 * row), a QA project run writes N qa_test_executions rows (one per
 * test), so "did it flip?" is a per-*run* aggregate question that does
 * not fit maybeAlertOnTransition's single-row exclude.
 *
 * Driven by the `qa_runs` row (id passed in): its `outcome` is this run's
 * verdict (all tests passed = SUCCESS; any failed/errored = FAILED). The
 * previous run is the most recent COMPLETED `qa_runs` row for the SAME
 * (projectId, regionId) — so a region compares only against its own history
 * (no cross-region blending) and a master run (region_id NULL) compares
 * against master runs. If the previous run's outcome differs, dispatch
 * outage/recovery. This replaces the old ±30s startedAt bucketing.
 *
 * Best-effort and isolated — never throws back into the caller, so a busted
 * alert path can't break run completion.
 */
export async function maybeAlertOnQaRunTransition(runId: number): Promise<void> {
  try {
    const [run] = await db
      .select({
        projectId: qaRuns.projectId,
        regionId: qaRuns.regionId,
        startedAt: qaRuns.startedAt,
        outcome: qaRuns.outcome,
      })
      .from(qaRuns)
      .where(eq(qaRuns.id, runId))
      .limit(1);
    if (!run || !run.outcome) return;
    const curOutcome = normalizeOutcome(run.outcome);
    if (curOutcome === 'other') return;

    // Previous completed run for the SAME (project, region). A NULL region
    // (master run) only matches other master runs; a region only matches its
    // own runs — region_id scoping is what stops cross-region mis-blending.
    const [prev] = await db
      .select({ outcome: qaRuns.outcome })
      .from(qaRuns)
      .where(
        and(
          eq(qaRuns.projectId, run.projectId),
          run.regionId === null ? isNull(qaRuns.regionId) : eq(qaRuns.regionId, run.regionId),
          lt(qaRuns.startedAt, run.startedAt),
          isNotNull(qaRuns.outcome),
        ),
      )
      .orderBy(desc(qaRuns.startedAt))
      .limit(1);
    if (!prev?.outcome) return; // first run for this (project, region)
    const prevOutcome = normalizeOutcome(prev.outcome);
    if (prevOutcome === 'other' || prevOutcome === curOutcome) return; // no transition

    const event: 'outage' | 'recovery' = curOutcome === 'down' ? 'outage' : 'recovery';
    const meta = await monitorMeta('qa', run.projectId);
    if (!meta) return;
    let regionSlug: string | null = null;
    if (run.regionId !== null) {
      const [r] = await db
        .select({ slug: regions.slug })
        .from(regions)
        .where(eq(regions.id, run.regionId))
        .limit(1);
      regionSlug = r?.slug ?? null;
    }
    await dispatchAlert({
      monitor: { type: 'qa', id: run.projectId, name: meta.name, target: meta.target },
      event,
      status: run.outcome,
      statusCode: null,
      errorMessage: null,
      durationMs: null,
      startTime: run.startedAt.toISOString(),
      regionSlug,
    });
  } catch (err) {
    logger.error(
      `transition-detector: qa-run#${runId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
