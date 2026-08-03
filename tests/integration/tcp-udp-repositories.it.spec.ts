/**
 * TCP and UDP repository contracts.
 *
 * Both repositories have the same monitor/execution lifecycle, but each test
 * uses its real table and type-specific fields.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { tcpMonitorRepo } from '../../src/db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../../src/db/repositories/udp-monitor.repo.ts';

const sql = connectDb();
const marker = `tcp-udp-repo-it-${Date.now()}`;
let tcpId = -1;
let udpId = -1;

beforeAll(async () => {
  const [tcp] = await tcpMonitorRepo.create({
    name: `${marker}-tcp`,
    host: 'tcp.example.test',
    port: 443,
    intervalSeconds: 60,
  });
  const [udp] = await udpMonitorRepo.create({
    name: `${marker}-udp`,
    host: 'udp.example.test',
    port: 53,
    payloadHex: '00ff',
    expectResponse: true,
    intervalSeconds: 60,
  });
  tcpId = tcp.id;
  udpId = udp.id;
}, 30_000);

afterAll(async () => {
  if (tcpId > 0) await sql`DELETE FROM tcp_monitors WHERE id = ${tcpId}`;
  if (udpId > 0) await sql`DELETE FROM udp_monitors WHERE id = ${udpId}`;
  await sql.end();
});

describe('tcpMonitorRepo', () => {
  test('projects executions, finds due monitors, and updates monitor fields', async () => {
    const [stalled] = await sql<[{ id: number }]>`
      INSERT INTO tcp_executions (tcp_monitor_id, status, start_time)
      VALUES (${tcpId}, 'PENDING', NOW() - INTERVAL '200 seconds')
      RETURNING id
    `;
    const [latest] = await tcpMonitorRepo.createExecution(tcpId, 'SUCCESS');

    const executions = await tcpMonitorRepo.findExecutionsByMonitorId(tcpId);
    expect(executions.map((execution) => execution.id)).toEqual([latest.id, stalled.id]);
    expect(executions[1]?.status).toBe('FAILED');
    expect((await tcpMonitorRepo.findAllWithLatest()).find((monitor) => monitor.id === tcpId)?.latest?.status).toBe(
      'SUCCESS',
    );
    expect((await tcpMonitorRepo.findDue()).some((monitor) => monitor.id === tcpId)).toBe(true);

    await tcpMonitorRepo.update(tcpId, { host: 'updated.tcp.example.test', port: 8443 });
    await tcpMonitorRepo.updateEnabled(tcpId, false);
    const [monitor] = await tcpMonitorRepo.findById(tcpId);
    expect(monitor.host).toBe('updated.tcp.example.test');
    expect(monitor.enabled).toBe(false);
  });
});

describe('udpMonitorRepo', () => {
  test('projects executions, finds due monitors, and updates type-specific fields', async () => {
    const [stalled] = await sql<[{ id: number }]>`
      INSERT INTO udp_executions (udp_monitor_id, status, start_time)
      VALUES (${udpId}, 'PENDING', NOW() - INTERVAL '200 seconds')
      RETURNING id
    `;
    const [latest] = await udpMonitorRepo.createExecution(udpId, 'SUCCESS');

    const executions = await udpMonitorRepo.findExecutionsByMonitorId(udpId);
    expect(executions.map((execution) => execution.id)).toEqual([latest.id, stalled.id]);
    expect(executions[1]?.status).toBe('FAILED');
    expect((await udpMonitorRepo.findAllWithLatest()).find((monitor) => monitor.id === udpId)?.latest?.status).toBe(
      'SUCCESS',
    );
    expect((await udpMonitorRepo.findDue()).some((monitor) => monitor.id === udpId)).toBe(true);

    await udpMonitorRepo.update(udpId, { host: 'updated.udp.example.test', expectResponse: false });
    await udpMonitorRepo.updateEnabled(udpId, false);
    const [monitor] = await udpMonitorRepo.findById(udpId);
    expect(monitor.host).toBe('updated.udp.example.test');
    expect(monitor.expectResponse).toBe(false);
    expect(monitor.enabled).toBe(false);
  });
});
