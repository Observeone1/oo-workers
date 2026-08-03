/**
 * TLS monitor repository contract.
 *
 * Covers CRUD, latest execution projection, stalled execution projection, and
 * due-monitor selection against the real Postgres schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { tlsMonitorRepo } from '../../src/db/repositories/tls-monitor.repo.ts';

const sql = connectDb();
const marker = `tls-repo-it-${Date.now()}`;
let monitorId = -1;

beforeAll(async () => {
  const [monitor] = await tlsMonitorRepo.create({
    name: marker,
    host: 'tls.example.test',
    intervalSeconds: 60,
  });
  monitorId = monitor.id;
}, 30_000);

afterAll(async () => {
  if (monitorId > 0) {
    await sql`DELETE FROM tls_monitors WHERE id = ${monitorId}`;
  }
  await sql.end();
});

describe('tlsMonitorRepo', () => {
  test('projects latest and stalled executions and selects enabled monitors due to run', async () => {
    const [stalled] = await sql<[{ id: number }]>`
      INSERT INTO tls_executions (tls_monitor_id, status, start_time)
      VALUES (${monitorId}, 'PENDING', NOW() - INTERVAL '200 seconds')
      RETURNING id
    `;
    const [latest] = await tlsMonitorRepo.createExecution(monitorId, 'SUCCESS');

    const all = await tlsMonitorRepo.findExecutionsByMonitorId(monitorId);
    expect(all.map((execution) => execution.id)).toEqual([latest.id, stalled.id]);
    expect(all[1]?.status).toBe('FAILED');

    const summaries = await tlsMonitorRepo.findAllWithLatest();
    const summary = summaries.find((monitor) => monitor.id === monitorId);
    expect(summary?.type).toBe('tls');
    expect(summary?.latest?.status).toBe('SUCCESS');

    const due = await tlsMonitorRepo.findDue();
    expect(due.some((monitor) => monitor.id === monitorId)).toBe(true);
  });

  test('updates monitor and execution fields, toggles enabled, and finds by id', async () => {
    await tlsMonitorRepo.update(monitorId, { host: 'updated.tls.example.test', port: 8443 });
    await tlsMonitorRepo.updateEnabled(monitorId, false);
    const [monitor] = await tlsMonitorRepo.findById(monitorId);
    expect(monitor.host).toBe('updated.tls.example.test');
    expect(monitor.port).toBe(8443);
    expect(monitor.enabled).toBe(false);

    const [execution] = await tlsMonitorRepo.createExecution(monitorId, 'FAILED');
    await tlsMonitorRepo.updateExecution(execution.id, { errorMessage: 'handshake failed' });
    const executions = await tlsMonitorRepo.findExecutionsByMonitorId(monitorId);
    expect(executions.find((item) => item.id === execution.id)?.errorMessage).toBe('handshake failed');
  });
});
