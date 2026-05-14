/**
 * Agent dispatch — server side of the multi-region pull/post protocol.
 *
 * GET /api/agent/jobs uses popJobForRegion() to fetch the next job from
 * the region's combined Redis list. POST /api/agent/results uses
 * writeAgentResult() to write back into the right per-type executions
 * table while enforcing the agent owns that execution's region.
 */

import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { db } from '../config/db.ts';
import {
  apiExecutions,
  qaTestExecutions,
  tcpExecutions,
  udpExecutions,
  urlMonitorExecutions,
} from '../db/schema.ts';
import type { MonitorType } from '../db/repositories/region.repo.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from './transition-detector.ts';

const REGION_LIST = (slug: string) => `oo:jobs:${slug}`;

export async function popJobForRegion(
  connection: Redis,
  slug: string,
  waitSeconds: number,
): Promise<Record<string, unknown> | null> {
  const result = await connection.brpop(REGION_LIST(slug), waitSeconds);
  if (!result) return null;
  const [, payloadStr] = result;
  try {
    return JSON.parse(payloadStr) as Record<string, unknown>;
  } catch {
    logger.error(`agent dispatch: invalid JSON in queue for ${slug}: ${payloadStr}`);
    return null;
  }
}

// Status conventions match master processors so multi-region runs render
// identically to single-node runs in the dashboard. ERROR is reserved for
// agent-side execution errors (e.g. QA-not-supported); SUCCESS/FAILED are
// normal probe outcomes; PENDING is for the "still trying" path that
// processors emit on non-final retry attempts (currently unused by agents).
type AgentResultStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'ERROR';

export interface AgentResultBody {
  type: MonitorType;
  executionId: number;
  status: AgentResultStatus;
  latencyMs?: number | null;
  errorMessage?: string | null;
  // url-monitor-specific
  statusCode?: number | null;
  assertionResults?: unknown[] | null;
  // api-check-specific
  responseStatus?: number | null;
  responseTimeMs?: number | null;
  responseBody?: string | null;
  responseHeaders?: Record<string, string> | null;
  // udp-specific
  responseBytes?: number | null;
}

export interface WriteResultOutcome {
  updated: boolean;
  reason?: 'no_match';
}

/**
 * Write the agent's result into the right per-type executions table.
 *
 * Ownership is enforced atomically inside the UPDATE: the WHERE clause
 * matches both `id = executionId` AND `region_id = agentRegionId`. If
 * the row was created for a different region (or doesn't exist), the
 * UPDATE returns no rows → returned `updated: false` so the route
 * handler can emit a 403.
 */
export async function writeAgentResult(
  agentRegionId: number,
  body: AgentResultBody,
): Promise<WriteResultOutcome> {
  const endTime = new Date();
  const { type, executionId, status, errorMessage } = body;

  switch (type) {
    case 'url': {
      const rows = await db
        .update(urlMonitorExecutions)
        .set({
          status,
          statusCode: body.statusCode ?? null,
          responseTimeMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          assertionResults: body.assertionResults ?? null,
          endTime,
        })
        .where(
          and(
            eq(urlMonitorExecutions.id, executionId),
            eq(urlMonitorExecutions.regionId, agentRegionId),
          ),
        )
        .returning({ id: urlMonitorExecutions.id, monitorId: urlMonitorExecutions.urlMonitorId });
      if (rows.length !== 1) return { updated: false, reason: 'no_match' };
      if (status === 'SUCCESS' || status === 'FAILED') {
        void maybeAlertOnTransition('url', rows[0].monitorId, executionId, status, {
          statusCode: body.statusCode ?? null,
          durationMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          regionId: agentRegionId,
        });
      }
      return { updated: true };
    }
    case 'api': {
      const rows = await db
        .update(apiExecutions)
        .set({
          status,
          responseStatus: body.responseStatus ?? null,
          responseTimeMs: body.responseTimeMs ?? body.latencyMs ?? null,
          responseBody: body.responseBody ?? null,
          responseHeaders: body.responseHeaders ?? null,
          errorMessage: errorMessage ?? null,
          assertionResults: body.assertionResults ?? null,
          endTime,
        })
        .where(and(eq(apiExecutions.id, executionId), eq(apiExecutions.regionId, agentRegionId)))
        .returning({ id: apiExecutions.id, monitorId: apiExecutions.apiCheckId });
      if (rows.length !== 1) return { updated: false, reason: 'no_match' };
      if (status === 'SUCCESS' || status === 'FAILED') {
        void maybeAlertOnTransition('api', rows[0].monitorId, executionId, status, {
          statusCode: body.responseStatus ?? null,
          durationMs: body.responseTimeMs ?? body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          regionId: agentRegionId,
        });
      }
      return { updated: true };
    }
    case 'tcp': {
      const rows = await db
        .update(tcpExecutions)
        .set({
          status,
          latencyMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          endTime,
        })
        .where(and(eq(tcpExecutions.id, executionId), eq(tcpExecutions.regionId, agentRegionId)))
        .returning({ id: tcpExecutions.id, monitorId: tcpExecutions.tcpMonitorId });
      if (rows.length !== 1) return { updated: false, reason: 'no_match' };
      if (status === 'SUCCESS' || status === 'FAILED') {
        void maybeAlertOnTransition('tcp', rows[0].monitorId, executionId, status, {
          durationMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          regionId: agentRegionId,
        });
      }
      return { updated: true };
    }
    case 'udp': {
      const rows = await db
        .update(udpExecutions)
        .set({
          status,
          latencyMs: body.latencyMs ?? null,
          responseBytes: body.responseBytes ?? null,
          errorMessage: errorMessage ?? null,
          endTime,
        })
        .where(and(eq(udpExecutions.id, executionId), eq(udpExecutions.regionId, agentRegionId)))
        .returning({ id: udpExecutions.id, monitorId: udpExecutions.udpMonitorId });
      if (rows.length !== 1) return { updated: false, reason: 'no_match' };
      if (status === 'SUCCESS' || status === 'FAILED') {
        void maybeAlertOnTransition('udp', rows[0].monitorId, executionId, status, {
          durationMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          regionId: agentRegionId,
        });
      }
      return { updated: true };
    }
    case 'qa': {
      // QA project runs create exec rows per-test inside the processor; the
      // agent reports per-test results identified by executionId (the
      // qa_test_executions row id).
      const rows = await db
        .update(qaTestExecutions)
        .set({
          status,
          durationMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          completedAt: endTime,
        })
        .where(
          and(eq(qaTestExecutions.id, executionId), eq(qaTestExecutions.regionId, agentRegionId)),
        )
        .returning({ id: qaTestExecutions.id });
      return rows.length === 1 ? { updated: true } : { updated: false, reason: 'no_match' };
    }
    default: {
      const _exhaustive: never = type;
      throw new Error(`unhandled monitor type: ${_exhaustive}`);
    }
  }
}
