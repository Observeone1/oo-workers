import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { tcpExecutions, tcpMonitors } from '../schema.ts';

export const tcpMonitorRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([tcpExecutions.tcpMonitorId], {
        monitorId: tcpExecutions.tcpMonitorId,
        id: tcpExecutions.id,
        status: tcpExecutions.status,
        latencyMs: tcpExecutions.latencyMs,
        errorMessage: tcpExecutions.errorMessage,
        startTime: tcpExecutions.startTime,
      })
      .from(tcpExecutions)
      .orderBy(tcpExecutions.tcpMonitorId, desc(tcpExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(tcpMonitors)
      .leftJoin(latest, eq(latest.monitorId, tcpMonitors.id))
      .orderBy(desc(tcpMonitors.id));

    return rows.map(({ tcp_monitors: m, latest: l }) => ({
      ...m,
      type: 'tcp' as const,
      latest:
        l && l.id !== null
          ? {
              id: l.id,
              status: l.status,
              responseTimeMs: l.latencyMs,
              errorMessage: l.errorMessage,
              startTime: l.startTime,
            }
          : null,
    }));
  },

  findById(id: number) {
    return db.select().from(tcpMonitors).where(eq(tcpMonitors.id, id)).limit(1);
  },

  findExecutionsByMonitorId(tcpMonitorId: number, limit = 100) {
    return db
      .select()
      .from(tcpExecutions)
      .where(eq(tcpExecutions.tcpMonitorId, tcpMonitorId))
      .orderBy(desc(tcpExecutions.startTime))
      .limit(limit);
  },

  create(data: {
    name: string;
    host: string;
    port: number;
    timeoutMs?: number;
    intervalSeconds?: number;
    enabled?: boolean;
  }) {
    return db.insert(tcpMonitors).values(data).returning();
  },

  createExecution(tcpMonitorId: number, status: string, regionId: number | null = null) {
    return db.insert(tcpExecutions).values({ tcpMonitorId, status, regionId }).returning();
  },

  updateExecution(id: number, data: Partial<typeof tcpExecutions.$inferInsert>) {
    return db.update(tcpExecutions).set(data).where(eq(tcpExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(tcpMonitors).set({ enabled }).where(eq(tcpMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(tcpMonitors).where(eq(tcpMonitors.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        monitorId: tcpExecutions.tcpMonitorId,
        maxStart: sql<Date>`MAX(${tcpExecutions.startTime})`.as('max_start'),
      })
      .from(tcpExecutions)
      .groupBy(tcpExecutions.tcpMonitorId)
      .as('last_run');

    return db
      .select({
        id: tcpMonitors.id,
        host: tcpMonitors.host,
        port: tcpMonitors.port,
        timeoutMs: tcpMonitors.timeoutMs,
        intervalSeconds: tcpMonitors.intervalSeconds,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as(
          'age_seconds',
        ),
      })
      .from(tcpMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, tcpMonitors.id))
      .where(eq(tcpMonitors.enabled, true));
  },
};
