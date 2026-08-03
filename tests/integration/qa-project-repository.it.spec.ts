/**
 * QA project repository contract.
 *
 * Covers the project/test/run lifecycle, script storage fallback path, run
 * progress aggregation, one-shot alert claims, and cleanup behavior.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';

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
