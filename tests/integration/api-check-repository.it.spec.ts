/**
 * API check repository contract.
 *
 * Covers findById, assertion CRUD, update/updateEnabled, deleteById, and
 * the replaceAssertions delete+insert transaction against the real
 * Postgres schema (api_checks / api_assertions cascade on delete).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { apiCheckRepo } from '../../src/db/repositories/api-check.repo.ts';

const sql = connectDb();
const marker = `api-check-repo-it-${Date.now()}`;
let checkId = -1;

beforeAll(async () => {
  const [check] = await apiCheckRepo.create({
    name: marker,
    url: 'https://example.test/health',
    intervalSeconds: 60,
  });
  checkId = check.id;
}, 30_000);

afterAll(async () => {
  // Cascades api_assertions rows for both checkId and the deleteById test's row.
  const markerPrefix = `${marker}%`;
  await sql`DELETE FROM api_checks WHERE name LIKE ${markerPrefix}`;
  await sql.end();
});

describe('apiCheckRepo', () => {
  test('findById returns the created check', async () => {
    const [check] = await apiCheckRepo.findById(checkId);
    expect(check.name).toBe(marker);
    expect(check.url).toBe('https://example.test/health');
  });

  test('findExecutionsByCheckId projects stalled and latest executions', async () => {
    const [stalled] = await sql<[{ id: number }]>`
      INSERT INTO api_executions (api_check_id, status, start_time)
      VALUES (${checkId}, 'PENDING', NOW() - INTERVAL '200 seconds')
      RETURNING id
    `;
    const [latest] = await apiCheckRepo.createExecution(checkId, 'SUCCESS');

    const executions = await apiCheckRepo.findExecutionsByCheckId(checkId);
    expect(executions.map((e) => e.id)).toEqual([latest.id, stalled.id]);
    // The check's intervalSeconds (60) means a 200s-old PENDING row is stalled → FAILED.
    expect(executions.find((e) => e.id === stalled.id)?.status).toBe('FAILED');
    expect(executions.find((e) => e.id === latest.id)?.status).toBe('SUCCESS');
  });

  test('createAssertion + findAssertionsByCheckId returns the inserted row', async () => {
    const [created] = await apiCheckRepo.createAssertion(checkId, {
      type: 'status_code',
      operator: 'equals',
      value: '200',
    });
    expect(created.apiCheckId).toBe(checkId);

    const assertions = await apiCheckRepo.findAssertionsByCheckId(checkId);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.type).toBe('status_code');
  });

  test('createAssertions bulk inserts multiple rows; empty array short-circuits', async () => {
    const created = await apiCheckRepo.createAssertions(checkId, [
      { type: 'body', operator: 'contains', value: 'ok' },
      { type: 'header', operator: 'exists', path: 'x-request-id' },
    ]);
    expect(created).toHaveLength(2);

    const assertions = await apiCheckRepo.findAssertionsByCheckId(checkId);
    expect(assertions).toHaveLength(3);

    const noop = await apiCheckRepo.createAssertions(checkId, []);
    expect(noop).toEqual([]);
    expect(await apiCheckRepo.findAssertionsByCheckId(checkId)).toHaveLength(3);
  });

  test('update modifies check fields', async () => {
    await apiCheckRepo.update(checkId, {
      name: `${marker}-updated`,
      url: 'https://example.test/updated',
      intervalSeconds: 120,
    });
    const [check] = await apiCheckRepo.findById(checkId);
    expect(check.name).toBe(`${marker}-updated`);
    expect(check.url).toBe('https://example.test/updated');
    expect(check.intervalSeconds).toBe(120);
  });

  test('updateEnabled toggles the enabled flag', async () => {
    await apiCheckRepo.updateEnabled(checkId, false);
    const [check] = await apiCheckRepo.findById(checkId);
    expect(check.enabled).toBe(false);
  });

  test('replaceAssertions atomically swaps old assertions for new ones', async () => {
    // Three assertions from earlier tests exist for this check.
    const before = await apiCheckRepo.findAssertionsByCheckId(checkId);
    expect(before).toHaveLength(3);

    const replaced = await apiCheckRepo.replaceAssertions(checkId, [
      { type: 'status_code', operator: 'equals', value: '204' },
    ]);
    expect(replaced).toHaveLength(1);

    const after = await apiCheckRepo.findAssertionsByCheckId(checkId);
    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe('status_code');
    expect(after[0]?.value).toBe('204');
    // None of the pre-replace ids survived — proves delete actually ran.
    expect(before.map((a) => a.id)).not.toContain(after[0]?.id);
  });

  test('replaceAssertions with an empty array clears all assertions', async () => {
    const replaced = await apiCheckRepo.replaceAssertions(checkId, []);
    expect(replaced).toEqual([]);
    expect(await apiCheckRepo.findAssertionsByCheckId(checkId)).toHaveLength(0);
  });

  test('deleteById removes the check row', async () => {
    const [toDelete] = await apiCheckRepo.create({
      name: `${marker}-to-delete`,
      url: 'https://example.test/delete-me',
    });
    await apiCheckRepo.deleteById(toDelete.id);
    expect(await apiCheckRepo.findById(toDelete.id)).toEqual([]);
  });
});
