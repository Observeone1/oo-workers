/**
 * One-time-on-boot backfill: drain qa_generated_tests rows that have inline
 * `script` content but no `script_url` yet. Idempotent — re-running after a
 * crash picks up where it left off. Runs in the worker process (master
 * role), not the UI, so a slow upload doesn't block UI boot.
 *
 * Best-effort: any individual row failure logs + continues with the next.
 * The boot path doesn't await this — it spins it off as a background task.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { qaGeneratedTests } from '../db/schema.ts';
import { isStorageConfigured, putObject, qaScriptKey } from './object-storage.ts';
import { logger } from '../utils/logger.ts';

const BATCH = 50;

export async function runBackfill(): Promise<{
  uploaded: number;
  failed: number;
  total: number;
}> {
  if (!isStorageConfigured()) {
    logger.info('storage-backfill: skipped (OO_OBJECT_STORAGE_* not configured)');
    return { uploaded: 0, failed: 0, total: 0 };
  }
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(qaGeneratedTests)
    .where(and(isNull(qaGeneratedTests.scriptUrl), isNotNull(qaGeneratedTests.script)));
  if (total === 0) {
    logger.info('storage-backfill: nothing to do');
    return { uploaded: 0, failed: 0, total: 0 };
  }
  logger.info(`storage-backfill: ${total} qa test scripts to upload`);

  let uploaded = 0;
  let failed = 0;

  while (true) {
    const batch = await db
      .select({
        id: qaGeneratedTests.id,
        script: qaGeneratedTests.script,
      })
      .from(qaGeneratedTests)
      .where(and(isNull(qaGeneratedTests.scriptUrl), isNotNull(qaGeneratedTests.script)))
      .limit(BATCH);

    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async ({ id, script }) => {
        try {
          const key = qaScriptKey(id);
          await putObject(key, script, 'text/typescript');
          await db
            .update(qaGeneratedTests)
            .set({ scriptUrl: key })
            .where(eq(qaGeneratedTests.id, id));
          uploaded++;
        } catch (err) {
          failed++;
          logger.error(
            `storage-backfill: failed test ${id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }),
    );

    logger.info(`storage-backfill: progress ${uploaded + failed}/${total} (${failed} failures)`);

    // If a batch all failed (likely storage outage), stop — don't tight-loop.
    if (failed >= batch.length && uploaded === 0) {
      logger.error('storage-backfill: aborting — every row in this batch failed');
      break;
    }
  }

  logger.info(
    `storage-backfill: done — ${uploaded} uploaded, ${failed} failed, of ${total} pending`,
  );
  return { uploaded, failed, total };
}
