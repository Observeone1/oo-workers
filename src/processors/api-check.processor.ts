import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { logger } from '../utils/logger.ts';
import { classifyFetchError } from '../utils/fetch-errors.ts';
import { evaluateAssertions } from '../services/api-assertion.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { emitExecution } from '../services/exec-events.ts';

export const apiCheckProcessor = async (job: Job) => {
  const { executionId, apiCheck, assertions } = job.data;
  const timeoutMs = apiCheck.timeoutMs || DEFAULTS.API_TIMEOUT_MS;

  logger.info(`Processing API Check job ${job.id} (Execution: ${executionId})`);

  try {
    const headers: Record<string, string> = { ...(apiCheck.headers ?? {}) };

    const requestOptions: RequestInit = {
      method: apiCheck.method || 'GET',
      headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    requestOptions.signal = controller.signal;

    if (apiCheck.body && ['POST', 'PUT', 'PATCH'].includes(apiCheck.method)) {
      requestOptions.body =
        typeof apiCheck.body === 'string' ? apiCheck.body : JSON.stringify(apiCheck.body);

      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startTime = Date.now();
    const response = await fetch(apiCheck.url, requestOptions);
    clearTimeout(timeout);

    const responseTime = Date.now() - startTime;
    const body = await response.text();

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const assertionResults = await evaluateAssertions(assertions || [], {
      status: response.status,
      responseTime,
      body,
      headers: responseHeaders,
    });

    const allAssertionsPassed =
      assertionResults.length === 0 || assertionResults.every((r) => r.passed);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const status = allAssertionsPassed ? 'SUCCESS' : isFinalAttempt ? 'FAILED' : 'PENDING';

    await apiCheckRepo.updateExecution(executionId, {
      status,
      responseStatus: response.status,
      responseTimeMs: responseTime,
      responseBody: body.substring(0, DEFAULTS.RESPONSE_BODY_TRUNCATE_CHARS),
      responseHeaders,
      assertionResults,
      errorMessage: allAssertionsPassed ? null : 'One or more assertions failed',
      endTime: new Date(),
    });
    emitExecution('api', apiCheck.id, {
      id: executionId,
      status,
      statusCode: response.status,
      responseTimeMs: responseTime,
      errorMessage: allAssertionsPassed ? null : 'One or more assertions failed',
    });

    if (status === 'SUCCESS' || status === 'FAILED') {
      void maybeAlertOnTransition('api', apiCheck.id, executionId, status, {
        statusCode: response.status,
        durationMs: responseTime,
        errorMessage: allAssertionsPassed ? null : 'One or more assertions failed',
        startTime: new Date(startTime),
      });
    }

    if (!allAssertionsPassed) {
      throw new Error('One or more assertions failed');
    }

    return { success: true };
  } catch (error) {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const errorMessage = classifyFetchError(error, apiCheck.url, timeoutMs);

    logger.error(`API check execution ${executionId} failed: ${errorMessage}`);

    const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
    await apiCheckRepo.updateExecution(executionId, {
      status: finalStatus,
      errorMessage,
      endTime: new Date(),
    });
    emitExecution('api', apiCheck.id, {
      id: executionId,
      status: finalStatus,
      errorMessage,
    });

    if (finalStatus === 'FAILED') {
      void maybeAlertOnTransition('api', apiCheck.id, executionId, 'FAILED', {
        errorMessage,
      });
    }

    throw new Error(errorMessage);
  }
};
