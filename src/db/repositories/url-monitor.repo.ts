import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { urlMonitorAssertions, urlMonitorExecutions, urlMonitors } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import { projectLatest } from './_with-latest.ts';

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
        regionId: urlMonitorExecutions.regionId,
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
      latest: projectLatest(l, m.intervalSeconds, (l, p) => ({
        id: l.id as number,
        status: p.status,
        statusCode: l.statusCode,
        responseTimeMs: l.responseTimeMs,
        errorMessage: p.errorMessage,
        startTime: l.startTime,
      })),
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

  async findExecutionsByMonitorId(urlMonitorId: number, limit = 100) {
    const [m] = await db
      .select({ intervalSeconds: urlMonitors.intervalSeconds })
      .from(urlMonitors)
      .where(eq(urlMonitors.id, urlMonitorId))
      .limit(1);
    const rows = await db
      .select()
      .from(urlMonitorExecutions)
      .where(eq(urlMonitorExecutions.urlMonitorId, urlMonitorId))
      .orderBy(desc(urlMonitorExecutions.startTime))
      .limit(limit);
    if (!m) return rows;
    return rows.map((r) => projectStalled(r, r.startTime, m.intervalSeconds));
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

  createExecution(urlMonitorId: number, status: string, regionId: number | null = null) {
    return db.insert(urlMonitorExecutions).values({ urlMonitorId, status, regionId }).returning();
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
