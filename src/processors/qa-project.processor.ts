import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { logger } from '../utils/logger.ts';
import { executePlaywrightTest } from '../services/playwright.service.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

interface QATest {
  id: number;
  name: string;
  script: string;
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

  // Write all scripts to a per-run directory before any test starts.
  // Using clean names (no id prefix) so sibling imports like import './auth.spec' resolve correctly.
  const runDir = path.join(process.cwd(), 'tests', `${project_id}-${startTime}`);
  await fs.mkdir(runDir, { recursive: true });

  const fileMap = new Map<number, string>(); // test.id → absolute path
  for (const test of tests) {
    const safeTestName = test.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filePath = path.join(runDir, `${safeTestName}.spec.ts`);
    await fs.writeFile(filePath, test.script);
    fileMap.set(test.id, filePath);
  }

  try {
    const testPromises = tests.map(async (test) => {
      // INSERT execution row
      let executionId: number;
      try {
        const [row] = await qaProjectRepo.createExecution(test.id, project_id, 'running');
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
      const filePath = fileMap.get(test.id)!;
      const fileName = path.relative(process.cwd(), filePath);

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

        await qaProjectRepo.updateExecution(executionId, {
          status,
          completedAt: new Date(),
          durationMs: duration_ms,
          errorMessage: result.error ?? null,
          logs: result.logs?.join('\n') ?? null,
        });

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

        await qaProjectRepo.updateExecution(executionId, {
          status: 'error',
          completedAt: new Date(),
          durationMs: duration_ms,
          errorMessage,
        });

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
      }
    });

    const testResults = await Promise.all(testPromises);
    results.push(...testResults);

    await fs.rm(runDir, { recursive: true, force: true });

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const errors = results.filter((r) => r.status === 'error').length;
    const totalDuration = Date.now() - startTime;

    await qaProjectRepo.touchLastRunAt(project_id);

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
    await fs.rm(runDir, { recursive: true, force: true });
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
