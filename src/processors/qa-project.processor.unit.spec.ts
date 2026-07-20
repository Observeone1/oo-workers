/**
 * QA project processor contract — the BullMQ job handler built by
 * createQaProjectProcessor.
 *
 * The factory takes the Redis connection, so pub/sub is injected rather
 * than mocked at the module boundary. Playwright, object storage, the
 * repo and the transition detector are mocked at their module edges;
 * the artifact key helper (qaRunArtifactKey) is kept real so the specs
 * assert the keys actually written.
 *
 * The handler really does write the test scripts to disk under
 * <repo>/tests/<projectId>-<startTime> and remove the directory
 * afterwards, so the specs also check that cleanup happens.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  execEventsMock,
  mockExecEvents,
  mockObjectStorage,
  mockPlaywrightService,
  mockQaProjectRepo,
  mockTransitionDetector,
  objectStorageMock,
  playwrightServiceMock,
  qaProjectRepoMock,
  resetObjectStorageMock,
  transitionDetectorMock,
} from '../test-support/shared-mocks.ts';

type Row = Record<string, unknown>;

mockQaProjectRepo();
mockPlaywrightService();
mockObjectStorage();
mockTransitionDetector();
mockExecEvents();

const qaProjectRepo = qaProjectRepoMock;
const { executePlaywrightTest } = playwrightServiceMock;
const { putObject } = objectStorageMock;
const { maybeAlertOnQaRunTransition } = transitionDetectorMock;
const { emitExecution } = execEventsMock;

const { createQaProjectProcessor } = await import('./qa-project.processor.ts');

const TESTS_ROOT = resolve(import.meta.dir, '../../tests');

const published: { channel: string; payload: Row }[] = [];
const redis = {
  publish: mock(async (channel: string, raw: string) => {
    published.push({ channel, payload: JSON.parse(raw) as Row });
    return 1;
  }),
};

function makeJob(tests: Row[], over: Row = {}) {
  return {
    id: 'job-1',
    data: {
      projectId: 1,
      targetUrl: 'https://shop.test',
      credentials: undefined,
      config: {},
      tests,
      ...over,
    },
  };
}

const TEST_A = { id: 10, name: 'Checkout Flow', script: 'test("a", () => {})' };
const TEST_B = { id: 11, name: 'Login', script: 'test("b", () => {})' };

/** Run-dir names present under tests/ (the handler must leave none behind). */
async function runDirs(): Promise<string[]> {
  const entries = await readdir(TESTS_ROOT).catch(() => [] as string[]);
  return entries.filter((e) => /^\d+-\d+$/.test(e));
}

function updatesFor(status: string): Row[] {
  return published.map((p) => p.payload).filter((p) => p.status === status);
}

beforeEach(() => {
  published.length = 0;
  // Shared registrations: prime our own behaviour every time.
  resetObjectStorageMock();
  for (const m of [
    qaProjectRepo.findById,
    qaProjectRepo.createRun,
    qaProjectRepo.createExecution,
    qaProjectRepo.updateExecution,
    qaProjectRepo.touchLastRunAt,
    qaProjectRepo.claimRunAlert,
    executePlaywrightTest,
    maybeAlertOnQaRunTransition,
    emitExecution,
    redis.publish,
  ]) {
    m.mockReset();
  }
  qaProjectRepo.findById.mockResolvedValue([{ id: 1, name: 'Shop Front' }]);
  qaProjectRepo.createRun.mockResolvedValue([{ id: 900 }]);
  qaProjectRepo.createExecution.mockResolvedValue([{ id: 500 }]);
  qaProjectRepo.updateExecution.mockResolvedValue(undefined);
  qaProjectRepo.touchLastRunAt.mockResolvedValue(undefined);
  qaProjectRepo.claimRunAlert.mockResolvedValue(true);
  executePlaywrightTest.mockResolvedValue({
    success: true,
    error: null,
    logs: ['ok'],
    artifacts: [],
    duration_ms: 12,
  });
  putObject.mockResolvedValue(undefined);
  maybeAlertOnQaRunTransition.mockResolvedValue(undefined);
  redis.publish.mockImplementation(async (channel: string, raw: string) => {
    published.push({ channel, payload: JSON.parse(raw) as Row });
    return 1;
  });
});

afterEach(async () => {
  // Belt and braces: the handler cleans up, but a thrown test must not
  // leave generated .spec.ts files sitting in tests/.
  const { rm } = await import('node:fs/promises');
  for (const d of await runDirs()) {
    await rm(resolve(TESTS_ROOT, d), { recursive: true, force: true });
  }
});

describe('createQaProjectProcessor — successful run', () => {
  test('opens a master run, executes every test and reports the aggregate', async () => {
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A, TEST_B]) as never);

    // A master run groups the executions (region_id null).
    expect(qaProjectRepo.createRun).toHaveBeenCalledWith({
      projectId: 1,
      regionId: null,
      expectedTests: 2,
    });
    expect(executePlaywrightTest).toHaveBeenCalledTimes(2);
    expect(qaProjectRepo.updateExecution).toHaveBeenCalledTimes(2);
    expect(qaProjectRepo.touchLastRunAt).toHaveBeenCalledWith(1);
    expect(out).toMatchObject({
      success: true,
      projectId: 1,
      type: 'run_completed',
      results: { total: 2, passed: 2, failed: 0, errors: 0 },
    });
  });

  test('publishes run_started, a running/passed pair per test and run_completed', async () => {
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(published[0].channel).toBe('qa_project_updates:1');
    expect(published[0].payload).toMatchObject({ type: 'run_started', test_count: 1 });
    expect(updatesFor('running')).toHaveLength(1);
    expect(updatesFor('passed')).toHaveLength(1);
    expect(published.at(-1)?.payload).toMatchObject({
      type: 'run_completed',
      results: { total: 1, passed: 1, failed: 0, errors: 0 },
    });
    // Every payload carries a timestamp.
    expect(published.every((p) => typeof p.payload.timestamp === 'string')).toBe(true);
  });

  test('claims the run alert once and fires the transition on a clean run', async () => {
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(qaProjectRepo.claimRunAlert).toHaveBeenCalledWith(900, 'SUCCESS');
    expect(maybeAlertOnQaRunTransition).toHaveBeenCalledWith(900);
  });

  test('does not alert when the run alert was already claimed', async () => {
    qaProjectRepo.claimRunAlert.mockResolvedValue(false);
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(maybeAlertOnQaRunTransition).not.toHaveBeenCalled();
  });

  test('removes the generated run directory afterwards', async () => {
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(await runDirs()).toHaveLength(0);
  });
});

describe('createQaProjectProcessor — failures and errors', () => {
  test('a failing test marks the run FAILED and uploads its artifacts', async () => {
    executePlaywrightTest.mockResolvedValue({
      success: false,
      error: 'expected 200',
      logs: ['boom'],
      artifacts: [
        { name: 'trace', path: `${TESTS_ROOT}/../package.json`, contentType: 'application/zip' },
        { name: 'screenshot', path: `${TESTS_ROOT}/../package.json`, contentType: 'image/png' },
      ],
      duration_ms: 30,
    });
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    expect(out).toMatchObject({ results: { passed: 0, failed: 1, errors: 0 } });
    expect(qaProjectRepo.claimRunAlert).toHaveBeenCalledWith(900, 'FAILED');
    // Real qaRunArtifactKey, slugged from the project name.
    expect(putObject.mock.calls.map((c) => c[0])).toEqual([
      'qa-projects/1-shop-front/runs/500/trace.zip',
      'qa-projects/1-shop-front/runs/500/screenshot-1.png',
    ]);
    const [, patch] = qaProjectRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({
      status: 'failed',
      errorMessage: 'expected 200',
      traceUrl: 'qa-projects/1-shop-front/runs/500/trace.zip',
      screenshotUrls: ['qa-projects/1-shop-front/runs/500/screenshot-1.png'],
    });
  });

  test('a passing test uploads nothing', async () => {
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(putObject).not.toHaveBeenCalled();
    const [, patch] = qaProjectRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'passed', traceUrl: null, screenshotUrls: null });
  });

  test('skips artifact upload when object storage is not configured', async () => {
    objectStorageMock.configured.value = false;
    executePlaywrightTest.mockResolvedValue({
      success: false,
      error: 'nope',
      logs: [],
      artifacts: [{ name: 'trace', path: 'x', contentType: 'application/zip' }],
      duration_ms: 5,
    });
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(putObject).not.toHaveBeenCalled();
    const [, patch] = qaProjectRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ traceUrl: null, screenshotUrls: null });
  });

  test('an unreadable artifact is logged and does not sink the execution', async () => {
    executePlaywrightTest.mockResolvedValue({
      success: false,
      error: 'nope',
      logs: [],
      artifacts: [
        { name: 'trace', path: '/definitely/missing.zip', contentType: 'application/zip' },
      ],
      duration_ms: 5,
    });
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    expect(out).toMatchObject({ results: { failed: 1 } });
    expect(putObject).not.toHaveBeenCalled();
    const [, patch] = qaProjectRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'failed', traceUrl: null });
  });

  test('a thrown playwright run becomes an error execution, not a crash', async () => {
    executePlaywrightTest.mockRejectedValue(new Error('browser crashed'));
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    expect(out).toMatchObject({ results: { passed: 0, failed: 0, errors: 1 } });
    const [, patch] = qaProjectRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'error', errorMessage: 'browser crashed' });
    expect(emitExecution).toHaveBeenCalledWith(
      'qa',
      1,
      expect.objectContaining({ status: 'error' }),
    );
    expect(updatesFor('error')).toHaveLength(1);
  });

  test('a test whose execution row cannot be created is reported and skipped', async () => {
    qaProjectRepo.createExecution.mockRejectedValueOnce(new Error('deadlock'));
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    expect(out).toMatchObject({ results: { errors: 1 } });
    // No playwright run and no row update for a test with no execution row.
    expect(executePlaywrightTest).not.toHaveBeenCalled();
    expect(qaProjectRepo.updateExecution).not.toHaveBeenCalled();
    expect(updatesFor('error')[0]).toMatchObject({
      test_id: 10,
      error_message: 'Failed to create execution: deadlock',
    });
  });

  test('mixed outcomes are counted independently', async () => {
    qaProjectRepo.createExecution
      .mockResolvedValueOnce([{ id: 501 }])
      .mockResolvedValueOnce([{ id: 502 }]);
    executePlaywrightTest
      .mockResolvedValueOnce({
        success: true,
        error: null,
        logs: [],
        artifacts: [],
        duration_ms: 1,
      })
      .mockRejectedValueOnce(new Error('boom'));
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A, TEST_B]) as never);

    expect(out).toMatchObject({ results: { total: 2, passed: 1, failed: 0, errors: 1 } });
    expect(qaProjectRepo.claimRunAlert).toHaveBeenCalledWith(900, 'FAILED');
  });

  test('rethrows and cleans up when the run row cannot be created', async () => {
    qaProjectRepo.createRun.mockRejectedValue(new Error('db gone'));
    const handler = createQaProjectProcessor(redis as never);

    const err = await handler(makeJob([TEST_A]) as never).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('db gone');
    expect(await runDirs()).toHaveLength(0);
  });
});

describe('createQaProjectProcessor — resilience', () => {
  test('a redis publish failure never blocks the run', async () => {
    redis.publish.mockRejectedValue(new Error('redis down'));
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    expect(out).toMatchObject({ success: true, results: { passed: 1 } });
  });

  test('falls back to a synthetic project name when the row is gone', async () => {
    qaProjectRepo.findById.mockResolvedValue([]);
    executePlaywrightTest.mockResolvedValue({
      success: false,
      error: 'x',
      logs: [],
      artifacts: [
        { name: 'trace', path: `${TESTS_ROOT}/../package.json`, contentType: 'application/zip' },
      ],
      duration_ms: 1,
    });
    const handler = createQaProjectProcessor(redis as never);

    await handler(makeJob([TEST_A]) as never);

    expect(putObject.mock.calls[0][0]).toBe('qa-projects/1-project-1/runs/500/trace.zip');
  });

  test('falls back to a synthetic project name when the lookup throws', async () => {
    qaProjectRepo.findById.mockRejectedValue(new Error('db blip'));
    const handler = createQaProjectProcessor(redis as never);

    const out = await handler(makeJob([TEST_A]) as never);

    // The lookup is best effort; the run still completes.
    expect(out).toMatchObject({ success: true });
  });
});
