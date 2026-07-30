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

const BODY_ALLOWED_METHODS = ['POST', 'PUT', 'PATCH', 'QUERY'];

function buildRequestOptions(apiCheck: any, signal: AbortSignal): RequestInit {
  const headers: Record<string, string> = { ...(apiCheck.headers ?? {}) };
  const requestOptions: RequestInit = {
    method: apiCheck.method || 'GET',
    headers,
    signal,
  };

  if (apiCheck.body && BODY_ALLOWED_METHODS.includes(apiCheck.method)) {
    requestOptions.body =
      typeof apiCheck.body === 'string' ? apiCheck.body : JSON.stringify(apiCheck.body);

    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  return requestOptions;
}

async function finalizeSuccess(params: {
  executionId: number;
  apiCheck: any;
  response: Response;
  responseTime: number;
  body: string;
  responseHeaders: Record<string, string>;
  assertionResults: Awaited<ReturnType<typeof evaluateAssertions>>;
  startTime: number;
  isFinalAttempt: boolean;
}): Promise<{ success: true }> {
  const {
    executionId,
    apiCheck,
    response,
    responseTime,
    body,
    responseHeaders,
    assertionResults,
    startTime,
    isFinalAttempt,
  } = params;

  const allAssertionsPassed = assertionResults.every((r) => r.passed);
  const status = allAssertionsPassed ? 'SUCCESS' : isFinalAttempt ? 'FAILED' : 'PENDING';
  const errorMessage = allAssertionsPassed ? null : 'One or more assertions failed';

  await apiCheckRepo.updateExecution(executionId, {
    status,
    responseStatus: response.status,
    responseTimeMs: responseTime,
    responseBody: body.substring(0, DEFAULTS.RESPONSE_BODY_TRUNCATE_CHARS),
    responseHeaders,
    assertionResults,
    errorMessage,
    endTime: new Date(),
  });
  emitExecution('api', apiCheck.id, {
    id: executionId,
    status,
    statusCode: response.status,
    responseTimeMs: responseTime,
    errorMessage,
  });

  if (status === 'SUCCESS' || status === 'FAILED') {
    void maybeAlertOnTransition('api', apiCheck.id, executionId, status, {
      statusCode: response.status,
      durationMs: responseTime,
      errorMessage,
      startTime: new Date(startTime),
    });
  }

  if (!allAssertionsPassed) {
    throw new Error(errorMessage as string);
  }

  return { success: true };
}

async function finalizeFailure(params: {
  executionId: number;
  apiCheck: any;
  error: unknown;
  responseTime: number;
  timeoutMs: number;
  isFinalAttempt: boolean;
}): Promise<never> {
  const { executionId, apiCheck, error, responseTime, timeoutMs, isFinalAttempt } = params;
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

export const apiCheckProcessor = async (job: Job) => {
  const { executionId, apiCheck, assertions } = job.data;
  const timeoutMs = apiCheck.timeoutMs || DEFAULTS.API_TIMEOUT_MS;

  logger.info(`Processing API Check job ${job.id} (Execution: ${executionId})`);

  // Hoisted so the catch below can persist responseTimeMs on a FAILED/timed-out
  // execution — the old code scoped startTime inside the try and wrote null.
  const startTime = Date.now();
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const requestOptions = buildRequestOptions(apiCheck, controller.signal);

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

    return await finalizeSuccess({
      executionId,
      apiCheck,
      response,
      responseTime,
      body,
      responseHeaders,
      assertionResults,
      startTime,
      isFinalAttempt,
    });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return await finalizeFailure({
      executionId,
      apiCheck,
      error,
      responseTime,
      timeoutMs,
      isFinalAttempt,
    });
  }
};
