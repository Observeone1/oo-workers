import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from '../config/db.ts';
import { logger } from '../utils/logger.ts';
import { executePlaywrightTest } from '../services/playwright.service.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

interface QATest {
  id: number;
  name: string;
  script: string; // inline Playwright spec content (was: script_url)
}

interface QAProjectJobData {
  type: 'qa-project-run';
  project_id: number;
  target_url: string;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  tests: QATest[];
  triggered_at: string;
}

interface TestResult {
  testId: number;
  executionId: number;
  status: 'passed' | 'failed' | 'error';
  duration_ms: number;
  error_message?: string;
  logs?: string[];
}

// Redis publisher for real-time updates
let redisPublisher: Redis | null = null;

function getRedisPublisher(): Redis {
  if (!redisPublisher) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
    redisPublisher.on('connect', () => logger.info('📡 Redis publisher connected'));
    redisPublisher.on('error', (err) => logger.error(`Redis publisher error: ${err.message}`));
  }
  return redisPublisher;
}

async function publishUpdate(projectId: number, data: Record<string, unknown>): Promise<void> {
  try {
    const redis = getRedisPublisher();
    const channel = `qa_project_updates:${projectId}`;
    await redis.publish(channel, JSON.stringify({ ...data, timestamp: new Date().toISOString() }));
  } catch (error) {
    logger.error(`Failed to publish update: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * QA Project Processor
 * Consumes jobs from the qa-project queue, runs Playwright scripts in parallel
 * (scripts stored inline in job data — sourced from qa_generated_tests.script).
 */
export const qaProjectProcessor = async (job: Job<QAProjectJobData>) => {
  const { project_id, target_url, credentials, config, tests } = job.data;

  logger.info(`Processing QA Project job ${job.id} (Project: ${project_id})`);
  logger.info(`Running ${tests.length} tests for target: ${target_url}`);

  await publishUpdate(project_id, {
    type: 'run_started',
    project_id,
    test_count: tests.length,
  });

  const results: TestResult[] = [];
  const startTime = Date.now();

  try {
    const testPromises = tests.map(async (test) => {
      // INSERT execution row
      let executionId: number;
      try {
        const [row] = await sql<{ id: number }[]>`
          INSERT INTO qa_test_executions (test_id, project_id, status)
          VALUES (${test.id}, ${project_id}, 'running')
          RETURNING id
        `;
        executionId = row.id;
      } catch (createError) {
        const msg = createError instanceof Error ? createError.message : String(createError);
        logger.error(`Failed to create execution for test ${test.id}: ${msg}`);

        await publishUpdate(project_id, {
          type: 'test_update',
          project_id,
          test_id: test.id,
          test_name: test.name,
          status: 'error',
          error_message: `Failed to create execution: ${msg}`,
        });

        return {
          testId: test.id,
          executionId: 0,
          status: 'error' as const,
          duration_ms: 0,
          error_message: `Failed to create execution record: ${msg}`,
        };
      }

      await publishUpdate(project_id, {
        type: 'test_update',
        project_id,
        test_id: test.id,
        test_name: test.name,
        execution_id: executionId,
        status: 'running',
      });

      const testStartTime = Date.now();

      // Write script to temp file (Playwright runs files, not strings)
      const tempDir = path.join(process.cwd(), 'tests');
      await fs.mkdir(tempDir, { recursive: true });
      const safeTestName = test.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const fileName = `${test.id}-${safeTestName}.spec.ts`;
      const tempFilePath = path.join(tempDir, fileName);
      await fs.writeFile(tempFilePath, test.script);

      try {
        const result = await executePlaywrightTest(
          fileName,
          target_url,
          credentials,
          {
            timeout: (config?.timeout as number) || 30000,
            headless: true,
            viewport: (config?.viewport as { width: number; height: number }) || { width: 1280, height: 720 },
          },
        );

        const duration_ms = result.duration_ms;
        const status = result.success ? 'passed' : 'failed';

        await sql`
          UPDATE qa_test_executions
          SET status        = ${status},
              completed_at  = NOW(),
              duration_ms   = ${duration_ms},
              error_message = ${result.error || null},
              logs          = ${result.logs?.join('\n') || null}
          WHERE id = ${executionId}
        `;

        await publishUpdate(project_id, {
          type: 'test_update',
          project_id,
          test_id: test.id,
          test_name: test.name,
          execution_id: executionId,
          status,
          duration_ms,
          error_message: result.error,
        });

        return {
          testId: test.id,
          executionId,
          status: status as 'passed' | 'failed',
          duration_ms,
          error_message: result.error,
          logs: result.logs,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const duration_ms = Date.now() - testStartTime;
        logger.error(`Test ${test.id} execution failed: ${errorMessage}`);

        await sql`
          UPDATE qa_test_executions
          SET status        = 'error',
              completed_at  = NOW(),
              duration_ms   = ${duration_ms},
              error_message = ${errorMessage}
          WHERE id = ${executionId}
        `;

        await publishUpdate(project_id, {
          type: 'test_update',
          project_id,
          test_id: test.id,
          test_name: test.name,
          execution_id: executionId,
          status: 'error',
          duration_ms,
          error_message: errorMessage,
        });

        return {
          testId: test.id,
          executionId,
          status: 'error' as const,
          duration_ms,
          error_message: errorMessage,
        };
      } finally {
        try {
          await fs.unlink(tempFilePath);
        } catch (e) {
          logger.warn(`Failed to cleanup temp file ${tempFilePath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });

    const testResults = await Promise.all(testPromises);
    results.push(...testResults);

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const errors = results.filter((r) => r.status === 'error').length;
    const totalDuration = Date.now() - startTime;

    await sql`
      UPDATE qa_projects
      SET last_run_at = NOW()
      WHERE id = ${project_id}
    `;

    const completionData = {
      type: 'run_completed',
      project_id,
      results: { total: tests.length, passed, failed, errors, duration_ms: totalDuration },
    };

    await publishUpdate(project_id, completionData);

    logger.info(`QA Project ${project_id} run completed: passed=${passed}, failed=${failed}, errors=${errors}`);

    return {
      success: true,
      project_id,
      type: 'run_completed',
      results: completionData.results,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`QA Project ${project_id} run failed: ${msg}`);
    throw error;
  }
};

async function cleanup() {
  if (redisPublisher) {
    await redisPublisher.quit();
    redisPublisher = null;
  }
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
