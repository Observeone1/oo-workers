#!/usr/bin/env bun
/**
 * Purge monitor/channel/region/status-page rows from the dev DB.
 *
 * Two modes:
 *   - default (no flag) — only e2e-/qa-e2e-/qg-/spotcheck-* prefixed
 *                          rows. Safe to run anywhere.
 *   - `--all`           — every monitor, channel, region, and status
 *                          page (TRUNCATE … CASCADE clears children:
 *                          executions, qa_tests, status_page_monitors,
 *                          incidents, monitor_regions, alert_logs).
 *                          Auth-related tables (users, sessions,
 *                          api_keys, schema_migrations) are NEVER
 *                          touched — those survive so the operator
 *                          doesn't have to re-run /setup on every
 *                          WSL restart.
 *
 * Called from two places:
 *   1) start-oo-workers.sh — runs `--all` after migrations, BEFORE
 *      the worker boots. Otherwise each enabled QA monitor that
 *      survived a crash gets re-scheduled and spawns Chromium
 *      (QA_PROJECT_CONCURRENCY=5), which is what crashed WSL under
 *      the e2e suite.
 *   2) tests/ui/global-setup.ts — runs `--all` before any Playwright
 *      spec executes, in case the worker has been up for hours
 *      accumulating cruft and you just want to e2e cleanly.
 *
 * Idempotent — safe to run multiple times. Returns count for logging.
 * Run: `bun scripts/purge-e2e-leftovers.ts [--all]` or via
 * package.json: `bun run purge:e2e` (prefixed-only) /
 * `bun run purge:e2e:all` (full).
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { sql as pg } from '../src/config/db.ts';

// Mirrors src/scheduler.ts — every BullMQ queue the master worker uses.
// Regional list keys (oo:jobs:<slug>) live outside BullMQ — see below.
const BULLMQ_QUEUES = [
  'url-monitor',
  'api-check',
  'qa-project',
  'tcp-monitor',
  'udp-monitor',
  'db-monitor',
  'tls-monitor',
] as const;

// src/scheduler.ts:regionalListKey() pattern. Agents long-poll these
// raw Redis lists; if regions get purged the lists become orphan.
const REGIONAL_LIST_KEY_PATTERN = 'oo:jobs:*';

const NAME_PREFIXES = ['e2e-', 'qa-e2e-', 'spotcheck-'] as const;
const SLUG_PREFIXES = ['e2e-', 'qa-e2e-', 'qg-', 'spotcheck-'] as const;

function namePattern(p: string): string {
  return `${p.replace(/[%_\\]/g, '\\$&')}%`;
}

const NAME_PATTERNS = NAME_PREFIXES.map(namePattern);
const SLUG_PATTERNS = SLUG_PREFIXES.map(namePattern);

// Parent tables. Their FKs ON DELETE CASCADE handle children:
// monitor → executions, qa_projects → qa_tests, status_pages →
// status_page_monitors + incidents + incident_updates, regions →
// monitor_regions, alert_channels → alert_logs.
const PARENT_NAME_TABLES = [
  'url_monitors',
  'api_checks',
  'qa_projects',
  'tcp_monitors',
  'udp_monitors',
  'db_monitors',
  'tls_monitors',
  'alert_channels',
] as const;
const PARENT_SLUG_TABLES = ['regions', 'status_pages'] as const;

// Auth survives — operator should not have to re-run /setup on every
// restart, and existing API keys / sessions stay valid for the
// dashboard + e2e bearer auth.
const PROTECTED_TABLES = ['users', 'sessions', 'api_keys', 'schema_migrations'] as const;

interface PurgeResult {
  mode: 'prefixed' | 'all';
  url_monitors: number;
  api_checks: number;
  qa_projects: number;
  tcp_monitors: number;
  udp_monitors: number;
  db_monitors: number;
  tls_monitors: number;
  alert_channels: number;
  regions: number;
  status_pages: number;
  total: number;
  // BullMQ queues obliterated (`--all` only). When the DB is wiped but
  // Redis isn't, queued jobs keep referencing dead IDs → FK insert
  // failures in qa_test_executions. Flushing both keeps them in sync.
  bullmq_queues_flushed: number;
  // Raw Redis lists (oo:jobs:<region-slug>) deleted (`--all` only).
  regional_lists_flushed: number;
}

async function deletePrefixed(
  table: string,
  column: 'name' | 'slug',
  patterns: readonly string[],
): Promise<number> {
  const r = (await pg.unsafe(
    `DELETE FROM ${table} WHERE ${column} LIKE ANY ($1::text[]) RETURNING id`,
    [patterns as unknown as string[]],
  )) as { length: number };
  return r.length;
}

/**
 * Flush every BullMQ queue + regional Redis list the worker dispatches
 * to. Without this, jobs queued before the DB purge keep firing with
 * dead IDs (FK insert failure spam in qa_test_executions etc.).
 *
 * `obliterate({ force: true })` clears all job states (waiting, delayed,
 * active, completed, failed) AND any repeatable schedulers — true reset.
 *
 * Returns { queues, regionalLists } so the CLI can report what got wiped.
 */
async function flushRedisQueues(): Promise<{ queues: number; regionalLists: number }> {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  let queues = 0;
  let regionalLists = 0;
  try {
    // BullMQ queues — one Queue() handle per name, obliterate, close.
    for (const name of BULLMQ_QUEUES) {
      const q = new Queue(name, { connection });
      try {
        await q.obliterate({ force: true });
        queues++;
      } finally {
        await q.close();
      }
    }
    // Regional list keys (oo:jobs:<slug>) — non-BullMQ raw Redis lists.
    // SCAN keeps the call non-blocking on large Redis instances.
    let cursor = '0';
    const toDelete: string[] = [];
    do {
      const [next, keys] = await connection.scan(
        cursor,
        'MATCH',
        REGIONAL_LIST_KEY_PATTERN,
        'COUNT',
        100,
      );
      cursor = next;
      toDelete.push(...keys);
    } while (cursor !== '0');
    if (toDelete.length > 0) {
      regionalLists = await connection.del(...toDelete);
    }
  } finally {
    await connection.quit();
  }
  return { queues, regionalLists };
}

async function truncateAll(table: string): Promise<number> {
  // Snapshot row count before TRUNCATE so we can report a number.
  // pg_class.reltuples is the planner estimate; the COUNT(*) is exact
  // and tiny on a dev DB. Race-free because we wrap in a single
  // transaction... actually TRUNCATE is fast enough we don't need a
  // tx — just count then truncate.
  const [{ count }] = (await pg.unsafe(`SELECT COUNT(*)::int AS count FROM ${table}`)) as Array<{
    count: number;
  }>;
  await pg.unsafe(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
  return Number(count);
}

export async function purgeE2eLeftovers(opts: { all?: boolean } = {}): Promise<PurgeResult> {
  const all = !!opts.all;
  const result: PurgeResult = {
    mode: all ? 'all' : 'prefixed',
    url_monitors: 0,
    api_checks: 0,
    qa_projects: 0,
    tcp_monitors: 0,
    udp_monitors: 0,
    db_monitors: 0,
    tls_monitors: 0,
    alert_channels: 0,
    regions: 0,
    status_pages: 0,
    total: 0,
    bullmq_queues_flushed: 0,
    regional_lists_flushed: 0,
  };

  if (all) {
    // TRUNCATE all parent tables; FK cascades sweep children + binding
    // tables in one go. Auth tables (PROTECTED_TABLES) are explicitly
    // NOT in the list — sanity-check below in case someone adds one.
    for (const t of [...PARENT_NAME_TABLES, ...PARENT_SLUG_TABLES]) {
      if ((PROTECTED_TABLES as readonly string[]).includes(t)) {
        throw new Error(`refusing to purge protected table: ${t}`);
      }
    }
    // Suppress "truncate cascades to table X" NOTICEs (postgres-js
    // dumps them to stderr by default, which makes a normal CASCADE
    // chain look like a flood of errors). Errors still come through.
    await pg.unsafe(`SET client_min_messages TO WARNING`);
    // Serialize TRUNCATEs — running them in parallel made the cascades
    // race on FK locks (the work still completed but emitted misleading
    // log noise). Sequential is plenty fast on a dev DB (<300ms total).
    const counts: number[] = [];
    for (const t of PARENT_NAME_TABLES) {
      counts.push(await truncateAll(t).catch(() => 0));
    }
    for (const t of PARENT_SLUG_TABLES) {
      counts.push(await truncateAll(t).catch(() => 0));
    }
    const [u, a, q, tc, ud, dbm, tl, ch, rg, sp] = counts;
    result.url_monitors = u;
    result.api_checks = a;
    result.qa_projects = q;
    result.tcp_monitors = tc;
    result.udp_monitors = ud;
    result.db_monitors = dbm;
    result.tls_monitors = tl;
    result.alert_channels = ch;
    result.regions = rg;
    result.status_pages = sp;

    // Flush BullMQ + regional lists AFTER the DB wipe. If we did it
    // before, the scheduler's next tick could re-enqueue jobs for
    // monitors that hadn't been deleted yet. After: DB is empty, no
    // tick can re-enqueue, the flush is permanent.
    const r = await flushRedisQueues().catch((e) => {
      console.error(
        `[purge-e2e --all] redis flush failed (continuing): ${e instanceof Error ? e.message : e}`,
      );
      return { queues: 0, regionalLists: 0 };
    });
    result.bullmq_queues_flushed = r.queues;
    result.regional_lists_flushed = r.regionalLists;
  } else {
    const nameDeletes = await Promise.all(
      PARENT_NAME_TABLES.map((t) => deletePrefixed(t, 'name', NAME_PATTERNS).catch(() => 0)),
    );
    const slugDeletes = await Promise.all(
      PARENT_SLUG_TABLES.map((t) => deletePrefixed(t, 'slug', SLUG_PATTERNS).catch(() => 0)),
    );
    const [u, a, q, tc, ud, dbm, tl, ch] = nameDeletes;
    const [rg, sp] = slugDeletes;
    result.url_monitors = u;
    result.api_checks = a;
    result.qa_projects = q;
    result.tcp_monitors = tc;
    result.udp_monitors = ud;
    result.db_monitors = dbm;
    result.tls_monitors = tl;
    result.alert_channels = ch;
    result.regions = rg;
    result.status_pages = sp;
  }

  result.total =
    result.url_monitors +
    result.api_checks +
    result.qa_projects +
    result.tcp_monitors +
    result.udp_monitors +
    result.db_monitors +
    result.tls_monitors +
    result.alert_channels +
    result.regions +
    result.status_pages;

  return result;
}

// Run as CLI when invoked directly.
if (import.meta.main) {
  const all = process.argv.slice(2).includes('--all');
  const t0 = Date.now();
  try {
    const r = await purgeE2eLeftovers({ all });
    const ms = Date.now() - t0;
    const tag = `purge-e2e ${all ? '--all' : '(prefixed)'}`;
    const parts = (Object.entries(r) as Array<[keyof PurgeResult, number | string]>)
      .filter(([k, v]) => k !== 'total' && k !== 'mode' && typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    if (r.total === 0 && !parts) {
      console.log(`[${tag}] nothing to clear (${ms}ms)`);
    } else {
      console.log(`[${tag}] cleared ${r.total} rows in ${ms}ms — ${parts}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`[purge-e2e] failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
