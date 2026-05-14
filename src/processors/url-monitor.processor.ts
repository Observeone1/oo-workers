import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { logger } from '../utils/logger.ts';
import { classifyFetchError } from '../utils/fetch-errors.ts';
import { evaluateUrlMonitorAssertions } from '../services/url-assertion.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';

export const urlMonitorProcessor = async (job: Job) => {
  const { executionId, monitor, assertions } = job.data;
  const startTime = Date.now();
  const timeoutMs = monitor.timeoutMs || DEFAULTS.URL_TIMEOUT_MS;

  logger.info(`Processing URL Monitor job ${job.id} (Execution: ${executionId})`);

  try {
    const response = await fetch(monitor.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseTime = Date.now() - startTime;

    const assertionResults = evaluateUrlMonitorAssertions(assertions || [], response.status);
    const allPassed = assertionResults.every((r: { passed: boolean }) => r.passed);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const status = allPassed ? 'SUCCESS' : isFinalAttempt ? 'FAILED' : 'PENDING';

    await urlMonitorRepo.updateExecution(executionId, {
      status,
      statusCode: response.status,
      responseTimeMs: responseTime,
      assertionResults,
      endTime: new Date(),
    });

    if (status === 'SUCCESS' || status === 'FAILED') {
      void maybeAlertOnTransition('url', monitor.id, executionId, status, {
        statusCode: response.status,
        durationMs: responseTime,
        errorMessage: allPassed ? null : 'Assertions failed',
        startTime: new Date(startTime),
      });
    }

    if (!allPassed) {
      throw new Error('Assertions failed');
    }

    return { success: true };
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime;
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const detailedMessage = classifyFetchError(error, monitor.url, timeoutMs);

    logger.error(`URL monitor execution ${executionId} failed: ${detailedMessage}`);

    const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
    await urlMonitorRepo.updateExecution(executionId, {
      status: finalStatus,
      errorMessage: detailedMessage,
      responseTimeMs: responseTime,
      endTime: new Date(),
    });

    if (finalStatus === 'FAILED') {
      void maybeAlertOnTransition('url', monitor.id, executionId, 'FAILED', {
        errorMessage: detailedMessage,
        durationMs: responseTime,
        startTime: new Date(startTime),
      });
    }

    throw new Error(detailedMessage);
  }
};
