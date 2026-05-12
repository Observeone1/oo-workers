import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { urlMonitorAssertions, urlMonitorExecutions, urlMonitors } from '../schema.ts';

export const urlMonitorRepo = {
  findAllWithLatest() {
    // row_to_json correlated subquery — kept as raw SQL; no behaviour change risk
    return db.execute(sql`
      SELECT m.*, 'url' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, status_code, response_time_ms, error_message, start_time
          FROM url_monitor_executions
          WHERE url_monitor_id = m.id ORDER BY start_time DESC LIMIT 1
        ) e) AS latest
      FROM url_monitors m ORDER BY id DESC
    `);
  },

  findById(id: number) {
    return db.select().from(urlMonitors).where(eq(urlMonitors.id, id)).limit(1);
  },

  findAssertionsByMonitorId(urlMonitorId: number) {
    return db.select().from(urlMonitorAssertions).where(eq(urlMonitorAssertions.urlMonitorId, urlMonitorId));
  },

  findExecutionsByMonitorId(urlMonitorId: number, limit = 100) {
    return db.select().from(urlMonitorExecutions)
      .where(eq(urlMonitorExecutions.urlMonitorId, urlMonitorId))
      .orderBy(desc(urlMonitorExecutions.startTime))
      .limit(limit);
  },

  create(data: { name: string; url: string; timeoutMs?: number; intervalSeconds?: number; enabled?: boolean }) {
    return db.insert(urlMonitors).values(data).returning();
  },

  createAssertion(urlMonitorId: number, assertion: { operator: string; statusCode: number }) {
    return db.insert(urlMonitorAssertions).values({ urlMonitorId, ...assertion }).returning();
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
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as('age_seconds'),
      })
      .from(urlMonitors)
      .leftJoin(lastRun, eq(lastRun.monitorId, urlMonitors.id))
      .where(eq(urlMonitors.enabled, true));
  },
};
