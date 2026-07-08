import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import {
  monitorRegions,
  qaGeneratedTests,
  qaProjects,
  qaRuns,
  qaTestExecutions,
} from '../schema.ts';
import { projectStalled } from '../../services/exec-projection.ts';
import {
  deleteObject,
  getObject,
  isStorageConfigured,
  putObject,
  qaScriptKey,
} from '../../services/object-storage.ts';
import { logger } from '../../utils/logger.ts';
import { projectLatest } from './_with-latest.ts';

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
      latest: projectLatest(l, p.intervalSeconds, (l, proj) => ({
        id: l.id as number,
        status: proj.status,
        durationMs: l.durationMs,
        errorMessage: proj.errorMessage,
        startTime: l.startTime,
      })),
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
    // Alias startedAt → startTime so the UI's shared RunLite shape works
    // for QA executions the same way it does for url/api/tcp/udp. Without
    // this the detail page renders "never" for every row.
    const rows = await db
      .select({
        id: qaTestExecutions.id,
        status: qaTestExecutions.status,
        errorMessage: qaTestExecutions.errorMessage,
        logs: qaTestExecutions.logs,
        durationMs: qaTestExecutions.durationMs,
        startTime: qaTestExecutions.startedAt,
        completedAt: qaTestExecutions.completedAt,
        regionId: qaTestExecutions.regionId,
        testId: qaTestExecutions.testId,
        projectId: qaTestExecutions.projectId,
        traceUrl: qaTestExecutions.traceUrl,
        screenshotUrls: qaTestExecutions.screenshotUrls,
      })
      .from(qaTestExecutions)
      .where(eq(qaTestExecutions.projectId, projectId))
      .orderBy(desc(qaTestExecutions.startedAt))
      .limit(limit);
    if (!p) return rows;
    return rows.map((r) => projectStalled(r, r.startTime, p.intervalSeconds));
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
    runId: number | null = null,
  ) {
    return db
      .insert(qaTestExecutions)
      .values({ testId, projectId, status, regionId, runId })
      .returning();
  },

  // A QA run groups the per-test executions. region_id NULL = master-run.
  createRun(data: { projectId: number; regionId: number | null; expectedTests: number }) {
    return db.insert(qaRuns).values(data).returning();
  },

  async findRunById(runId: number) {
    const [r] = await db.select().from(qaRuns).where(eq(qaRuns.id, runId)).limit(1);
    return r ?? null;
  },

  /**
   * Progress for the count-based completion trigger: how many of the run's
   * expected tests have a completedAt, and how many of those are "down"
   * (FAILED/FAILURE/ERROR — the normalizeOutcome down set). A run is done
   * once `completed >= expectedTests`.
   */
  async runProgress(
    runId: number,
  ): Promise<{ expectedTests: number; completed: number; downCount: number } | null> {
    const [row] = await db
      .select({
        expectedTests: qaRuns.expectedTests,
        completed: sql<number>`COUNT(${qaTestExecutions.id}) FILTER (WHERE ${qaTestExecutions.completedAt} IS NOT NULL)::int`,
        downCount: sql<number>`COUNT(${qaTestExecutions.id}) FILTER (WHERE ${qaTestExecutions.completedAt} IS NOT NULL AND UPPER(${qaTestExecutions.status}) IN ('FAILED','FAILURE','ERROR'))::int`,
      })
      .from(qaRuns)
      .leftJoin(qaTestExecutions, eq(qaTestExecutions.runId, qaRuns.id))
      .where(eq(qaRuns.id, runId))
      .groupBy(qaRuns.id, qaRuns.expectedTests);
    return row ?? null;
  },

  /**
   * Atomically claim the one-shot alert for a run: sets outcome + alertedAt
   * only if alertedAt was still NULL. Returns true iff THIS call won the
   * claim, so exactly one caller (even under the concurrent last-two-results
   * race) proceeds to fire the transition alert.
   */
  async claimRunAlert(runId: number, outcome: 'SUCCESS' | 'FAILED'): Promise<boolean> {
    const rows = await db
      .update(qaRuns)
      .set({ outcome, alertedAt: new Date() })
      .where(and(eq(qaRuns.id, runId), isNull(qaRuns.alertedAt)))
      .returning({ id: qaRuns.id });
    return rows.length === 1;
  },

  /**
   * True iff the given QA project has a `monitor_regions` row pinning it
   * to `regionId`. Used by the agent-side `POST /api/agent/qa/executions`
   * to reject create requests for projects not bound to the caller's region.
   */
  async isProjectBoundToRegion(projectId: number, regionId: number): Promise<boolean> {
    const rows = await db
      .select({ id: monitorRegions.regionId })
      .from(monitorRegions)
      .where(
        and(
          eq(monitorRegions.monitorType, 'qa'),
          eq(monitorRegions.monitorId, projectId),
          eq(monitorRegions.regionId, regionId),
        ),
      )
      .limit(1);
    return rows.length === 1;
  },

  /**
   * Look up the (testId, projectId) pairs for the given test IDs, scoped
   * to a single project. Used by the agent create-executions endpoint to
   * validate the request before issuing INSERTs.
   */
  async findTestsByIds(projectId: number, testIds: number[]) {
    if (testIds.length === 0) return [];
    return db
      .select({ id: qaGeneratedTests.id })
      .from(qaGeneratedTests)
      .where(and(eq(qaGeneratedTests.projectId, projectId), inArray(qaGeneratedTests.id, testIds)));
  },

  /**
   * Look up `(id, projectId)` for a single exec row. Used by the agent
   * artifact-upload endpoint to verify the execution belongs to a project
   * bound to the caller's region before streaming to RustFS.
   */
  async findExecutionById(executionId: number) {
    const rows = await db
      .select({
        id: qaTestExecutions.id,
        projectId: qaTestExecutions.projectId,
        regionId: qaTestExecutions.regionId,
      })
      .from(qaTestExecutions)
      .where(eq(qaTestExecutions.id, executionId))
      .limit(1);
    return rows[0] ?? null;
  },

  async findProjectNameById(projectId: number): Promise<string | null> {
    const rows = await db
      .select({ name: qaProjects.name })
      .from(qaProjects)
      .where(eq(qaProjects.id, projectId))
      .limit(1);
    return rows[0]?.name ?? null;
  },

  updateExecution(id: number, data: Partial<typeof qaTestExecutions.$inferInsert>) {
    return db.update(qaTestExecutions).set(data).where(eq(qaTestExecutions.id, id));
  },

  touchLastRunAt(projectId: number) {
    return db.update(qaProjects).set({ lastRunAt: new Date() }).where(eq(qaProjects.id, projectId));
  },

  update(id: number, data: Partial<{ name: string; targetUrl: string; intervalSeconds: number }>) {
    return db.update(qaProjects).set(data).where(eq(qaProjects.id, id)).returning();
  },

  async updateFirstTestScript(projectId: number, script: string) {
    const [first] = await db
      .select({ id: qaGeneratedTests.id })
      .from(qaGeneratedTests)
      .where(eq(qaGeneratedTests.projectId, projectId))
      .orderBy(qaGeneratedTests.id)
      .limit(1);
    if (!first) return [];
    return db
      .update(qaGeneratedTests)
      .set({ script })
      .where(eq(qaGeneratedTests.id, first.id))
      .returning();
  },

  updateEnabled(id: number, enabled: boolean) {
    return db.update(qaProjects).set({ enabled }).where(eq(qaProjects.id, id));
  },

  async deleteById(id: number) {
    // Collect storage keys before the row (and cascaded tests + executions)
    // disappear, so we can drop the objects in storage too. Three sources:
    // test scripts (script_url), per-run traces (trace_url), and per-run
    // screenshots (screenshot_urls jsonb array). Best-effort: a failed
    // delete here logs and continues — the row is gone either way, and
    // the boot-time orphan sweep is the durable backstop.
    const keys: string[] = [];
    if (isStorageConfigured()) {
      const scriptRows = await db
        .select({ scriptUrl: qaGeneratedTests.scriptUrl })
        .from(qaGeneratedTests)
        .where(eq(qaGeneratedTests.projectId, id));
      for (const r of scriptRows) if (r.scriptUrl) keys.push(r.scriptUrl);

      const artifactRows = await db
        .select({
          traceUrl: qaTestExecutions.traceUrl,
          screenshotUrls: qaTestExecutions.screenshotUrls,
        })
        .from(qaTestExecutions)
        .where(eq(qaTestExecutions.projectId, id));
      for (const r of artifactRows) {
        if (r.traceUrl) keys.push(r.traceUrl);
        if (Array.isArray(r.screenshotUrls)) keys.push(...r.screenshotUrls);
      }
    }
    await db.delete(qaProjects).where(eq(qaProjects.id, id));
    if (keys.length === 0) return;
    await Promise.all(
      keys.map(async (key) => {
        try {
          await deleteObject(key);
        } catch (err) {
          logger.error(
            `qa-storage DELETE failed for ${key}; boot-time sweep will retry: ${err instanceof Error ? err.message : err}`,
          );
        }
      }),
    );
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
