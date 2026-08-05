/**
 * QA project repository contract.
 *
 * Covers the project/test/run lifecycle, script storage fallback path, run
 * progress aggregation, one-shot alert claims, and cleanup behavior.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';
import { resetObjectStorageConfigCache } from '../../src/services/object-storage.ts';

const sql = connectDb();
const marker = `qa-repo-it-${Date.now()}`;
let projectId = -1;
let firstTestId = -1;
let secondTestId = -1;

beforeAll(async () => {
  const [project] = await qaProjectRepo.create({
    name: marker,
    targetUrl: 'https://qa.example.test',
    intervalSeconds: 60,
  });
  projectId = project.id;
}, 30_000);

afterAll(async () => {
  if (projectId > 0) await qaProjectRepo.deleteById(projectId);
  await sql.end();
});

describe('qaProjectRepo', () => {
  test('manages tests, executions, run progress, and project projections', async () => {
    const tests = await qaProjectRepo.createTests(projectId, [
      { testName: `${marker}-one`, testType: 'smoke', script: 'test("one", () => expect(1).toBe(1));' },
      { testName: `${marker}-two`, testType: 'regression', script: 'test("two", () => expect(2).toBe(2));' },
    ]);
    firstTestId = tests[0].id;
    secondTestId = tests[1].id;

    expect(await qaProjectRepo.createTests(projectId, [])).toEqual([]);
    expect((await qaProjectRepo.findTestsByProjectId(projectId)).map((test) => test.scriptSize)).toEqual([37, 37]);
    expect((await qaProjectRepo.findTestsByProjectId(projectId, { includeScript: true }))).toHaveLength(2);
    expect(await qaProjectRepo.findTestsByIds(projectId, [firstTestId, secondTestId])).toHaveLength(2);
    expect(await qaProjectRepo.findTestsByIds(projectId, [])).toEqual([]);

    const [run] = await qaProjectRepo.createRun({ projectId, regionId: null, expectedTests: 2 });
    const [success] = await qaProjectRepo.createExecution(firstTestId, projectId, 'SUCCESS', null, run.id);
    const [failed] = await qaProjectRepo.createExecution(secondTestId, projectId, 'FAILED', null, run.id);
    await qaProjectRepo.updateExecution(failed.id, { completedAt: new Date(), errorMessage: 'assertion failed' });
    await qaProjectRepo.updateExecution(success.id, { completedAt: new Date(), durationMs: 12 });

    expect(await qaProjectRepo.runProgress(run.id)).toEqual({ expectedTests: 2, completed: 2, downCount: 1 });
    expect(await qaProjectRepo.claimRunAlert(run.id, 'FAILED')).toBe(true);
    expect(await qaProjectRepo.claimRunAlert(run.id, 'FAILED')).toBe(false);
    expect((await qaProjectRepo.findRunById(run.id))?.outcome).toBe('FAILED');
    expect((await qaProjectRepo.findExecutionsByProjectId(projectId)).map((execution) => execution.id)).toEqual([
      failed.id,
      success.id,
    ]);

    expect((await qaProjectRepo.findAllWithLatest()).find((project) => project.id === projectId)?.testCount).toBe(2);
    expect((await qaProjectRepo.findDue()).some((project) => project.id === projectId)).toBe(true);
    expect(await qaProjectRepo.findExecutionById(failed.id)).toMatchObject({ id: failed.id, projectId });
    expect(await qaProjectRepo.findProjectNameById(projectId)).toBe(marker);
  });

  test('updates the project and first script, then handles region and missing-record lookups', async () => {
    await qaProjectRepo.updateFirstTestScript(projectId, 'updated script');
    await qaProjectRepo.touchLastRunAt(projectId);
    await qaProjectRepo.update(projectId, { name: `${marker}-updated`, targetUrl: 'https://updated.example.test' });
    await qaProjectRepo.updateEnabled(projectId, false);

    expect((await qaProjectRepo.findById(projectId))[0]?.name).toBe(`${marker}-updated`);
    expect((await qaProjectRepo.findTestsByProjectId(projectId)).find((test) => test.id === firstTestId)?.scriptSize).toBe(
      14,
    );
    expect(await qaProjectRepo.isProjectBoundToRegion(projectId, -1)).toBe(false);
    expect(await qaProjectRepo.findRunById(-1)).toBeNull();
    expect(await qaProjectRepo.findExecutionById(-1)).toBeNull();
    expect(await qaProjectRepo.findProjectNameById(-1)).toBeNull();
  });
});

// Object storage is real (RustFS testcontainer, wired by setup.ts) for the
// whole IT suite. These specs deliberately unconfigure/break it for the
// scope of one call — via env + resetObjectStorageConfigCache() — to
// exercise the not-configured and storage-failure fallback branches for
// real, then restore the original env so later tests keep working storage.
describe('qaProjectRepo — object storage fallbacks and failures', () => {
  const STORAGE_ENV_KEYS = [
    'OO_OBJECT_STORAGE_ENDPOINT',
    'OO_OBJECT_STORAGE_REGION',
    'OO_OBJECT_STORAGE_BUCKET',
    'OO_OBJECT_STORAGE_ACCESS_KEY',
    'OO_OBJECT_STORAGE_SECRET_KEY',
    'OO_OBJECT_STORAGE_FORCE_PATH_STYLE',
  ] as const;
  const realEnv: Record<string, string | undefined> = {};
  let storageProjectId = -1;
  let fallbackTestId = -1;

  function restoreStorageEnv(): void {
    for (const k of STORAGE_ENV_KEYS) {
      if (realEnv[k] === undefined) delete process.env[k];
      else process.env[k] = realEnv[k];
    }
    resetObjectStorageConfigCache();
  }

  beforeAll(async () => {
    for (const k of STORAGE_ENV_KEYS) realEnv[k] = process.env[k];
    const [project] = await qaProjectRepo.create({
      name: `${marker}-storage`,
      targetUrl: 'https://qa.example.test',
      intervalSeconds: 60,
    });
    storageProjectId = project.id;
  }, 30_000);

  afterAll(async () => {
    restoreStorageEnv();
    if (storageProjectId > 0) {
      await sql`DELETE FROM qa_projects WHERE id = ${storageProjectId}`.catch(() => {});
    }
  });

  test('findTestsByProjectId returns inline scripts when storage is not configured', async () => {
    const [t] = await qaProjectRepo.createTests(storageProjectId, [
      { testName: 'fallback-test', script: 'inline script body' },
    ]);
    fallbackTestId = t.id;

    for (const k of STORAGE_ENV_KEYS) delete process.env[k];
    resetObjectStorageConfigCache();
    try {
      const rows = await qaProjectRepo.findTestsByProjectId(storageProjectId, { includeScript: true });
      expect(rows.find((r) => r.id === fallbackTestId)).toMatchObject({ script: 'inline script body' });
    } finally {
      restoreStorageEnv();
    }
  });

  test('findTestsByProjectId falls back to the inline script when the storage GET fails', async () => {
    await sql`UPDATE qa_generated_tests SET script_url = 'nonexistent/key/does-not-exist.ts' WHERE id = ${fallbackTestId}`;

    const rows = await qaProjectRepo.findTestsByProjectId(storageProjectId, { includeScript: true });

    expect(rows.find((r) => r.id === fallbackTestId)).toMatchObject({ script: 'inline script body' });
  });

  test('createTests (maybeUploadScripts) logs and leaves script_url null when the storage PUT fails', async () => {
    process.env.OO_OBJECT_STORAGE_ENDPOINT = 'http://127.0.0.1:1';
    resetObjectStorageConfigCache();
    try {
      const [t] = await qaProjectRepo.createTests(storageProjectId, [
        { testName: 'put-fail-test', script: 'unused inline body' },
      ]);
      const [row] = await sql<
        [{ script_url: string | null }]
      >`SELECT script_url FROM qa_generated_tests WHERE id = ${t.id}`;
      expect(row.script_url).toBeNull();
    } finally {
      restoreStorageEnv();
    }
  });

  test('deleteById tolerates a storage DELETE failure and still removes the project row', async () => {
    // Real upload against the real (restored) endpoint, so there is an
    // actual scriptUrl for deleteById to attempt — and fail — to delete.
    const [t] = await qaProjectRepo.createTests(storageProjectId, [
      { testName: 'delete-fail-test', script: 'unused inline body' },
    ]);
    const [row] = await sql<
      [{ script_url: string | null }]
    >`SELECT script_url FROM qa_generated_tests WHERE id = ${t.id}`;
    expect(row.script_url).not.toBeNull();

    process.env.OO_OBJECT_STORAGE_ENDPOINT = 'http://127.0.0.1:1';
    resetObjectStorageConfigCache();
    const deletedProjectId = storageProjectId;
    try {
      await expect(qaProjectRepo.deleteById(storageProjectId)).resolves.toBeUndefined();
    } finally {
      restoreStorageEnv();
      storageProjectId = -1; // already deleted; afterAll must not try again
    }

    const remaining = await sql`SELECT id FROM qa_projects WHERE id = ${deletedProjectId}`;
    expect(remaining).toHaveLength(0);
  });
});
