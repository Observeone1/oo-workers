import { sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import {
  apiChecks,
  dbMonitors,
  qaProjects,
  tcpMonitors,
  tlsMonitors,
  udpMonitors,
  urlMonitors,
} from '../db/schema.ts';
import type { MonitorType } from '../db/repositories/status-page.repo.ts';

export type MonitorMetaRow = { name: string; target: string; intervalSeconds: number };

async function fetchUrlMeta(id: number): Promise<MonitorMetaRow | null> {
  const [r] = await db
    .select({
      name: urlMonitors.name,
      url: urlMonitors.url,
      intervalSeconds: urlMonitors.intervalSeconds,
    })
    .from(urlMonitors)
    .where(sql`${urlMonitors.id} = ${id}`)
    .limit(1);
  return r ? { name: r.name, target: r.url, intervalSeconds: r.intervalSeconds } : null;
}

async function fetchApiMeta(id: number): Promise<MonitorMetaRow | null> {
  const [r] = await db
    .select({
      name: apiChecks.name,
      url: apiChecks.url,
      intervalSeconds: apiChecks.intervalSeconds,
    })
    .from(apiChecks)
    .where(sql`${apiChecks.id} = ${id}`)
    .limit(1);
  return r ? { name: r.name, target: r.url, intervalSeconds: r.intervalSeconds } : null;
}

async function fetchHostPortMeta(
  table: typeof tcpMonitors | typeof udpMonitors | typeof tlsMonitors,
  id: number,
): Promise<MonitorMetaRow | null> {
  const [r] = await db
    .select({
      name: table.name,
      host: table.host,
      port: table.port,
      intervalSeconds: table.intervalSeconds,
    })
    .from(table)
    .where(sql`${table.id} = ${id}`)
    .limit(1);
  return r
    ? { name: r.name, target: `${r.host}:${r.port}`, intervalSeconds: r.intervalSeconds }
    : null;
}

async function fetchDbMeta(id: number): Promise<MonitorMetaRow | null> {
  const [r] = await db
    .select({
      name: dbMonitors.name,
      protocol: dbMonitors.protocol,
      host: dbMonitors.host,
      port: dbMonitors.port,
      intervalSeconds: dbMonitors.intervalSeconds,
    })
    .from(dbMonitors)
    .where(sql`${dbMonitors.id} = ${id}`)
    .limit(1);
  return r
    ? {
        name: r.name,
        target: `${r.protocol} ${r.host}:${r.port}`,
        intervalSeconds: r.intervalSeconds,
      }
    : null;
}

async function fetchQaMeta(id: number): Promise<MonitorMetaRow | null> {
  const [r] = await db
    .select({ name: qaProjects.name, intervalSeconds: qaProjects.intervalSeconds })
    .from(qaProjects)
    .where(sql`${qaProjects.id} = ${id}`)
    .limit(1);
  return r ? { name: r.name, target: 'browser script', intervalSeconds: r.intervalSeconds } : null;
}

const META_FETCHERS: Record<MonitorType, (id: number) => Promise<MonitorMetaRow | null>> = {
  url: fetchUrlMeta,
  api: fetchApiMeta,
  tcp: (id) => fetchHostPortMeta(tcpMonitors, id),
  udp: (id) => fetchHostPortMeta(udpMonitors, id),
  tls: (id) => fetchHostPortMeta(tlsMonitors, id),
  db: fetchDbMeta,
  qa: fetchQaMeta,
};

export async function fetchMonitorMeta(
  type: MonitorType,
  id: number,
): Promise<MonitorMetaRow | null> {
  return META_FETCHERS[type](id);
}
