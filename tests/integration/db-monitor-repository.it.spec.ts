/**
 * Database monitor repository contract.
 *
 * Covers CRUD, latest/stalled execution projection, and due-monitor
 * selection against the real Postgres schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { dbMonitorRepo } from '../../src/db/repositories/db-monitor.repo.ts';

const sql = connectDb();
const marker = `db-repo-it-${Date.now()}`;
let monitorId = -1;

beforeAll(async () => {
  const [monitor] = await dbMonitorRepo.create({
    name: marker,
    protocol: 'postgres',
    host: 'db.example.test',
    port: 5432,
    intervalSeconds: 60,
  });
  monitorId = monitor.id;
}, 30_000);

afterAll(async () => {
  if (monitorId > 0) {
    await sql`DELETE FROM db_monitors WHERE id = ${monitorId}`;
  }
  await sql.end();
});

describe('dbMonitorRepo', () => {
  test('projects latest and stalled executions and selects enabled monitors due to run', async () => {
    const [stalled] = await sql<[{ id: number }]>`
      INSERT INTO db_executions (db_monitor_id, status, start_time)
      VALUES (${monitorId}, 'PENDING', NOW() - INTERVAL '200 seconds')
      RETURNING id
    `;
    const [latest] = await dbMonitorRepo.createExecution(monitorId, 'SUCCESS');

    const all = await dbMonitorRepo.findExecutionsByMonitorId(monitorId);
    expect(all.map((execution) => execution.id)).toEqual([latest.id, stalled.id]);
    expect(all[1]?.status).toBe('FAILED');

    const summaries = await dbMonitorRepo.findAllWithLatest();
    const summary = summaries.find((monitor) => monitor.id === monitorId);
    expect(summary?.type).toBe('db');
    expect(summary?.latest?.status).toBe('SUCCESS');

    const due = await dbMonitorRepo.findDue();
    expect(due.some((monitor) => monitor.id === monitorId)).toBe(true);
  });

  test('updates monitor and execution fields, toggles enabled, and finds by id', async () => {
    await dbMonitorRepo.update(monitorId, { host: 'updated.db.example.test', port: 15432 });
    await dbMonitorRepo.updateEnabled(monitorId, false);
    const [monitor] = await dbMonitorRepo.findById(monitorId);
    expect(monitor.host).toBe('updated.db.example.test');
    expect(monitor.port).toBe(15432);
    expect(monitor.enabled).toBe(false);

    const [execution] = await dbMonitorRepo.createExecution(monitorId, 'FAILED');
    await dbMonitorRepo.updateExecution(execution.id, { errorMessage: 'connection refused' });
    const executions = await dbMonitorRepo.findExecutionsByMonitorId(monitorId);
    expect(executions.find((item) => item.id === execution.id)?.errorMessage).toBe('connection refused');
  });
});
