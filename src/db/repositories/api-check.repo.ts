import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { apiAssertions, apiChecks, apiExecutions } from '../schema.ts';

export const apiCheckRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([apiExecutions.apiCheckId], {
        checkId: apiExecutions.apiCheckId,
        id: apiExecutions.id,
        status: apiExecutions.status,
        statusCode: apiExecutions.responseStatus,
        responseTimeMs: apiExecutions.responseTimeMs,
        errorMessage: apiExecutions.errorMessage,
        startTime: apiExecutions.startTime,
      })
      .from(apiExecutions)
      .orderBy(apiExecutions.apiCheckId, desc(apiExecutions.startTime))
      .as('latest');

    const rows = await db
      .select()
      .from(apiChecks)
      .leftJoin(latest, eq(latest.checkId, apiChecks.id))
      .orderBy(desc(apiChecks.id));

    return rows.map(({ api_checks: c, latest: l }) => ({
      ...c,
      type: 'api' as const,
      latest: l && l.id !== null
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
    return db.insert(apiChecks).values(data).returning();
  },

  createAssertion(apiCheckId: number, assertion: { type: string; operator: string; path?: string | null; value?: string | null }) {
    return db.insert(apiAssertions).values({ apiCheckId, ...assertion }).returning();
  },

  createExecution(apiCheckId: number, status: string) {
    return db.insert(apiExecutions).values({ apiCheckId, status }).returning();
  },

  updateExecution(id: number, data: Partial<typeof apiExecutions.$inferInsert>) {
    return db.update(apiExecutions).set(data).where(eq(apiExecutions.id, id));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(apiChecks).set({ enabled }).where(eq(apiChecks.id, id));
  },

  deleteById(id: number) {
    return db.delete(apiChecks).where(eq(apiChecks.id, id));
  },

  findDue() {
    const lastRun = db
      .select({
        checkId: apiExecutions.apiCheckId,
        maxStart: sql<Date>`MAX(${apiExecutions.startTime})`.as('max_start'),
      })
      .from(apiExecutions)
      .groupBy(apiExecutions.apiCheckId)
      .as('last_run');

    return db
      .select({
        id: apiChecks.id,
        url: apiChecks.url,
        method: apiChecks.method,
        headers: apiChecks.headers,
        body: apiChecks.body,
        timeoutMs: apiChecks.timeoutMs,
        intervalSeconds: apiChecks.intervalSeconds,
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${lastRun.maxStart}))::int`.as('age_seconds'),
      })
      .from(apiChecks)
      .leftJoin(lastRun, eq(lastRun.checkId, apiChecks.id))
      .where(eq(apiChecks.enabled, true));
  },
};
