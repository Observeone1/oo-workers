/**
 * fetchMonitorMeta dispatch — real Drizzle queries against each monitor
 * table it can be asked about. status-page-public.it.spec.ts already
 * exercises the url/tls branches indirectly through the rendered page;
 * this covers the remaining api/db/qa branches plus the "no such row"
 * null path, directly and against the real schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { fetchMonitorMeta } from '../../src/services/status-page-monitor-meta.ts';
import { apiCheckRepo } from '../../src/db/repositories/api-check.repo.ts';
import { dbMonitorRepo } from '../../src/db/repositories/db-monitor.repo.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../../src/db/repositories/tcp-monitor.repo.ts';

const sql = connectDb();
const marker = `sp-meta-it-${Date.now()}`;
let apiId = -1;
let dbId = -1;
let qaId = -1;
let tcpId = -1;

beforeAll(async () => {
  const [api] = await apiCheckRepo.create({
    name: `${marker}-api`,
    url: 'https://api.example.test/health',
    intervalSeconds: 90,
  });
  apiId = api.id;

  const [dbMon] = await dbMonitorRepo.create({
    name: `${marker}-db`,
    protocol: 'postgres',
    host: 'pg.example.test',
    port: 5432,
    intervalSeconds: 120,
  });
  dbId = dbMon.id;

  const [qa] = await qaProjectRepo.create({
    name: `${marker}-qa`,
    targetUrl: 'https://shop.example.test',
    intervalSeconds: 300,
  });
  qaId = qa.id;

  const [tcp] = await tcpMonitorRepo.create({
    name: `${marker}-tcp`,
    host: 'tcp.example.test',
    port: 22,
  });
  tcpId = tcp.id;
}, 30_000);

afterAll(async () => {
  if (apiId > 0) await sql`DELETE FROM api_checks WHERE id = ${apiId}`;
  if (dbId > 0) await sql`DELETE FROM db_monitors WHERE id = ${dbId}`;
  if (qaId > 0) await sql`DELETE FROM qa_projects WHERE id = ${qaId}`;
  if (tcpId > 0) await sql`DELETE FROM tcp_monitors WHERE id = ${tcpId}`;
  await sql.end();
});

describe('fetchMonitorMeta', () => {
  test('api: resolves name/url/intervalSeconds from api_checks', async () => {
    const meta = await fetchMonitorMeta('api', apiId);
    expect(meta).toEqual({
      name: `${marker}-api`,
      target: 'https://api.example.test/health',
      intervalSeconds: 90,
    });
  });

  test('db: resolves name/"protocol host:port"/intervalSeconds from db_monitors', async () => {
    const meta = await fetchMonitorMeta('db', dbId);
    expect(meta).toEqual({
      name: `${marker}-db`,
      target: 'postgres pg.example.test:5432',
      intervalSeconds: 120,
    });
  });

  test('qa: resolves name/"browser script"/intervalSeconds from qa_projects', async () => {
    const meta = await fetchMonitorMeta('qa', qaId);
    expect(meta).toEqual({
      name: `${marker}-qa`,
      target: 'browser script',
      intervalSeconds: 300,
    });
  });

  test('tcp: resolves name/"host:port"/intervalSeconds from tcp_monitors', async () => {
    const meta = await fetchMonitorMeta('tcp', tcpId);
    expect(meta).toEqual({
      name: `${marker}-tcp`,
      target: 'tcp.example.test:22',
      intervalSeconds: 60,
    });
  });

  test('an id with no matching row resolves null for every host/port type', async () => {
    const missing = -999999;
    expect(await fetchMonitorMeta('tcp', missing)).toBeNull();
    expect(await fetchMonitorMeta('udp', missing)).toBeNull();
    expect(await fetchMonitorMeta('tls', missing)).toBeNull();
    expect(await fetchMonitorMeta('api', missing)).toBeNull();
    expect(await fetchMonitorMeta('db', missing)).toBeNull();
    expect(await fetchMonitorMeta('qa', missing)).toBeNull();
  });
});
