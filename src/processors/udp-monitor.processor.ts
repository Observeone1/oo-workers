import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { parseHexPayload, udpProbe } from '../services/udp-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { emitExecution } from '../services/exec-events.ts';

export const udpMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || DEFAULTS.UDP_TIMEOUT_MS;

  logger.info(`Processing UDP Monitor job ${job.id} (Execution: ${executionId})`);

  let payload: Buffer | null;
  try {
    payload = parseHexPayload(monitor.payloadHex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await udpMonitorRepo.updateExecution(executionId, {
      status: 'FAILED',
      errorMessage: msg,
      endTime: new Date(),
    });
    emitExecution('udp', monitor.id, { id: executionId, status: 'FAILED', errorMessage: msg });
    throw new Error(msg);
  }

  const result = await udpProbe({
    host: monitor.host,
    port: monitor.port,
    payload,
    expectResponse: !!monitor.expectResponse,
    timeoutMs,
  });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await udpMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      responseBytes: result.responseBytes ?? null,
      endTime: new Date(),
    });
    emitExecution('udp', monitor.id, {
      id: executionId,
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
    });
    void maybeAlertOnTransition('udp', monitor.id, executionId, 'SUCCESS', {
      durationMs: result.latencyMs,
    });
    return { success: true };
  }

  logger.error(`UDP monitor execution ${executionId} failed: ${result.errorMessage}`);
  const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
  await udpMonitorRepo.updateExecution(executionId, {
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  emitExecution('udp', monitor.id, {
    id: executionId,
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('udp', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'UDP probe failed');
};
