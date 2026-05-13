import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { qaGeneratedTests, qaProjects, qaTestExecutions } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';

export const qaProjectRepo = {
  async findAllWithLatest() {
    const latest = db
      .selectDistinctOn([qaTestExecutions.projectId], {
        projectId: qaTestExecutions.projectId,
        id: qaTestExecutions.id,
        status: qaTestExecutions.status,
        durationMs: qaTestExecutions.durationMs,
        errorMessage: qaTestExecutions.errorMessage,
        regionId: qaTestExecutions.regionId,
        startTime: qaTestExecutions.startedAt,
      })
      .from(qaTestExecutions)
      .orderBy(qaTestExecutions.projectId, desc(qaTestExecutions.startedAt))
      .as('latest');

    const testCounts = db
      .select({
        projectId: qaGeneratedTests.projectId,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(qaGeneratedTests)
      .groupBy(qaGeneratedTests.projectId)
      .as('test_counts');

    const rows = await db
      .select()
      .from(qaProjects)
      .leftJoin(latest, eq(latest.projectId, qaProjects.id))
      .leftJoin(testCounts, eq(testCounts.projectId, qaProjects.id))
      .orderBy(desc(qaProjects.id));

    return rows.map(({ qa_projects: p, latest: l, test_counts: tc }) => ({
      ...p,
      type: 'qa' as const,
      testCount: tc?.count ?? 0,
      latest:
        l && l.id !== null
          ? (() => {
              const projected = projectStalled(
                { status: l.status, regionId: l.regionId, errorMessage: l.errorMessage },
                l.startTime,
                p.intervalSeconds,
              );
              return {
                id: l.id,
                status: projected.status,
                durationMs: l.durationMs,
                errorMessage: projected.errorMessage,
                startTime: l.startTime,
              };
            })()
          : null,
    }));
  },

  findById(id: number) {
    return db.select().from(qaProjects).where(eq(qaProjects.id, id)).limit(1);
  },

  findTestsByProjectId(projectId: number, opts: { includeScript?: boolean } = {}) {
    const cols = opts.includeScript
      ? {
          id: qaGeneratedTests.id,
          name: qaGeneratedTests.testName,
          script: qaGeneratedTests.script,
        }
      : {
          id: qaGeneratedTests.id,
          testName: qaGeneratedTests.testName,
          testType: qaGeneratedTests.testType,
          description: qaGeneratedTests.description,
          scriptSize: sql<number>`length(${qaGeneratedTests.script})`.as('script_size'),
        };
    return db
      .select(cols as any)
      .from(qaGeneratedTests)
      .where(eq(qaGeneratedTests.projectId, projectId));
  },

  async findExecutionsByProjectId(projectId: number, limit = 100) {
    const [p] = await db
      .select({ intervalSeconds: qaProjects.intervalSeconds })
      .from(qaProjects)
      .where(eq(qaProjects.id, projectId))
      .limit(1);
    const rows = await db
      .select()
      .from(qaTestExecutions)
      .where(eq(qaTestExecutions.projectId, projectId))
      .orderBy(desc(qaTestExecutions.startedAt))
      .limit(limit);
    if (!p) return rows;
    return rows.map((r) => projectStalled(r, r.startedAt, p.intervalSeconds));
  },

  create(data: {
    name: string;
    targetUrl: string;
    credentials?: Record<string, string> | null;
    config?: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
    status?: string;
  }) {
    return db.insert(qaProjects).values(data).returning();
  },

  createTest(
    projectId: number,
    test: { testName: string; testType?: string; script: string; description?: string | null },
  ) {
    return db
      .insert(qaGeneratedTests)
      .values({ projectId, ...test })
      .returning();
  },

  createTests(
    projectId: number,
    rows: Array<{
      testName: string;
      testType?: string;
      script: string;
      description?: string | null;
    }>,
  ) {
    if (rows.length === 0) return Promise.resolve([] as never[]);
    return db
      .insert(qaGeneratedTests)
      .values(rows.map((r) => ({ projectId, ...r })))
      .returning();
  },

  createExecution(
    testId: number,
    projectId: number,
    status: string,
    regionId: number | null = null,
  ) {
    return db.insert(qaTestExecutions).values({ testId, projectId, status, regionId }).returning();
  },

  updateExecution(id: number, data: Partial<typeof qaTestExecutions.$inferInsert>) {
    return db.update(qaTestExecutions).set(data).where(eq(qaTestExecutions.id, id));
  },

  touchLastRunAt(projectId: number) {
    return db.update(qaProjects).set({ lastRunAt: new Date() }).where(eq(qaProjects.id, projectId));
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(qaProjects).set({ enabled }).where(eq(qaProjects.id, id));
  },

  deleteById(id: number) {
    return db.delete(qaProjects).where(eq(qaProjects.id, id));
  },

  findDue() {
    return db
      .select({
        id: qaProjects.id,
        targetUrl: qaProjects.targetUrl,
        credentials: qaProjects.credentials,
        config: qaProjects.config,
        intervalSeconds: qaProjects.intervalSeconds,
        lastRunAt: qaProjects.lastRunAt,
        ageSeconds: sql<
          number | null
        >`EXTRACT(EPOCH FROM (NOW() - ${qaProjects.lastRunAt}))::int`.as('age_seconds'),
      })
      .from(qaProjects)
      .where(eq(qaProjects.enabled, true));
  },
};
