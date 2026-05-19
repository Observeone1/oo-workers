import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { logger } from '../utils/logger.ts';
import { executePlaywrightTest, type PlaywrightArtifact } from '../services/playwright.service.ts';
import { isStorageConfigured, putObject, qaRunArtifactKey } from '../services/object-storage.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULTS } from '../constants.ts';
import { maybeAlertOnQaRunTransition } from '../services/transition-detector.ts';

// Resolve relative to this source file (project_root/src/processors → project_root/tests).
// Avoids process.cwd() so the worker still works if started from a different dir.
// Must stay inside Playwright's testDir ('./tests') — see playwright.config.ts.
const TESTS_ROOT = path.resolve(import.meta.dir, '../../tests');

interface QATest {
  id: number;
  name: string;
  script: string;
}

interface QAProjectJobData {
  type: 'qa-project-run';
  projectId: number;
  targetUrl: string;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  tests: QATest[];
  triggeredAt: string;
}

interface TestResult {
  testId: number;
  executionId: number;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  errorMessage?: string;
  logs?: string[];
}

/**
 * QA Project Processor factory.
 * Consumes jobs from the qa-project queue, runs Playwright scripts in parallel
 * (scripts stored inline in job data — sourced from qa_generated_tests.script).
 * Takes the shared Redis connection so pub/sub uses one pool, not a private one.
 */
export const createQaProjectProcessor = (redis: Redis) => {
  const publishUpdate = async (projectId: number, data: Record<string, unknown>) => {
    try {
      await redis.publish(
        `qa_project_updates:${projectId}`,
        JSON.stringify({ ...data, timestamp: new Date().toISOString() }),
      );
    } catch (error) {
      logger.error(
        `Failed to publish update: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return async (job: Job<QAProjectJobData>) => {
    const { projectId, targetUrl, credentials, config, tests } = job.data;

    logger.info(`Processing QA Project job ${job.id} (Project: ${projectId})`);
    logger.info(`Running ${tests.length} tests for target: ${targetUrl}`);

    // Redis pub/sub keys stay snake_case for now — separate consumer contract,
    // tracked as a follow-up cleanup. BullMQ payloads + HTTP API are camelCase.
    await publishUpdate(projectId, {
      type: 'run_started',
      project_id: projectId,
      test_count: tests.length,
    });

    const results: TestResult[] = [];
    const startTime = Date.now();

    // Resolve the project name once so artifact keys stay stable across
    // parallel test runs in this job. Falls back to a synthetic name if
    // the project row vanished mid-flight.
    const projectName = await resolveProjectName(projectId);

    // Write all scripts to a per-run directory before any test starts.
    // Using clean names (no id prefix) so sibling imports like import './auth.spec' resolve correctly.
    const runDir = path.join(TESTS_ROOT, `${projectId}-${startTime}`);
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
          const [row] = await qaProjectRepo.createExecution(test.id, projectId, 'running');
          executionId = row.id;
        } catch (createError) {
          const msg = createError instanceof Error ? createError.message : String(createError);
          logger.error(`Failed to create execution for test ${test.id}: ${msg}`);

          await publishUpdate(projectId, {
            type: 'test_update',
            project_id: projectId,
            test_id: test.id,
            test_name: test.name,
            status: 'error',
            error_message: `Failed to create execution: ${msg}`,
          });

          return {
            testId: test.id,
            executionId: 0,
            status: 'error' as const,
            durationMs: 0,
            errorMessage: `Failed to create execution record: ${msg}`,
          };
        }

        await publishUpdate(projectId, {
          type: 'test_update',
          project_id: projectId,
          test_id: test.id,
          test_name: test.name,
          execution_id: executionId,
          status: 'running',
        });

        const testStartTime = Date.now();
        const filePath = fileMap.get(test.id)!;
        const fileName = path.relative(process.cwd(), filePath);
        // Per-execution output dir so parallel test runs don't stomp each
        // other's artifacts. Sits inside the per-project runDir so the
        // existing rm-rf cleanup at the bottom covers it.
        const artifactDir = path.join(runDir, `exec-${executionId}`);

        try {
          const result = await executePlaywrightTest(fileName, targetUrl, credentials, {
            timeout: (config?.timeout as number) || DEFAULTS.QA_RUN_TIMEOUT_MS,
            headless: true,
            viewport: (config?.viewport as { width: number; height: number }) || {
              width: 1280,
              height: 720,
            },
            outputDir: artifactDir,
          });

          const durationMs = result.duration_ms;
          const status = result.success ? 'passed' : 'failed';

          // On failure, upload trace + screenshots to the bucket and stamp
          // the execution row. Skip cleanly when storage isn't configured
          // or no artifacts came back.
          const { traceUrl, screenshotUrls } = !result.success
            ? await uploadArtifacts(projectId, projectName, executionId, result.artifacts)
            : { traceUrl: null, screenshotUrls: null };

          await qaProjectRepo.updateExecution(executionId, {
            status,
            completedAt: new Date(),
            durationMs,
            errorMessage: result.error ?? null,
            logs: result.logs?.join('\n') ?? null,
            traceUrl,
            screenshotUrls,
          });

          await publishUpdate(projectId, {
            type: 'test_update',
            project_id: projectId,
            test_id: test.id,
            test_name: test.name,
            execution_id: executionId,
            status,
            duration_ms: durationMs,
            error_message: result.error,
          });

          return {
            testId: test.id,
            executionId,
            status: status as 'passed' | 'failed',
            durationMs,
            errorMessage: result.error,
            logs: result.logs,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const durationMs = Date.now() - testStartTime;
          logger.error(`Test ${test.id} execution failed: ${errorMessage}`);

          await qaProjectRepo.updateExecution(executionId, {
            status: 'error',
            completedAt: new Date(),
            durationMs,
            errorMessage,
          });

          await publishUpdate(projectId, {
            type: 'test_update',
            project_id: projectId,
            test_id: test.id,
            test_name: test.name,
            execution_id: executionId,
            status: 'error',
            duration_ms: durationMs,
            error_message: errorMessage,
          });

          return {
            testId: test.id,
            executionId,
            status: 'error' as const,
            durationMs,
            errorMessage,
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

      await qaProjectRepo.touchLastRunAt(projectId);

      // QA alerting: per-project-run aggregate (all tests passed = up,
      // any failed/errored = down) vs the previous run's aggregate.
      // Best-effort — never blocks run completion.
      const aggregateOutcome = errors > 0 || failed > 0 ? 'FAILED' : 'SUCCESS';
      await maybeAlertOnQaRunTransition(projectId, new Date(startTime), aggregateOutcome);

      const completionData = {
        type: 'run_completed',
        project_id: projectId,
        results: { total: tests.length, passed, failed, errors, duration_ms: totalDuration },
      };

      await publishUpdate(projectId, completionData);

      logger.info(
        `QA Project ${projectId} run completed: passed=${passed}, failed=${failed}, errors=${errors}`,
      );

      return {
        success: true,
        projectId,
        type: 'run_completed',
        results: completionData.results,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`QA Project ${projectId} run failed: ${msg}`);
      await fs.rm(runDir, { recursive: true, force: true });
      throw error;
    }
  };
};

/**
 * Look up the QA project name by id. Used to slug it into artifact keys so
 * the bucket layout stays human-readable. Falls back to a synthetic name
 * if the row is gone (project deleted mid-run) — the upload still
 * succeeds and the orphan sweep cleans up later.
 */
async function resolveProjectName(projectId: number): Promise<string> {
  try {
    const [row] = await qaProjectRepo.findById(projectId);
    return row?.name ?? `project-${projectId}`;
  } catch {
    return `project-${projectId}`;
  }
}

/**
 * Upload trace + screenshot artifacts for one execution. Best-effort: a
 * failed upload logs and returns whatever succeeded; the boot-time orphan
 * sweep is the durable backstop. Returns the stored keys for stamping
 * onto the qa_test_executions row.
 */
async function uploadArtifacts(
  projectId: number,
  projectName: string,
  executionId: number,
  artifacts: PlaywrightArtifact[],
): Promise<{ traceUrl: string | null; screenshotUrls: string[] | null }> {
  if (!isStorageConfigured() || artifacts.length === 0) {
    return { traceUrl: null, screenshotUrls: null };
  }
  let traceUrl: string | null = null;
  const screenshotUrls: string[] = [];
  let screenshotIndex = 0;
  for (const art of artifacts) {
    try {
      const body = await fs.readFile(art.path);
      if (art.name === 'trace') {
        const key = qaRunArtifactKey(projectId, projectName, executionId, 'trace.zip');
        await putObject(key, body, art.contentType);
        traceUrl = key;
      } else if (art.name === 'screenshot') {
        screenshotIndex += 1;
        const key = qaRunArtifactKey(
          projectId,
          projectName,
          executionId,
          `screenshot-${screenshotIndex}.png`,
        );
        await putObject(key, body, art.contentType);
        screenshotUrls.push(key);
      }
      // Video / other named attachments deferred until v1.3+.
    } catch (err) {
      logger.error(
        `qa-run-artifact upload failed for execution ${executionId} (${art.name}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return {
    traceUrl,
    screenshotUrls: screenshotUrls.length > 0 ? screenshotUrls : null,
  };
}
