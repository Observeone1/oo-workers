import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { jsonbCast } from '../jsonb.ts';
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
    const { assertionResults, ...rest } = data as any;
    const setClause: Record<string, unknown> = { ...rest };
    if (assertionResults !== undefined) setClause.assertionResults = jsonbCast(assertionResults);
    return db.update(urlMonitorExecutions).set(setClause as any).where(eq(urlMonitorExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(urlMonitors).set({ enabled }).where(eq(urlMonitors.id, id));
  },

  deleteById(id: number) {
    return db.delete(urlMonitors).where(eq(urlMonitors.id, id));
  },

  findDue() {
    // EXTRACT(EPOCH...) age calc — kept as raw SQL
    return db.execute<{
      id: number;
      url: string;
      timeout_ms: number;
      interval_seconds: number;
      age_seconds: number | null;
    }>(sql`
      SELECT m.id, m.url, m.timeout_ms, m.interval_seconds,
             (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_time)))::bigint
                FROM url_monitor_executions WHERE url_monitor_id = m.id) AS age_seconds
      FROM url_monitors m
      WHERE m.enabled = TRUE
    `);
  },
};
