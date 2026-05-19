import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { tlsProbe } from '../services/tls-probe.ts';
import { logger } from '../utils/logger.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';

export const tlsMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  const timeoutMs = monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS;

  logger.info(`Processing TLS Monitor job ${job.id} (Execution: ${executionId})`);

  const result = await tlsProbe({
    host: monitor.host,
    port: monitor.port,
    timeoutMs,
    warnDays: monitor.warnDays ?? 30,
    servername: monitor.servername ?? null,
    verifyChain: monitor.verifyChain ?? false,
    verifyHostname: monitor.verifyHostname ?? false,
    expectCnRegex: monitor.expectCnRegex ?? null,
  });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  if (result.ok) {
    await tlsMonitorRepo.updateExecution(executionId, {
      status: 'SUCCESS',
      latencyMs: result.latencyMs,
      daysRemaining: result.daysRemaining ?? null,
      validTo: result.validTo ?? null,
      certSummary: result.certSummary ?? null,
      endTime: new Date(),
    });
    void maybeAlertOnTransition('tls', monitor.id, executionId, 'SUCCESS', {
      durationMs: result.latencyMs,
    });
    return { success: true };
  }

  logger.error(`TLS monitor execution ${executionId} failed: ${result.errorMessage}`);
  const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
  await tlsMonitorRepo.updateExecution(executionId, {
    status: finalStatus,
    latencyMs: result.latencyMs,
    daysRemaining: result.daysRemaining ?? null,
    validTo: result.validTo ?? null,
    certSummary: result.certSummary ?? null,
    errorMessage: result.errorMessage,
    endTime: new Date(),
  });
  if (finalStatus === 'FAILED') {
    void maybeAlertOnTransition('tls', monitor.id, executionId, 'FAILED', {
      durationMs: result.latencyMs,
      errorMessage: result.errorMessage,
    });
  }
  throw new Error(result.errorMessage ?? 'TLS probe failed');
};
