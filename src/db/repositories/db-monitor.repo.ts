import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { dbExecutions, dbMonitors } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import { projectLatest } from './_with-latest.ts';

export const dbMonitorRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([dbExecutions.dbMonitorId], {
        monitorId: dbExecutions.dbMonitorId,
        id: dbExecutions.id,
        status: dbExecutions.status,
        latencyMs: dbExecutions.latencyMs,
        errorMessage: dbExecutions.errorMessage,
        regionId: dbExecutions.regionId,
        startTime: dbExecutions.startTime,
      })
      .from(dbExecutions)
      .orderBy(dbExecutions.dbMonitorId, desc(dbExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(dbMonitors)
      .leftJoin(latest, eq(latest.monitorId, dbMonitors.id))
      .orderBy(desc(dbMonitors.id));

    return rows.map(({ db_monitors: m, latest: l }) => ({
      ...m,
      type: 'db' as const,
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
    return db.select().from(dbMonitors).where(eq(dbMonitors.id, id)).limit(1);
  },

  async findExecutionsByMonitorId(dbMonitorId: number, limit = 100) {
    const [m] = await db
      .select({ intervalSeconds: dbMonitors.intervalSeconds })
      .from(dbMonitors)
      .where(eq(dbMonitors.id, dbMonitorId))
      .limit(1);
    const rows = await db
      .select()
      .from(dbExecutions)
      .where(eq(dbExecutions.dbMonitorId, dbMonitorId))
      .orderBy(desc(dbExecutions.startTime))
      .limit(limit);
    if (!m) return rows;
    return rows.map((r) => projectStalled(r, r.startTime, m.intervalSeconds));
  },

  create(data: {
    name: string;
    protocol: string;
    host: string;
    port: number;
    description?: string | null;
    timeoutMs?: number;
    intervalSeconds?: number;
    tls?: boolean;
    enabled?: boolean;
  }) {
    return db.insert(dbMonitors).values(data).returning();
  },

  createExecution(dbMonitorId: number, status: string, regionId: number | null = null) {
    return db.insert(dbExecutions).values({ dbMonitorId, status, regionId }).returning();
  },

  updateExecution(id: number, data: Partial<typeof dbExecutions.$inferInsert>) {
    return db.update(dbExecutions).set(data).where(eq(dbExecutions.id, id));
  },

  update(
    id: number,
    data: Partial<{
      name: string;
      host: string;
      port: number;
      protocol: string;
      tls: boolean;
      intervalSeconds: number;
    }>,
  ) {
    return db.update(dbMonitors).set(data).where(eq(dbMonitors.id, id)).returning();
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(dbMonitors).set({ enabled }).where(eq(dbMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(dbMonitors).where(eq(dbMonitors.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        monitorId: dbExecutions.dbMonitorId,
        maxStart: sql<Date>`MAX(${dbExecutions.startTime})`.as('max_start'),
      })
      .from(dbExecutions)
      .groupBy(dbExecutions.dbMonitorId)
      .as('last_run');

    return db
      .select({
        id: dbMonitors.id,
        protocol: dbMonitors.protocol,
        tls: dbMonitors.tls,
        host: dbMonitors.host,
        port: dbMonitors.port,
        timeoutMs: dbMonitors.timeoutMs,
        intervalSeconds: dbMonitors.intervalSeconds,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as(
          'age_seconds',
        ),
      })
      .from(dbMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, dbMonitors.id))
      .where(eq(dbMonitors.enabled, true));
  },
};
