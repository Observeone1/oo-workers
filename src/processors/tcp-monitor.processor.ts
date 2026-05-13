import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { tcpProbe } from '../services/tcp-probe.ts';
import { logger } from '../utils/logger.ts';

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
    return { success: true };
  }

  logger.error(`TCP monitor execution ${executionId} failed: ${result.errorMessage}`);
  await tcpMonitorRepo.updateExecution(executionId, {
    status: isFinalAttempt ? 'FAILED' : 'PENDING',
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  throw new Error(result.errorMessage ?? 'TCP probe failed');
};
