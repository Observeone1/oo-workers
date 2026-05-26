import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { dbProbe, type DbProtocol } from '../services/db-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { emitExecution } from '../services/exec-events.ts';

export const dbMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || DEFAULTS.DB_TIMEOUT_MS;

  logger.info(`Processing DB Monitor job ${job.id} (Execution: ${executionId})`);

  const result = await dbProbe({
    host: monitor.host,
    port: monitor.port,
    protocol: monitor.protocol as DbProtocol,
    tls: monitor.tls,
    timeoutMs,
  });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await dbMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      endTime: new Date(),
    });
    emitExecution('db', monitor.id, {
      id: executionId,
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
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
  emitExecution('db', monitor.id, {
    id: executionId,
    status: finalStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('db', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'DB probe failed');
};
