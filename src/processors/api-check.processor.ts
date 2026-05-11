import { Job } from 'bullmq';
import { sql } from '../config/db.ts';
import { logger } from '../utils/logger.ts';
import { evaluateAssertions } from '../services/assertion.service.ts';

export const apiCheckProcessor = async (job: Job) => {
  const { executionId, apiCheck, assertions } = job.data;

  logger.info(`Processing API Check job ${job.id} (Execution: ${executionId})`);

  try {
    const headers: Record<string, string> = {};

    if (apiCheck.headers) {
      try {
        const parsedHeaders = typeof apiCheck.headers === 'string'
          ? JSON.parse(apiCheck.headers)
          : apiCheck.headers;
        Object.assign(headers, parsedHeaders);
      } catch {
        logger.warn(`Failed to parse headers for API check ${apiCheck.id}`);
      }
    }

    const requestOptions: RequestInit = {
      method: apiCheck.method || 'GET',
      headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), apiCheck.timeout_ms || 5000);
    requestOptions.signal = controller.signal;

    if (apiCheck.body && ['POST', 'PUT', 'PATCH'].includes(apiCheck.method)) {
      requestOptions.body = typeof apiCheck.body === 'string'
        ? apiCheck.body
        : JSON.stringify(apiCheck.body);

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

    const allAssertionsPassed = assertionResults.length === 0 || assertionResults.every(r => r.passed);
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts || 1);
    const status = allAssertionsPassed ? 'SUCCESS' : (isFinalAttempt ? 'FAILED' : 'PENDING');

    await sql`
      UPDATE api_executions
      SET status            = ${status},
          response_status   = ${response.status},
          response_time_ms  = ${responseTime},
          response_body     = ${body.substring(0, 5000)},
          response_headers  = ${sql.json(responseHeaders)},
          assertion_results = ${sql.json(assertionResults)},
          error_message     = ${allAssertionsPassed ? null : 'One or more assertions failed'},
          end_time          = NOW()
      WHERE id = ${executionId}
    `;

    if (!allAssertionsPassed) {
      throw new Error('One or more assertions failed');
    }

    return { success: true };
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts || 1);

    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        errorMessage = `Request timed out after ${apiCheck.timeout_ms || 5000}ms`;
      } else if ('cause' in error && error.cause) {
        const cause = error.cause as { code?: string; message?: string };
        if (cause.code === 'ENOTFOUND') {
          errorMessage = `DNS resolution failed: Host not found (${apiCheck.url})`;
        } else if (cause.code === 'ECONNREFUSED') {
          errorMessage = `Connection refused: Target machine actively refused it (${apiCheck.url})`;
        } else if (cause.code === 'ETIMEDOUT') {
          errorMessage = `Connection timed out (${apiCheck.url})`;
        } else if (cause.message) {
          errorMessage = `Network error: ${cause.message}`;
        }
      }
    }

    logger.error(`API check execution ${executionId} failed: ${errorMessage}`);

    await sql`
      UPDATE api_executions
      SET status        = ${isFinalAttempt ? 'FAILED' : 'PENDING'},
          error_message = ${errorMessage},
          end_time      = NOW()
      WHERE id = ${executionId}
    `;

    throw new Error(errorMessage);
  }
};
