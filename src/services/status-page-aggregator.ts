/**
 * Aggregation for the public status page.
 *
 * For each monitor on a page, computes:
 *   - currentStatus  — most recent execution's outcome (up/down/unknown)
 *   - uptime24h      — % of runs in the last 24h that succeeded
 *   - bars90d        — 90 ordered day-buckets, each up/down/unknown
 *
 * Queries are grouped by date_trunc('day', start_time) so a monitor with
 * 60s interval produces ~1440 rows/day collapsed into a single bucket on
 * the SQL side, not in JS. Indexes on start_time keep this cheap.
 */

import { and, gte, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import {
  apiChecks,
  apiExecutions,
  qaProjects,
  qaTestExecutions,
  tcpExecutions,
  tcpMonitors,
  udpExecutions,
  udpMonitors,
  urlMonitorExecutions,
  urlMonitors,
} from '../db/schema.ts';
import type { MonitorType } from '../db/repositories/status-page.repo.ts';

export type DayState = 'up' | 'down' | 'unknown';

interface MonitorSummary {
  type: MonitorType;
  id: number;
  name: string;
  target: string;
  currentStatus: DayState;
  uptime24h: number | null; // null when no runs in window
  bars90d: DayState[]; // length 90, oldest → newest
}

const PALETTE = {
  url: { table: urlMonitorExecutions, monitorIdCol: urlMonitorExecutions.urlMonitorId },
  api: { table: apiExecutions, monitorIdCol: apiExecutions.apiCheckId },
  tcp: { table: tcpExecutions, monitorIdCol: tcpExecutions.tcpMonitorId },
  udp: { table: udpExecutions, monitorIdCol: udpExecutions.udpMonitorId },
  qa: { table: qaTestExecutions, monitorIdCol: qaTestExecutions.projectId },
} as const;

function normalize(status: string): DayState {
  const s = status.toUpperCase();
  if (s === 'SUCCESS' || s === 'PASSED') return 'up';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'ERROR') return 'down';
  return 'unknown';
}

async function monitorMeta(
  type: MonitorType,
  id: number,
): Promise<{ name: string; target: string } | null> {
  if (type === 'url') {
    const [r] = await db
      .select({ name: urlMonitors.name, url: urlMonitors.url })
      .from(urlMonitors)
      .where(sql`${urlMonitors.id} = ${id}`)
      .limit(1);
    return r ? { name: r.name, target: r.url } : null;
  }
  if (type === 'api') {
    const [r] = await db
      .select({ name: apiChecks.name, url: apiChecks.url })
      .from(apiChecks)
      .where(sql`${apiChecks.id} = ${id}`)
      .limit(1);
    return r ? { name: r.name, target: r.url } : null;
  }
  if (type === 'tcp') {
    const [r] = await db
      .select({ name: tcpMonitors.name, host: tcpMonitors.host, port: tcpMonitors.port })
      .from(tcpMonitors)
      .where(sql`${tcpMonitors.id} = ${id}`)
      .limit(1);
    return r ? { name: r.name, target: `${r.host}:${r.port}` } : null;
  }
  if (type === 'udp') {
    const [r] = await db
      .select({ name: udpMonitors.name, host: udpMonitors.host, port: udpMonitors.port })
      .from(udpMonitors)
      .where(sql`${udpMonitors.id} = ${id}`)
      .limit(1);
    return r ? { name: r.name, target: `${r.host}:${r.port}` } : null;
  }
  const [r] = await db
    .select({ name: qaProjects.name })
    .from(qaProjects)
    .where(sql`${qaProjects.id} = ${id}`)
    .limit(1);
  return r ? { name: r.name, target: 'browser script' } : null;
}

function startTimeCol(type: MonitorType) {
  if (type === 'qa') return qaTestExecutions.startedAt;
  return PALETTE[type].table.startTime;
}

async function dayBuckets(
  type: MonitorType,
  id: number,
  since: Date,
): Promise<Map<string, { hadSuccess: boolean; hadFailed: boolean }>> {
  const { table, monitorIdCol } = PALETTE[type];
  const startCol = startTimeCol(type);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${startCol}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      hadSuccess: sql<boolean>`bool_or(${table.status} IN ('SUCCESS','passed'))`,
      hadFailed: sql<boolean>`bool_or(${table.status} IN ('FAILED','failed','ERROR','error'))`,
    })
    .from(table)
    .where(and(sql`${monitorIdCol} = ${id}`, gte(startCol, since)))
    .groupBy(sql`date_trunc('day', ${startCol})`);
  const out = new Map<string, { hadSuccess: boolean; hadFailed: boolean }>();
  for (const r of rows) {
    out.set(r.day, { hadSuccess: !!r.hadSuccess, hadFailed: !!r.hadFailed });
  }
  return out;
}

async function uptime24h(type: MonitorType, id: number, since: Date): Promise<number | null> {
  const { table, monitorIdCol } = PALETTE[type];
  const startCol = startTimeCol(type);
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      ok: sql<number>`count(*) FILTER (WHERE ${table.status} IN ('SUCCESS','passed'))`,
    })
    .from(table)
    .where(and(sql`${monitorIdCol} = ${id}`, gte(startCol, since)));
  const total = Number(row?.total ?? 0);
  if (total === 0) return null;
  return Math.round((Number(row.ok) / total) * 1000) / 10; // one decimal
}

async function currentStatus(type: MonitorType, id: number): Promise<DayState> {
  const { table, monitorIdCol } = PALETTE[type];
  const startCol = startTimeCol(type);
  const [row] = await db
    .select({ status: table.status })
    .from(table)
    .where(sql`${monitorIdCol} = ${id}`)
    .orderBy(sql`${startCol} DESC`)
    .limit(1);
  return row ? normalize(row.status) : 'unknown';
}

function dayKey(d: Date): string {
  // YYYY-MM-DD in UTC; matches the GROUP BY above.
  return d.toISOString().slice(0, 10);
}

async function summarizeMonitor(type: MonitorType, id: number): Promise<MonitorSummary | null> {
  const meta = await monitorMeta(type, id);
  if (!meta) return null;
  const now = new Date();
  const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const since24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [buckets, up24, cur] = await Promise.all([
    dayBuckets(type, id, since90),
    uptime24h(type, id, since24),
    currentStatus(type, id),
  ]);

  // Build the 90 ordered slots (oldest → newest).
  const bars90d: DayState[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    const b = buckets.get(key);
    if (!b) bars90d.push('unknown');
    else if (b.hadFailed) bars90d.push('down');
    else if (b.hadSuccess) bars90d.push('up');
    else bars90d.push('unknown');
  }

  return {
    type,
    id,
    name: meta.name,
    target: meta.target,
    currentStatus: cur,
    uptime24h: up24,
    bars90d,
  };
}

export interface StatusPageSummary {
  page: { slug: string; title: string; description: string | null };
  monitors: MonitorSummary[];
  overall: DayState; // worst of all monitors
  generatedAt: string;
}

export async function summarizeStatusPage(slug: string): Promise<StatusPageSummary | null> {
  const { statusPageRepo, statusPageMonitorRepo } =
    await import('../db/repositories/status-page.repo.ts');
  const page = await statusPageRepo.findBySlug(slug);
  if (!page) return null;
  const bindings = await statusPageMonitorRepo.forPage(page.id);
  const summaries = await Promise.all(
    bindings.map((b) => summarizeMonitor(b.monitorType, b.monitorId)),
  );
  const monitors = summaries.filter((m): m is MonitorSummary => m !== null);
  const overall: DayState = monitors.some((m) => m.currentStatus === 'down')
    ? 'down'
    : monitors.every((m) => m.currentStatus === 'up')
      ? monitors.length === 0
        ? 'unknown'
        : 'up'
      : 'unknown';
  return {
    page: { slug: page.slug, title: page.title, description: page.description },
    monitors,
    overall,
    generatedAt: new Date().toISOString(),
  };
}
