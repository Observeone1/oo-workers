import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { qaGeneratedTests, qaProjects, qaTestExecutions } from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import {
  getObject,
  isStorageConfigured,
  putObject,
  qaScriptKey,
} from '../../services/object-storage.ts';
import { logger } from '../../utils/logger.ts';

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

  async findTestsByProjectId(projectId: number, opts: { includeScript?: boolean } = {}) {
    if (!opts.includeScript) {
      return db
        .select({
          id: qaGeneratedTests.id,
          testName: qaGeneratedTests.testName,
          testType: qaGeneratedTests.testType,
          description: qaGeneratedTests.description,
          scriptSize: sql<number>`length(${qaGeneratedTests.script})`.as('script_size'),
        })
        .from(qaGeneratedTests)
        .where(eq(qaGeneratedTests.projectId, projectId));
    }
    // Fetch both the inline script column and the script_url pointer; prefer
    // storage when available, fall back to inline on storage error or when
    // the row hasn't been backfilled yet.
    const rows = await db
      .select({
        id: qaGeneratedTests.id,
        name: qaGeneratedTests.testName,
        script: qaGeneratedTests.script,
        scriptUrl: qaGeneratedTests.scriptUrl,
      })
      .from(qaGeneratedTests)
      .where(eq(qaGeneratedTests.projectId, projectId));
    if (!isStorageConfigured()) {
      return rows.map(({ id, name, script }) => ({ id, name, script }));
    }
    return Promise.all(
      rows.map(async ({ id, name, script, scriptUrl }) => {
        if (scriptUrl) {
          try {
            return { id, name, script: await getObject(scriptUrl) };
          } catch (err) {
            logger.error(
              `qa-script storage GET failed for test ${id} (${scriptUrl}); using inline fallback: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        return { id, name, script };
      }),
    );
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

  async createTest(
    projectId: number,
    test: { testName: string; testType?: string; script: string; description?: string | null },
  ) {
    const inserted = await db
      .insert(qaGeneratedTests)
      .values({ projectId, ...test })
      .returning();
    await maybeUploadScripts(inserted);
    return inserted;
  },

  async createTests(
    projectId: number,
    rows: Array<{
      testName: string;
      testType?: string;
      script: string;
      description?: string | null;
    }>,
  ) {
    if (rows.length === 0) return [] as never[];
    const inserted = await db
      .insert(qaGeneratedTests)
      .values(rows.map((r) => ({ projectId, ...r })))
      .returning();
    await maybeUploadScripts(inserted);
    return inserted;
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

/**
 * Upload newly-inserted test scripts to object storage and stamp `script_url`
 * back onto each row. Best-effort: a storage outage just leaves rows with
 * NULL script_url (the inline column is the durable fallback, and the
 * boot-time backfill will retry later).
 */
async function maybeUploadScripts(
  rows: Array<typeof qaGeneratedTests.$inferSelect>,
): Promise<void> {
  if (!isStorageConfigured() || rows.length === 0) return;
  const projectId = rows[0]!.projectId;
  const [proj] = await db
    .select({ name: qaProjects.name })
    .from(qaProjects)
    .where(eq(qaProjects.id, projectId))
    .limit(1);
  const projectName = proj?.name ?? `project-${projectId}`;
  await Promise.all(
    rows.map(async (row) => {
      try {
        const key = qaScriptKey(projectId, projectName, row.id, row.testName ?? `test-${row.id}`);
        await putObject(key, row.script, 'text/typescript');
        await db
          .update(qaGeneratedTests)
          .set({ scriptUrl: key })
          .where(eq(qaGeneratedTests.id, row.id));
        row.scriptUrl = key;
      } catch (err) {
        logger.error(
          `qa-script storage PUT failed for test ${row.id}; backfill will retry: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );
}
