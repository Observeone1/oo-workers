#!/usr/bin/env bun
/**
 * Wipe dev data (keep users + api_keys + sessions + schema_migrations) and
 * seed a small fixture set with real S3 artifacts. Lets the Backup dialog
 * show a non-zero artifact count + size estimate without needing the QA
 * pipeline to have run.
 *
 * Run: bun scripts/seed-dev.ts
 */

import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import {
  deleteObject,
  listObjects,
  putObject,
  qaRunArtifactKey,
  qaScriptKey,
} from '../src/services/object-storage';

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('DATABASE_URL required');
  process.exit(2);
}

const KEEP = new Set(['users', 'api_keys', 'sessions', 'schema_migrations']);

const sql = postgres(DB, { max: 1, onnotice: () => {} });

async function wipeDb() {
  const tables = (
    await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `
  ).map((r) => r.tablename);
  const toWipe = tables.filter((t) => !KEEP.has(t));
  if (toWipe.length === 0) return;
  await sql.unsafe(`TRUNCATE ${toWipe.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  console.log(`  wiped ${toWipe.length} tables (kept ${[...KEEP].join(', ')})`);
}

async function wipeBucket() {
  const keys = await listObjects('');
  for (const k of keys) await deleteObject(k).catch(() => {});
  console.log(`  wiped ${keys.length} S3 object${keys.length === 1 ? '' : 's'}`);
}

async function seed() {
  // 1) A URL monitor + one successful execution.
  const [um] = await sql<{ id: number }[]>`
    INSERT INTO url_monitors (name, url, interval_seconds, timeout_ms)
    VALUES ('example.com', 'https://example.com', 60, 5000)
    RETURNING id
  `;
  await sql`
    INSERT INTO url_monitor_executions (url_monitor_id, status, status_code, start_time, response_time_ms)
    VALUES (${um.id}, 'SUCCESS', 200, NOW(), 142)
  `;

  // 2) A QA project + a generated test with script bytes in S3.
  const [qp] = await sql<{ id: number; name: string }[]>`
    INSERT INTO qa_projects (name, target_url, config, credentials)
    VALUES ('demo-qa', 'https://example.com', ${sql.json({ headed: false })}, ${sql.json({})})
    RETURNING id, name
  `;
  const scriptBody = `import { test, expect } from '@playwright/test';

test('homepage loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
`;
  // qa_generated_tests.script is a legacy NOT NULL column (the inline
  // pre-v1.0 storage). Post-v1.0 the canonical home is script_url → S3,
  // but the column still exists; pass a placeholder so the insert passes.
  const [qt] = await sql<{ id: number; test_name: string }[]>`
    INSERT INTO qa_generated_tests (project_id, test_name, test_type, script, script_url)
    VALUES (${qp.id}, 'homepage-loads', 'browser', ${scriptBody}, ${qaScriptKey(qp.id, qp.name, 1, 'homepage-loads')})
    RETURNING id, test_name
  `;
  // re-anchor the key to the now-known test id
  const realScriptKey = qaScriptKey(qp.id, qp.name, qt.id, qt.test_name);
  await sql`UPDATE qa_generated_tests SET script_url = ${realScriptKey} WHERE id = ${qt.id}`;
  await putObject(realScriptKey, scriptBody, 'text/typescript');

  // 3) A QA execution with synthetic trace.zip + screenshot artifacts.
  const [qe] = await sql<{ id: number }[]>`
    INSERT INTO qa_test_executions (test_id, project_id, status, duration_ms, started_at)
    VALUES (${qt.id}, ${qp.id}, 'FAILURE', 4321, NOW())
    RETURNING id
  `;
  const traceKey = qaRunArtifactKey(qp.id, qp.name, qe.id, 'trace.zip');
  const shotKey = qaRunArtifactKey(qp.id, qp.name, qe.id, 'screenshot-0.png');
  // Plausible non-zero blobs so the estimate is meaningful.
  await putObject(traceKey, randomBytes(32 * 1024), 'application/zip');
  await putObject(shotKey, randomBytes(8 * 1024), 'image/png');
  await sql`
    UPDATE qa_test_executions
       SET trace_url = ${traceKey},
           screenshot_urls = ${sql.json([shotKey])}
     WHERE id = ${qe.id}
  `;

  return {
    url_monitor: um.id,
    qa_project: qp.id,
    qa_test: qt.id,
    qa_execution: qe.id,
    s3_objects: [realScriptKey, traceKey, shotKey],
  };
}

async function main() {
  console.log('▸ wiping DB (keeping auth)...');
  await wipeDb();
  console.log('▸ wiping S3 bucket...');
  await wipeBucket();
  console.log('▸ seeding fixtures...');
  const seeded = await seed();
  console.log('✓ done. seeded:');
  console.log(
    `  url_monitor=${seeded.url_monitor}  qa_project=${seeded.qa_project}  qa_test=${seeded.qa_test}  qa_execution=${seeded.qa_execution}`,
  );
  console.log(`  S3: ${seeded.s3_objects.length} objects`);
  for (const k of seeded.s3_objects) console.log(`    ${k}`);
}

try {
  await main();
} finally {
  await sql.end();
}
