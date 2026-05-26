import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { tcpProbe } from '../services/tcp-probe.ts';
import { parseHexPayload } from '../services/udp-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { emitExecution } from '../services/exec-events.ts';

export const tcpMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS;

  logger.info(`Processing TCP Monitor job ${job.id} (Execution: ${executionId})`);

  let payload: Buffer | null;
  try {
    payload = parseHexPayload(monitor.payloadHex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid payload_hex';
    await tcpMonitorRepo.updateExecution(executionId, {
      status: 'FAILED',
      errorMessage: msg,
      endTime: new Date(),
    });
    emitExecution('tcp', monitor.id, { id: executionId, status: 'FAILED', errorMessage: msg });
    void maybeAlertOnTransition('tcp', monitor.id, executionId, 'FAILED', { errorMessage: msg });
    throw new Error(msg);
  }

  const result = await tcpProbe({
    host: monitor.host,
    port: monitor.port,
    timeoutMs,
    payload,
    expectBanner: monitor.expectBanner ?? null,
  });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await tcpMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      banner: result.banner ?? null,
      endTime: new Date(),
    });
    emitExecution('tcp', monitor.id, {
      id: executionId,
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
    });
    void maybeAlertOnTransition('tcp', monitor.id, executionId, 'SUCCESS', {
      durationMs: result.latencyMs,
    });
    return { success: true };
  }

  logger.error(`TCP monitor execution ${executionId} failed: ${result.errorMessage}`);
  const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
  await tcpMonitorRepo.updateExecution(executionId, {
    status: finalStatus,
    latencyMs: result.latencyMs,
    banner: result.banner ?? null,
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  emitExecution('tcp', monitor.id, {
    id: executionId,
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('tcp', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'TCP probe failed');
};
