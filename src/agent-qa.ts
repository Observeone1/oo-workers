/**
 * QA job handling for the regional agent — Playwright runs, artifact upload,
 * per-test result posts. Extracted from agent.ts to keep the poll loop thin.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig, JobPayload } from './agent.ts';
import type { AgentResultBody } from './services/agent-dispatch.ts';
import { executePlaywrightTest } from './services/playwright.service.ts';
import { logger } from './utils/logger.ts';

type QaDeps = {
  isPlaywrightAvailable: () => Promise<boolean>;
  createQaExecutions: (
    cfg: AgentConfig,
    projectId: number,
    testIds: number[],
  ) => Promise<Map<number, number>>;
  postResult: (cfg: AgentConfig, body: AgentResultBody) => Promise<void>;
  uploadArtifact: (
    cfg: AgentConfig,
    executionId: number,
    kind: string,
    filePath: string,
    size: number,
    contentType: string,
  ) => Promise<string | null>;
};

async function reportLightImageError(
  deps: QaDeps,
  cfg: AgentConfig,
  job: JobPayload,
  firstTestId: number,
): Promise<void> {
  let execMap: Map<number, number>;
  try {
    execMap = await deps.createQaExecutions(cfg, job.projectId!, [firstTestId]);
  } catch (err) {
    logger.error(
      `qa job ${job.jobId} (light image): create-executions failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  const executionId = execMap.get(firstTestId);
  if (!executionId) return;
  await deps.postResult(cfg, {
    type: 'qa',
    executionId,
    status: 'ERROR',
    errorMessage:
      'This agent is the light variant — redeploy with `observeone/oo-agent-qa` to handle QA jobs.',
  });
  logger.error(
    `qa job ${job.jobId}: light image cannot run Playwright; reported ERROR on test ${firstTestId}`,
  );
}

async function uploadQaArtifacts(
  deps: QaDeps,
  cfg: AgentConfig,
  executionId: number,
  artifacts: Array<{ name: string; path: string; contentType: string }>,
): Promise<{ traceUrl: string | null; screenshotUrls: string[] }> {
  let traceUrl: string | null = null;
  const screenshotUrls: string[] = [];
  let screenshotIdx = 0;
  for (const art of artifacts) {
    try {
      const stat = await fs.stat(art.path);
      const kind = art.name === 'trace' ? 'trace' : `screenshot-${++screenshotIdx}`;
      const key = await deps.uploadArtifact(
        cfg,
        executionId,
        kind,
        art.path,
        stat.size,
        art.contentType,
      );
      if (key) {
        if (art.name === 'trace') traceUrl = key;
        else screenshotUrls.push(key);
      }
    } catch (err) {
      logger.warn(
        `qa artifact stat/upload failed for exec ${executionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { traceUrl, screenshotUrls };
}

async function runQaTest(
  deps: QaDeps,
  cfg: AgentConfig,
  job: JobPayload,
  test: { id: number; name: string; script: string },
  executionId: number,
  runDir: string,
): Promise<void> {
  const safeName = test.name.replaceAll(/[^a-z0-9]/gi, '_').toLowerCase();
  const scriptPath = path.join(runDir, `${safeName}.spec.ts`);
  const outputDir = path.join(runDir, `out-${test.id}`);
  await fs.writeFile(scriptPath, test.script);

  const result = await executePlaywrightTest(scriptPath, job.targetUrl ?? '', job.credentials, {
    outputDir,
  });

  let traceUrl: string | null = null;
  let screenshotUrls: string[] = [];
  if (!result.success) {
    const uploaded = await uploadQaArtifacts(deps, cfg, executionId, result.artifacts);
    traceUrl = uploaded.traceUrl;
    screenshotUrls = uploaded.screenshotUrls;
  }

  await deps.postResult(cfg, {
    type: 'qa',
    executionId,
    status: result.success ? 'SUCCESS' : 'FAILED',
    latencyMs: result.duration_ms,
    errorMessage: result.error ?? null,
    traceUrl,
    screenshotUrls: screenshotUrls.length > 0 ? screenshotUrls : null,
  });
}

export async function handleQaJobWithDeps(
  deps: QaDeps,
  cfg: AgentConfig,
  job: JobPayload,
): Promise<void> {
  const tests = job.tests ?? [];
  const projectId = job.projectId;
  if (!projectId || tests.length === 0) {
    logger.warn(`qa job ${job.jobId} missing projectId or tests; skipping`);
    return;
  }

  if (!(await deps.isPlaywrightAvailable())) {
    await reportLightImageError(deps, cfg, job, tests[0].id);
    return;
  }

  let execMap: Map<number, number>;
  try {
    execMap = await deps.createQaExecutions(
      cfg,
      projectId,
      tests.map((t) => t.id),
    );
  } catch (err) {
    logger.error(
      `qa job ${job.jobId}: create-executions failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const runDir = path.resolve(
    import.meta.dir,
    '..',
    'tests',
    `agent-qa-${projectId}-${Date.now()}`,
  );
  await fs.mkdir(runDir, { recursive: true });

  try {
    await Promise.all(
      tests.map(async (test) => {
        const executionId = execMap.get(test.id);
        if (!executionId) {
          logger.warn(`qa job ${job.jobId}: no exec id for test ${test.id}; skipping`);
          return;
        }
        await runQaTest(deps, cfg, job, test, executionId, runDir);
      }),
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}
