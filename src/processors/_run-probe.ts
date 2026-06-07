import type { Job } from 'bullmq';
import { logger } from '../utils/logger.ts';
import { emitExecution } from '../services/exec-events.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import type { MonitorType } from '../db/repositories/region.repo.ts';

interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  errorMessage?: string;
}

type AnyRepo = { updateExecution(id: number, fields: any): Promise<unknown> };

/**
 * Shared success/fail skeleton for simple probe processors (db, tcp, tls, udp).
 * Caller supplies the probe and the per-type execution fields; this handles
 * the updateExecution → emitExecution → maybeAlertOnTransition flow.
 */
export async function runProbeProcessor<R extends ProbeResult>(
  job: Job,
  type: MonitorType,
  executionId: number,
  monitorId: number,
  repo: AnyRepo,
  runProbe: () => Promise<R>,
  successFields: (r: R) => Record<string, unknown>,
  failFields: (r: R) => Record<string, unknown>,
): Promise<{ success: true }> {
  logger.info(`Processing ${type.toUpperCase()} Monitor job ${job.id} (Execution: ${executionId})`);

  const result = await runProbe();
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await repo.updateExecution(executionId, {
      status: 'SUCCESS',
      endTime: new Date(),
      ...successFields(result),
    });
    emitExecution(type, monitorId, {
      id: executionId,
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
    });
    void maybeAlertOnTransition(type, monitorId, executionId, 'SUCCESS', {
      durationMs: result.latencyMs,
    });
    return { success: true };
  }

  logger.error(
    `${type.toUpperCase()} monitor execution ${executionId} failed: ${result.errorMessage}`,
  );
  const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
  await repo.updateExecution(executionId, {
    status: finalStatus,
    endTime: new Date(),
    ...failFields(result),
  });
  emitExecution(type, monitorId, {
    id: executionId,
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition(type, monitorId, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? `${type.toUpperCase()} probe failed`);
}
