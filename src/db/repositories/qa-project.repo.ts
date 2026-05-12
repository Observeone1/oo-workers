import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { qaGeneratedTests, qaProjects, qaTestExecutions } from '../schema.ts';

export const qaProjectRepo = {
  findAllWithLatest() {
    return db.execute(sql`
      SELECT p.*, 'qa' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, duration_ms, error_message, started_at AS start_time
          FROM qa_test_executions
          WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1
        ) e) AS latest,
        (SELECT COUNT(*) FROM qa_generated_tests WHERE project_id = p.id) AS test_count
      FROM qa_projects p ORDER BY id DESC
    `);
  },

  findById(id: number) {
    return db.select().from(qaProjects).where(eq(qaProjects.id, id)).limit(1);
  },

  findTestsByProjectId(projectId: number) {
    return db.select({
      id: qaGeneratedTests.id,
      testName: qaGeneratedTests.testName,
      testType: qaGeneratedTests.testType,
      description: qaGeneratedTests.description,
      scriptSize: sql<number>`length(${qaGeneratedTests.script})`.as('script_size'),
    }).from(qaGeneratedTests).where(eq(qaGeneratedTests.projectId, projectId));
  },

  findTestsWithScriptByProjectId(projectId: number) {
    return db.select({
      id: qaGeneratedTests.id,
      name: qaGeneratedTests.testName,
      script: qaGeneratedTests.script,
    }).from(qaGeneratedTests).where(eq(qaGeneratedTests.projectId, projectId));
  },

  findExecutionsByProjectId(projectId: number, limit = 100) {
    return db.select().from(qaTestExecutions)
      .where(eq(qaTestExecutions.projectId, projectId))
      .orderBy(desc(qaTestExecutions.startedAt))
      .limit(limit);
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

  createTest(projectId: number, test: { testName: string; testType?: string; script: string; description?: string | null }) {
    return db.insert(qaGeneratedTests).values({ projectId, ...test }).returning();
  },

  createExecution(testId: number, projectId: number, status: string) {
    return db.insert(qaTestExecutions).values({ testId, projectId, status }).returning();
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
        ageSeconds: sql<number | null>`EXTRACT(EPOCH FROM (NOW() - ${qaProjects.lastRunAt}))::int`.as('age_seconds'),
      })
      .from(qaProjects)
      .where(eq(qaProjects.enabled, true));
  },
};
