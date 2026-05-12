import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { urlMonitorAssertions, urlMonitorExecutions, urlMonitors } from '../schema.ts';

export const urlMonitorRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([urlMonitorExecutions.urlMonitorId], {
        monitorId: urlMonitorExecutions.urlMonitorId,
        id: urlMonitorExecutions.id,
        status: urlMonitorExecutions.status,
        statusCode: urlMonitorExecutions.statusCode,
        responseTimeMs: urlMonitorExecutions.responseTimeMs,
        errorMessage: urlMonitorExecutions.errorMessage,
        startTime: urlMonitorExecutions.startTime,
      })
      .from(urlMonitorExecutions)
      .orderBy(urlMonitorExecutions.urlMonitorId, desc(urlMonitorExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(urlMonitors)
      .leftJoin(latest, eq(latest.monitorId, urlMonitors.id))
      .orderBy(desc(urlMonitors.id));

    return rows.map(({ url_monitors: m, latest: l }) => ({
      ...m,
      type: 'url' as const,
      latest:
        l && l.id !== null
          ? {
              id: l.id,
              status: l.status,
              statusCode: l.statusCode,
              responseTimeMs: l.responseTimeMs,
              errorMessage: l.errorMessage,
              startTime: l.startTime,
            }
          : null,
    }));
  },

  findById(id: number) {
    return db.select().from(urlMonitors).where(eq(urlMonitors.id, id)).limit(1);
  },

  findAssertionsByMonitorId(urlMonitorId: number) {
    return db
      .select()
      .from(urlMonitorAssertions)
      .where(eq(urlMonitorAssertions.urlMonitorId, urlMonitorId));
  },

  findExecutionsByMonitorId(urlMonitorId: number, limit = 100) {
    return db
      .select()
      .from(urlMonitorExecutions)
      .where(eq(urlMonitorExecutions.urlMonitorId, urlMonitorId))
      .orderBy(desc(urlMonitorExecutions.startTime))
      .limit(limit);
  },

  create(data: {
    name: string;
    url: string;
    timeoutMs?: number;
    intervalSeconds?: number;
    enabled?: boolean;
  }) {
    return db.insert(urlMonitors).values(data).returning();
  },

  createAssertion(urlMonitorId: number, assertion: { operator: string; statusCode: number }) {
    return db
      .insert(urlMonitorAssertions)
      .values({ urlMonitorId, ...assertion })
      .returning();
  },

  createAssertions(urlMonitorId: number, rows: Array<{ operator: string; statusCode: number }>) {
    if (rows.length === 0) return Promise.resolve([] as never[]);
    return db
      .insert(urlMonitorAssertions)
      .values(rows.map((r) => ({ urlMonitorId, ...r })))
      .returning();
  },

  createExecution(urlMonitorId: number, status: string) {
    return db.insert(urlMonitorExecutions).values({ urlMonitorId, status }).returning();
  },

  updateExecution(id: number, data: Partial<typeof urlMonitorExecutions.$inferInsert>) {
    return db.update(urlMonitorExecutions).set(data).where(eq(urlMonitorExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(urlMonitors).set({ enabled }).where(eq(urlMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(urlMonitors).where(eq(urlMonitors.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        monitorId: urlMonitorExecutions.urlMonitorId,
        maxStart: sql<Date>`MAX(${urlMonitorExecutions.startTime})`.as('max_start'),
      })
      .from(urlMonitorExecutions)
      .groupBy(urlMonitorExecutions.urlMonitorId)
      .as('last_run');

    return db
      .select({
        id: urlMonitors.id,
        url: urlMonitors.url,
        timeoutMs: urlMonitors.timeoutMs,
        intervalSeconds: urlMonitors.intervalSeconds,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as(
          'age_seconds',
        ),
      })
      .from(urlMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, urlMonitors.id))
      .where(eq(urlMonitors.enabled, true));
  },
};
