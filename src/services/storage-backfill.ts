/**
 * Boot-time storage maintenance for QA test scripts:
 *
 * 1. **Upload** — qa_generated_tests rows with inline `script` but no
 *    `script_url` (pre-v1.0.0 rows) are uploaded to object storage.
 * 2. **Migrate** — rows whose `script_url` is in the legacy
 *    `qa-scripts/<id>.spec.ts` layout (v1.0.0 → v1.0.1) are copied to
 *    the new `qa-projects/<project-id>-<slug>/<test-id>-<slug>.spec.ts`
 *    layout and the old object is deleted.
 *
 * Both passes are idempotent — re-running after a crash picks up where
 * it left off. Best-effort: per-row failures log and continue.
 */

import { and, eq, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { qaGeneratedTests, qaProjects } from '../db/schema.ts';
import {
  isLegacyQaScriptKey,
  isStorageConfigured,
  moveObject,
  putObject,
  qaScriptKey,
} from './object-storage.ts';
import { logger } from '../utils/logger.ts';

const BATCH = 50;

export async function runBackfill(): Promise<{
  uploaded: number;
  migrated: number;
  failed: number;
}> {
  if (!isStorageConfigured()) {
    logger.info('storage-backfill: skipped (OO_OBJECT_STORAGE_* not configured)');
    return { uploaded: 0, migrated: 0, failed: 0 };
  }
  const uploaded = await uploadPending();
  const migrated = await migrateLegacy();
  logger.info(
    `storage-backfill: done — uploaded=${uploaded.uploaded} migrated=${migrated.migrated} failed=${uploaded.failed + migrated.failed}`,
  );
  return {
    uploaded: uploaded.uploaded,
    migrated: migrated.migrated,
    failed: uploaded.failed + migrated.failed,
  };
}

async function uploadPending(): Promise<{ uploaded: number; failed: number }> {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(qaGeneratedTests)
    .where(and(isNull(qaGeneratedTests.scriptUrl), isNotNull(qaGeneratedTests.script)));
  if (total === 0) return { uploaded: 0, failed: 0 };
  logger.info(`storage-backfill: ${total} qa test scripts to upload`);

  let uploaded = 0;
  let failed = 0;

  while (true) {
    const batch = await db
      .select({
        id: qaGeneratedTests.id,
        projectId: qaGeneratedTests.projectId,
        testName: qaGeneratedTests.testName,
        script: qaGeneratedTests.script,
        projectName: qaProjects.name,
      })
      .from(qaGeneratedTests)
      .leftJoin(qaProjects, eq(qaProjects.id, qaGeneratedTests.projectId))
      .where(and(isNull(qaGeneratedTests.scriptUrl), isNotNull(qaGeneratedTests.script)))
      .limit(BATCH);

    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async ({ id, projectId, testName, script, projectName }) => {
        try {
          const key = qaScriptKey(
            projectId,
            projectName ?? `project-${projectId}`,
            id,
            testName ?? `test-${id}`,
          );
          await putObject(key, script, 'text/typescript');
          await db
            .update(qaGeneratedTests)
            .set({ scriptUrl: key })
            .where(eq(qaGeneratedTests.id, id));
          uploaded++;
        } catch (err) {
          failed++;
          logger.error(
            `storage-backfill: upload failed for test ${id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }),
    );

    logger.info(`storage-backfill: upload progress ${uploaded + failed}/${total}`);
    if (failed >= batch.length && uploaded === 0) {
      logger.error('storage-backfill: aborting upload — every row in this batch failed');
      break;
    }
  }
  return { uploaded, failed };
}

async function migrateLegacy(): Promise<{ migrated: number; failed: number }> {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(qaGeneratedTests)
    .where(like(qaGeneratedTests.scriptUrl, 'qa-scripts/%'));
  if (total === 0) return { migrated: 0, failed: 0 };
  logger.info(`storage-backfill: ${total} qa scripts to migrate from legacy layout`);

  let migrated = 0;
  let failed = 0;

  while (true) {
    const batch = await db
      .select({
        id: qaGeneratedTests.id,
        projectId: qaGeneratedTests.projectId,
        testName: qaGeneratedTests.testName,
        scriptUrl: qaGeneratedTests.scriptUrl,
        projectName: qaProjects.name,
      })
      .from(qaGeneratedTests)
      .leftJoin(qaProjects, eq(qaProjects.id, qaGeneratedTests.projectId))
      .where(like(qaGeneratedTests.scriptUrl, 'qa-scripts/%'))
      .limit(BATCH);

    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async ({ id, projectId, testName, scriptUrl, projectName }) => {
        if (!scriptUrl || !isLegacyQaScriptKey(scriptUrl)) return;
        const newKey = qaScriptKey(
          projectId,
          projectName ?? `project-${projectId}`,
          id,
          testName ?? `test-${id}`,
        );
        try {
          await moveObject(scriptUrl, newKey);
          await db
            .update(qaGeneratedTests)
            .set({ scriptUrl: newKey })
            .where(eq(qaGeneratedTests.id, id));
          migrated++;
        } catch (err) {
          failed++;
          logger.error(
            `storage-backfill: migrate failed for test ${id} (${scriptUrl} -> ${newKey}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }),
    );

    logger.info(`storage-backfill: migrate progress ${migrated + failed}/${total}`);
    if (failed >= batch.length && migrated === 0) {
      logger.error('storage-backfill: aborting migrate — every row in this batch failed');
      break;
    }
  }
  return { migrated, failed };
}
