/**
 * Heartbeat repository contract — repo-level coverage for findById,
 * findByToken, and update, which heartbeat.it.spec.ts (route-level e2e)
 * doesn't exercise directly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { heartbeatRepo } from '../../src/db/repositories/heartbeat.repo.ts';

const sql = connectDb();
const marker = `heartbeat-repo-it-${Date.now()}`;
let heartbeatId = -1;
let token = '';

beforeAll(async () => {
  const [row] = await heartbeatRepo.create({ name: marker, periodSeconds: 60 });
  heartbeatId = row.id;
  token = row.token;
}, 30_000);

afterAll(async () => {
  if (heartbeatId > 0) {
    await sql`DELETE FROM heartbeat_monitors WHERE id = ${heartbeatId}`;
  }
  await sql.end();
});

describe('heartbeatRepo', () => {
  test('findById returns the created row', async () => {
    const [row] = await heartbeatRepo.findById(heartbeatId);
    expect(row.name).toBe(marker);
    expect(row.status).toBe('PENDING');
  });

  test('findByToken returns the row matching the generated token', async () => {
    const [row] = await heartbeatRepo.findByToken(token);
    expect(row.id).toBe(heartbeatId);
  });

  test('findByToken returns no rows for an unknown token', async () => {
    const rows = await heartbeatRepo.findByToken('not-a-real-token');
    expect(rows).toEqual([]);
  });

  test('update modifies fields and bumps updatedAt', async () => {
    const [before] = await heartbeatRepo.findById(heartbeatId);
    await new Promise((r) => setTimeout(r, 10));

    const [updated] = await heartbeatRepo.update(heartbeatId, {
      name: `${marker}-updated`,
      periodSeconds: 120,
      graceSeconds: 45,
      enabled: false,
    });
    expect(updated.name).toBe(`${marker}-updated`);
    expect(updated.periodSeconds).toBe(120);
    expect(updated.graceSeconds).toBe(45);
    expect(updated.enabled).toBe(false);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});
