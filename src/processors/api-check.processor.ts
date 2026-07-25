import { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { logger } from '../utils/logger.ts';
import { classifyFetchError } from '../utils/fetch-errors.ts';
import { evaluateAssertions } from '../services/api-assertion.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { emitExecution } from '../services/exec-events.ts';

/**
 * Read a response body as text, capped at `maxBytes`. Bounds memory on a huge
 * response; combined with the still-armed abort timer in the caller, it also
 * bounds a slow-drip one. Excess is discarded and the stream cancelled.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
    }
  } finally {
    text += decoder.decode();
    await reader.cancel().catch(() => {});
  }
  return text;
}

export const apiCheckProcessor = async (job: Job) => {
  const { executionId, apiCheck, assertions } = job.data;
  const timeoutMs = apiCheck.timeoutMs || DEFAULTS.API_TIMEOUT_MS;

  logger.info(`Processing API Check job ${job.id} (Execution: ${executionId})`);

  // Hoisted so the catch below can persist responseTimeMs on a FAILED/timed-out
  // execution — the old code scoped startTime inside the try and wrote null.
  const startTime = Date.now();
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

    let response: Response;
    let body: string;
    try {
      response = await fetch(apiCheck.url, requestOptions);
      // Read the body while the abort timer is still armed and cap the bytes,
      // so a slow-drip or huge response can't hang or OOM the worker.
      body = await readBodyCapped(response, DEFAULTS.RESPONSE_BODY_MAX_BYTES);
    } finally {
      // Always clear the timer — including on a non-abort fetch failure, which
      // the old success-only clearTimeout() leaked until it fired.
      clearTimeout(timeout);
    }

    const responseTime = Date.now() - startTime;

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

    const allAssertionsPassed = assertionResults.every((r) => r.passed);
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
    const responseTime = Date.now() - startTime;
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const errorMessage = classifyFetchError(error, apiCheck.url, timeoutMs);

    logger.error(`API check execution ${executionId} failed: ${errorMessage}`);

    const finalStatus = isFinalAttempt ? 'FAILED' : 'PENDING';
    await apiCheckRepo.updateExecution(executionId, {
      status: finalStatus,
      responseTimeMs: responseTime,
      errorMessage,
      endTime: new Date(),
    });
    emitExecution('api', apiCheck.id, {
      id: executionId,
      status: finalStatus,
      responseTimeMs: responseTime,
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
