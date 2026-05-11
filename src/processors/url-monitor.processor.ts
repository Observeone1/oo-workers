import { Job } from 'bullmq';
import { sql } from '../config/db.ts';
import { logger } from '../utils/logger.ts';
import { evaluateUrlMonitorAssertions } from '../services/assertion.service.ts';

export const urlMonitorProcessor = async (job: Job) => {
  const { executionId, monitor, assertions } = job.data;
  const startTime = Date.now();

  logger.info(`Processing URL Monitor job ${job.id} (Execution: ${executionId})`);

  try {
    const response = await fetch(monitor.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(monitor.timeout_ms || 30000),
    });
    const responseTime = Date.now() - startTime;

    const assertionResults = evaluateUrlMonitorAssertions(assertions || [], response.status);
    const allPassed = assertionResults.every((r: { passed: boolean }) => r.passed);
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts || 1);
    const status = allPassed ? 'SUCCESS' : (isFinalAttempt ? 'FAILED' : 'PENDING');

    await sql`
      UPDATE url_monitor_executions
      SET status            = ${status},
          status_code       = ${response.status},
          response_time_ms  = ${responseTime},
          assertion_results = ${assertionResults}::jsonb,
          end_time          = NOW()
      WHERE id = ${executionId}
    `;

    if (!allPassed) {
      throw new Error('Assertions failed');
    }

    return { success: true };
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime;
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts || 1);
    const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };

    logger.error(`URL monitor execution ${executionId} failed: ${err.message}`);

    let detailedMessage = err.message ?? 'Unknown error';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      detailedMessage = `Request timed out after ${monitor.timeout_ms || 30000}ms`;
    } else if (err.cause) {
      const cause = err.cause;
      if (cause.code === 'ENOTFOUND') {
        detailedMessage = `DNS resolution failed: Host not found (${monitor.url})`;
      } else if (cause.code === 'ECONNREFUSED') {
        detailedMessage = `Connection refused: Target machine actively refused it (${monitor.url})`;
      } else if (cause.code === 'ETIMEDOUT') {
        detailedMessage = `Connection timed out (${monitor.url})`;
      } else if (cause.message) {
        detailedMessage = `Network error: ${cause.message}`;
      }
    }

    await sql`
      UPDATE url_monitor_executions
      SET status            = ${isFinalAttempt ? 'FAILED' : 'PENDING'},
          error_message     = ${detailedMessage},
          response_time_ms  = ${responseTime},
          end_time          = NOW()
      WHERE id = ${executionId}
    `;

    throw new Error(detailedMessage);
  }
};
