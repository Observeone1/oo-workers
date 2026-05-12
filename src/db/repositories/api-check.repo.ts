import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { jsonbCast } from '../jsonb.ts';
import { apiAssertions, apiChecks, apiExecutions } from '../schema.ts';

export const apiCheckRepo = {
  findAllWithLatest() {
    return db.execute(sql`
      SELECT c.*, 'api' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, response_status AS status_code, response_time_ms, error_message, start_time
          FROM api_executions
          WHERE api_check_id = c.id ORDER BY start_time DESC LIMIT 1
        ) e) AS latest
      FROM api_checks c ORDER BY id DESC
    `);
  },

  findById(id: number) {
    return db.select().from(apiChecks).where(eq(apiChecks.id, id)).limit(1);
  },

  findAssertionsByCheckId(apiCheckId: number) {
    return db.select().from(apiAssertions).where(eq(apiAssertions.apiCheckId, apiCheckId));
  },

  findExecutionsByCheckId(apiCheckId: number, limit = 100) {
    return db.select().from(apiExecutions)
      .where(eq(apiExecutions.apiCheckId, apiCheckId))
      .orderBy(desc(apiExecutions.startTime))
      .limit(limit);
  },

  create(data: {
    name: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    timeoutMs?: number;
    intervalSeconds?: number;
    enabled?: boolean;
  }) {
    const { headers, ...rest } = data;
    const values: Record<string, unknown> = { ...rest };
    if (headers !== undefined) values.headers = jsonbCast(headers);
    return db.insert(apiChecks).values(values as any).returning();
  },

  createAssertion(apiCheckId: number, assertion: { type: string; operator: string; path?: string | null; value?: string | null }) {
    return db.insert(apiAssertions).values({ apiCheckId, ...assertion }).returning();
  },

  createExecution(apiCheckId: number, status: string) {
    return db.insert(apiExecutions).values({ apiCheckId, status }).returning();
  },

  updateExecution(id: number, data: Partial<typeof apiExecutions.$inferInsert>) {
    const { assertionResults, responseHeaders, ...rest } = data as any;
    const setClause: Record<string, unknown> = { ...rest };
    if (assertionResults !== undefined) setClause.assertionResults = jsonbCast(assertionResults);
    if (responseHeaders !== undefined)  setClause.responseHeaders  = jsonbCast(responseHeaders);
    return db.update(apiExecutions).set(setClause as any).where(eq(apiExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(apiChecks).set({ enabled }).where(eq(apiChecks.id, id));
  },

  deleteById(id: number) {
    return db.delete(apiChecks).where(eq(apiChecks.id, id));
  },

  findDue() {
    return db.execute<{
      id: number;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
      timeout_ms: number;
      interval_seconds: number;
      age_seconds: number | null;
    }>(sql`
      SELECT c.id, c.url, c.method, c.headers, c.body, c.timeout_ms, c.interval_seconds,
             (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_time)))::bigint
                FROM api_executions WHERE api_check_id = c.id) AS age_seconds
      FROM api_checks c
      WHERE c.enabled = TRUE
    `);
  },
};
