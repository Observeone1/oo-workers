import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { udpExecutions, udpMonitors } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import { projectLatest } from './_with-latest.ts';

export const udpMonitorRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([udpExecutions.udpMonitorId], {
        monitorId: udpExecutions.udpMonitorId,
        id: udpExecutions.id,
        status: udpExecutions.status,
        latencyMs: udpExecutions.latencyMs,
        errorMessage: udpExecutions.errorMessage,
        regionId: udpExecutions.regionId,
        startTime: udpExecutions.startTime,
      })
      .from(udpExecutions)
      .orderBy(udpExecutions.udpMonitorId, desc(udpExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(udpMonitors)
      .leftJoin(latest, eq(latest.monitorId, udpMonitors.id))
      .orderBy(desc(udpMonitors.id));

    return rows.map(({ udp_monitors: m, latest: l }) => ({
      ...m,
      type: 'udp' as const,
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
    return db.select().from(udpMonitors).where(eq(udpMonitors.id, id)).limit(1);
  },

  async findExecutionsByMonitorId(udpMonitorId: number, limit = 100) {
    const [m] = await db
      .select({ intervalSeconds: udpMonitors.intervalSeconds })
      .from(udpMonitors)
      .where(eq(udpMonitors.id, udpMonitorId))
      .limit(1);
    const rows = await db
      .select()
      .from(udpExecutions)
      .where(eq(udpExecutions.udpMonitorId, udpMonitorId))
      .orderBy(desc(udpExecutions.startTime))
      .limit(limit);
    if (!m) return rows;
    return rows.map((r) => projectStalled(r, r.startTime, m.intervalSeconds));
  },

  create(data: {
    name: string;
    host: string;
    port: number;
    payloadHex?: string | null;
    expectResponse?: boolean;
    timeoutMs?: number;
    intervalSeconds?: number;
    enabled?: boolean;
  }) {
    return db.insert(udpMonitors).values(data).returning();
  },

  createExecution(udpMonitorId: number, status: string, regionId: number | null = null) {
    return db.insert(udpExecutions).values({ udpMonitorId, status, regionId }).returning();
  },

  updateExecution(id: number, data: Partial<typeof udpExecutions.$inferInsert>) {
    return db.update(udpExecutions).set(data).where(eq(udpExecutions.id, id));
  },

  update(
    id: number,
    data: Partial<{
      name: string;
      host: string;
      port: number;
      payloadHex: string | null;
      expectResponse: boolean;
      intervalSeconds: number;
    }>,
  ) {
    return db.update(udpMonitors).set(data).where(eq(udpMonitors.id, id)).returning();
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(udpMonitors).set({ enabled }).where(eq(udpMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(udpMonitors).where(eq(udpMonitors.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        monitorId: udpExecutions.udpMonitorId,
        maxStart: sql<Date>`MAX(${udpExecutions.startTime})`.as('max_start'),
      })
      .from(udpExecutions)
      .groupBy(udpExecutions.udpMonitorId)
      .as('last_run');

    return db
      .select({
        id: udpMonitors.id,
        host: udpMonitors.host,
        port: udpMonitors.port,
        payloadHex: udpMonitors.payloadHex,
        expectResponse: udpMonitors.expectResponse,
        timeoutMs: udpMonitors.timeoutMs,
        intervalSeconds: udpMonitors.intervalSeconds,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as(
          'age_seconds',
        ),
      })
      .from(udpMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, udpMonitors.id))
      .where(eq(udpMonitors.enabled, true));
  },
};
