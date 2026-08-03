/**
 * Per-monitor-type tails for writeAgentResult — keeps the main switch thin.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { apiExecutions, qaTestExecutions, urlMonitorExecutions } from '../db/schema.ts';
import type { AgentResultBody } from './agent-dispatch.ts';
import { maybeAlertOnQaRunTransition, maybeAlertOnTransition } from './transition-detector.ts';
import { emitExecution } from './exec-events.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import type { WriteResultOutcome } from './agent-dispatch.ts';

export async function writeUrlAgentResult(
  agentRegionId: number,
  body: AgentResultBody,
  endTime: Date,
): Promise<WriteResultOutcome> {
  const { executionId, status, errorMessage } = body;
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
  emitExecution('url', rows[0].monitorId, {
    id: executionId,
    status,
    statusCode: body.statusCode ?? null,
    responseTimeMs: body.latencyMs ?? null,
    errorMessage: errorMessage ?? null,
    regionId: agentRegionId,
  });
  return { updated: true };
}

export async function writeApiAgentResult(
  agentRegionId: number,
  body: AgentResultBody,
  endTime: Date,
): Promise<WriteResultOutcome> {
  const { executionId, status, errorMessage } = body;
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
  emitExecution('api', rows[0].monitorId, {
    id: executionId,
    status,
    statusCode: body.responseStatus ?? null,
    responseTimeMs: body.responseTimeMs ?? body.latencyMs ?? null,
    errorMessage: errorMessage ?? null,
    regionId: agentRegionId,
  });
  return { updated: true };
}

export async function writeQaAgentResult(
  agentRegionId: number,
  body: AgentResultBody,
  endTime: Date,
): Promise<WriteResultOutcome> {
  const { executionId, status, errorMessage } = body;
  const rows = await db
    .update(qaTestExecutions)
    .set({
      status,
      durationMs: body.latencyMs ?? null,
      errorMessage: errorMessage ?? null,
      completedAt: endTime,
      traceUrl: body.traceUrl ?? null,
      screenshotUrls: body.screenshotUrls ?? null,
    })
    .where(and(eq(qaTestExecutions.id, executionId), eq(qaTestExecutions.regionId, agentRegionId)))
    .returning({ id: qaTestExecutions.id, runId: qaTestExecutions.runId });
  if (rows.length !== 1) return { updated: false, reason: 'no_match' };

  const runId = rows[0].runId;
  if (runId !== null) {
    const progress = await qaProjectRepo.runProgress(runId);
    if (progress && progress.completed >= progress.expectedTests) {
      const outcome = progress.downCount > 0 ? 'FAILED' : 'SUCCESS';
      if (await qaProjectRepo.claimRunAlert(runId, outcome)) {
        void maybeAlertOnQaRunTransition(runId);
      }
    }
  }
  return { updated: true };
}
