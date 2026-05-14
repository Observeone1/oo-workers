import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { tcpProbe } from '../services/tcp-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';

export const tcpMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS;

  logger.info(`Processing TCP Monitor job ${job.id} (Execution: ${executionId})`);

  const result = await tcpProbe(monitor.host, monitor.port, timeoutMs);
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await tcpMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      endTime: new Date(),
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
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('tcp', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'TCP probe failed');
};
