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
import { dbExecutions, tcpExecutions, tlsExecutions, udpExecutions } from '../db/schema.ts';
import type { MonitorType } from '../db/repositories/region.repo.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from './transition-detector.ts';
import { emitExecution } from './exec-events.ts';
import {
  writeApiAgentResult,
  writeQaAgentResult,
  writeUrlAgentResult,
} from './agent-result-writers.ts';

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
  // tcp-specific
  banner?: string | null;
  // tls-specific
  daysRemaining?: number | null;
  validTo?: string | null;
  certSummary?: string | null;
  // qa-specific (agent-uploaded via /api/agent/qa/artifacts; only present on failure)
  traceUrl?: string | null;
  screenshotUrls?: string[] | null;
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
    case 'url':
      return writeUrlAgentResult(agentRegionId, body, endTime);
    case 'api':
      return writeApiAgentResult(agentRegionId, body, endTime);
    case 'tcp': {
      const rows = await db
        .update(tcpExecutions)
        .set({
          status,
          latencyMs: body.latencyMs ?? null,
          banner: body.banner ?? null,
          errorMessage: errorMessage ?? null,
          endTime,
        })
        .where(and(eq(tcpExecutions.id, executionId), eq(tcpExecutions.regionId, agentRegionId)))
        .returning({ id: tcpExecutions.id, monitorId: tcpExecutions.tcpMonitorId });
      return finishLatencyResult('tcp', rows, body, agentRegionId);
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
      return finishLatencyResult('udp', rows, body, agentRegionId);
    }
    case 'db': {
      const rows = await db
        .update(dbExecutions)
        .set({
          status,
          latencyMs: body.latencyMs ?? null,
          errorMessage: errorMessage ?? null,
          endTime,
        })
        .where(and(eq(dbExecutions.id, executionId), eq(dbExecutions.regionId, agentRegionId)))
        .returning({ id: dbExecutions.id, monitorId: dbExecutions.dbMonitorId });
      return finishLatencyResult('db', rows, body, agentRegionId);
    }
    case 'tls': {
      const rows = await db
        .update(tlsExecutions)
        .set({
          status,
          latencyMs: body.latencyMs ?? null,
          daysRemaining: body.daysRemaining ?? null,
          validTo: body.validTo ? new Date(body.validTo) : null,
          certSummary: body.certSummary ?? null,
          errorMessage: errorMessage ?? null,
          endTime,
        })
        .where(and(eq(tlsExecutions.id, executionId), eq(tlsExecutions.regionId, agentRegionId)))
        .returning({ id: tlsExecutions.id, monitorId: tlsExecutions.tlsMonitorId });
      return finishLatencyResult('tls', rows, body, agentRegionId);
    }
    case 'qa':
      return writeQaAgentResult(agentRegionId, body, endTime);
    default: {
      const _exhaustive: never = type;
      throw new Error(`unhandled monitor type: ${_exhaustive}`);
    }
  }
}

/**
 * Shared tail for the simple latency-style kinds (tcp/udp/db/tls): bail when
 * the region-scoped UPDATE matched nothing, fire the transition detector on
 * terminal statuses, and emit the live execution event. url/api keep their
 * own tails because their alert/event payloads carry extra HTTP fields.
 */
function finishLatencyResult(
  kind: 'tcp' | 'udp' | 'db' | 'tls',
  rows: Array<{ id: number; monitorId: number }>,
  body: AgentResultBody,
  agentRegionId: number,
): WriteResultOutcome {
  const { executionId, status, errorMessage } = body;
  if (rows.length !== 1) return { updated: false, reason: 'no_match' };
  if (status === 'SUCCESS' || status === 'FAILED') {
    void maybeAlertOnTransition(kind, rows[0].monitorId, executionId, status, {
      durationMs: body.latencyMs ?? null,
      errorMessage: errorMessage ?? null,
      regionId: agentRegionId,
    });
  }
  emitExecution(kind, rows[0].monitorId, {
    id: executionId,
    status,
    latencyMs: body.latencyMs ?? null,
    errorMessage: errorMessage ?? null,
    regionId: agentRegionId,
  });
  return { updated: true };
}
