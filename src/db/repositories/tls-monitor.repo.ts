import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { tlsExecutions, tlsMonitors } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import { projectLatest } from './_with-latest.ts';

export const tlsMonitorRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([tlsExecutions.tlsMonitorId], {
        monitorId: tlsExecutions.tlsMonitorId,
        id: tlsExecutions.id,
        status: tlsExecutions.status,
        latencyMs: tlsExecutions.latencyMs,
        errorMessage: tlsExecutions.errorMessage,
        regionId: tlsExecutions.regionId,
        startTime: tlsExecutions.startTime,
      })
      .from(tlsExecutions)
      .orderBy(tlsExecutions.tlsMonitorId, desc(tlsExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(tlsMonitors)
      .leftJoin(latest, eq(latest.monitorId, tlsMonitors.id))
      .orderBy(desc(tlsMonitors.id));

    return rows.map(({ tls_monitors: m, latest: l }) => ({
      ...m,
      type: 'tls' as const,
      latest: projectLatest(l, m.intervalSeconds, (l, p) => ({
        id: l.id as number,
        status: p.status,
        responseTimeMs: l.latencyMs,
        errorMessage: p.errorMessage,
        startTime: l.startTime,
      })),
    }));
  },

  findById(id: number) {
    return db.select().from(tlsMonitors).where(eq(tlsMonitors.id, id)).limit(1);
  },

  async findExecutionsByMonitorId(tlsMonitorId: number, limit = 100) {
    const [m] = await db
      .select({ intervalSeconds: tlsMonitors.intervalSeconds })
      .from(tlsMonitors)
      .where(eq(tlsMonitors.id, tlsMonitorId))
      .limit(1);
    const rows = await db
      .select()
      .from(tlsExecutions)
      .where(eq(tlsExecutions.tlsMonitorId, tlsMonitorId))
      .orderBy(desc(tlsExecutions.startTime))
      .limit(limit);
    if (!m) return rows;
    return rows.map((r) => projectStalled(r, r.startTime, m.intervalSeconds));
  },

  create(data: {
    name: string;
    host: string;
    port?: number;
    description?: string | null;
    servername?: string | null;
    warnDays?: number;
    timeoutMs?: number;
    intervalSeconds?: number;
    enabled?: boolean;
    verifyChain?: boolean;
    verifyHostname?: boolean;
    expectCnRegex?: string | null;
  }) {
    return db.insert(tlsMonitors).values(data).returning();
  },

  createExecution(tlsMonitorId: number, status: string, regionId: number | null = null) {
    return db.insert(tlsExecutions).values({ tlsMonitorId, status, regionId }).returning();
  },

  updateExecution(id: number, data: Partial<typeof tlsExecutions.$inferInsert>) {
    return db.update(tlsExecutions).set(data).where(eq(tlsExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(tlsMonitors).set({ enabled }).where(eq(tlsMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(tlsMonitors).where(eq(tlsMonitors.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        monitorId: tlsExecutions.tlsMonitorId,
        maxStart: sql<Date>`MAX(${tlsExecutions.startTime})`.as('max_start'),
      })
      .from(tlsExecutions)
      .groupBy(tlsExecutions.tlsMonitorId)
      .as('last_run');

    return db
      .select({
        id: tlsMonitors.id,
        host: tlsMonitors.host,
        port: tlsMonitors.port,
        servername: tlsMonitors.servername,
        warnDays: tlsMonitors.warnDays,
        timeoutMs: tlsMonitors.timeoutMs,
        intervalSeconds: tlsMonitors.intervalSeconds,
        verifyChain: tlsMonitors.verifyChain,
        verifyHostname: tlsMonitors.verifyHostname,
        expectCnRegex: tlsMonitors.expectCnRegex,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as(
          'age_seconds',
        ),
      })
      .from(tlsMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, tlsMonitors.id))
      .where(eq(tlsMonitors.enabled, true));
  },
};
