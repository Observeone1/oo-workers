import { Job } from 'bullmq';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { dbProbe, type DbProtocol } from '../services/db-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';

export const dbMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || 5000;

  logger.info(`Processing DB Monitor job ${job.id} (Execution: ${executionId})`);

  const result = await dbProbe({
    host: monitor.host,
    port: monitor.port,
    protocol: monitor.protocol as DbProtocol,
    timeoutMs,
  });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await dbMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      endTime: new Date(),
    });
    void maybeAlertOnTransition('db', monitor.id, executionId, 'SUCCESS', {
      durationMs: result.latencyMs,
    });
    return { success: true };
  }

  logger.error(`DB monitor execution ${executionId} failed: ${result.errorMessage}`);
  const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
  await dbMonitorRepo.updateExecution(executionId, {
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('db', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'DB probe failed');
};
