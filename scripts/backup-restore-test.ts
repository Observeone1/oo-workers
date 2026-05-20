#!/usr/bin/env bun
/**
 * End-to-end backup/restore round-trip — the gating automated test.
 *
 * Restore TRUNCATEs every table, so this must NEVER touch the shared
 * integration DB. It derives sibling databases from DATABASE_URL
 * (`oo_br_src/_all/_win/_split`), CREATEs them via the `postgres`
 * maintenance DB, exercises the real `export.ts`/`import.ts` CLIs against
 * them, and DROPs them in a finally. `oo_workers` is never opened.
 *
 * Run standalone: `bun scripts/backup-restore-test.ts`
 * Also a stage in scripts/run-integration.sh (pre-push + CI integration).
 *
 * `--seed` is an internal re-exec mode: the orchestrator spawns this file
 * with DATABASE_URL pointed at oo_br_src so the drizzle singleton binds to
 * the right DB; it seeds one row of every config table plus, for each of
 * the seven execution tables, one recent and one >120d-old row.
 */

import postgres from 'postgres';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';

const REPO = resolve(import.meta.dir, '..');
const SELF = import.meta.path;
const OLD_DAYS = 200; // outside the 90d window
const RECENT_DAYS = 1; // inside

// SQL table names in FK order (mirrors src/services/backup.ts TABLES).
const CONFIG_TABLES = [
  'api_keys',
  'users',
  'regions',
  'url_monitors',
  'api_checks',
  'tcp_monitors',
  'udp_monitors',
  'db_monitors',
  'tls_monitors',
  'qa_projects',
  'url_monitor_assertions',
  'api_assertions',
  'qa_generated_tests',
  'alert_channels',
  'monitor_alert_channels',
  'monitor_regions',
  'status_pages',
  'status_page_monitors',
  'incidents',
  'incident_updates',
];
const EXEC_TABLES = [
  'url_monitor_executions',
  'api_executions',
  'tcp_executions',
  'udp_executions',
  'db_executions',
  'tls_executions',
  'qa_test_executions',
];
const ALL_TABLES = [...CONFIG_TABLES, ...EXEC_TABLES];

// ---------------------------------------------------------------- seed mode

async function seed() {
  // Dynamic import so the orchestrator path never binds the db singleton.
  const { db, sql } = await import('../src/config/db.ts');
  const s = await import('../src/db/schema.ts');
  const OLD = new Date(Date.now() - OLD_DAYS * 86_400_000);
  const NEW = new Date(Date.now() - RECENT_DAYS * 86_400_000);

  const [key] = await db
    .insert(s.apiKeys)
    .values({ name: 'br', keyPrefix: 'oo_brbrbr', keyHash: 'h', scopes: ['write', 'read'] })
    .returning();
  await db.insert(s.users).values({ email: 'br@x.io', passwordHash: 'p', name: 'BR' });
  const [region] = await db
    .insert(s.regions)
    .values({ slug: 'br-eu', label: 'EU', apiKeyId: key.id })
    .returning();

  const [um] = await db
    .insert(s.urlMonitors)
    .values({ name: 'br-url', url: 'https://x.io' })
    .returning();
  await db
    .insert(s.urlMonitorAssertions)
    .values({ urlMonitorId: um.id, operator: 'eq', statusCode: 200 });
  const [ac] = await db
    .insert(s.apiChecks)
    .values({ name: 'br-api', url: 'https://x.io/api', headers: { 'x-a': 'b' } })
    .returning();
  await db
    .insert(s.apiAssertions)
    .values({ apiCheckId: ac.id, type: 'status', operator: 'eq', value: '200' });
  const [tm] = await db
    .insert(s.tcpMonitors)
    .values({ name: 'br-tcp', host: 'x.io', port: 22 })
    .returning();
  const [udm] = await db
    .insert(s.udpMonitors)
    .values({ name: 'br-udp', host: 'x.io', port: 53 })
    .returning();
  const [dm] = await db
    .insert(s.dbMonitors)
    .values({ name: 'br-db', protocol: 'redis', host: 'x.io', port: 6379, tls: true })
    .returning();
  const [tlsm] = await db
    .insert(s.tlsMonitors)
    .values({ name: 'br-tls', host: 'x.io', port: 443, warnDays: 30 })
    .returning();
  const [qp] = await db
    .insert(s.qaProjects)
    .values({
      name: 'br-qa',
      targetUrl: 'https://x.io',
      config: { headed: false },
      credentials: { u: 'a' },
    })
    .returning();
  const [qt] = await db
    .insert(s.qaGeneratedTests)
    .values({
      projectId: qp.id,
      testName: 't1',
      testType: 'browser',
      script: "test('t', async () => {});",
    })
    .returning();
  const [ch] = await db
    .insert(s.alertChannels)
    .values({ name: 'br-ch', type: 'webhook', config: { url: 'https://hook' } })
    .returning();
  await db
    .insert(s.monitorAlertChannels)
    .values({ monitorType: 'url', monitorId: um.id, channelId: ch.id });
  await db
    .insert(s.monitorRegions)
    .values({ monitorType: 'url', monitorId: um.id, regionId: region.id });
  const [sp] = await db.insert(s.statusPages).values({ slug: 'br-sp', title: 'BR' }).returning();
  await db
    .insert(s.statusPageMonitors)
    .values({ statusPageId: sp.id, monitorType: 'url', monitorId: um.id });
  const [inc] = await db
    .insert(s.incidents)
    .values({ statusPageId: sp.id, title: 'br-incident', severity: 'investigating' })
    .returning();
  await db
    .insert(s.incidentUpdates)
    .values({ incidentId: inc.id, severity: 'investigating', body: 'seed **body**' });

  // Every execution table: one recent + one >120d old.
  for (const t of [NEW, OLD]) {
    await db.insert(s.urlMonitorExecutions).values({
      urlMonitorId: um.id,
      regionId: region.id,
      status: 'SUCCESS',
      statusCode: 200,
      startTime: t,
    });
    await db.insert(s.apiExecutions).values({
      apiCheckId: ac.id,
      status: 'SUCCESS',
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      assertionResults: [{ ok: true }],
      startTime: t,
    });
    await db
      .insert(s.tcpExecutions)
      .values({ tcpMonitorId: tm.id, status: 'SUCCESS', latencyMs: 12, startTime: t });
    await db
      .insert(s.udpExecutions)
      .values({ udpMonitorId: udm.id, status: 'SUCCESS', latencyMs: 7, startTime: t });
    await db
      .insert(s.dbExecutions)
      .values({ dbMonitorId: dm.id, status: 'SUCCESS', latencyMs: 3, startTime: t });
    await db.insert(s.tlsExecutions).values({
      tlsMonitorId: tlsm.id,
      status: 'SUCCESS',
      latencyMs: 9,
      daysRemaining: 45,
      validTo: new Date('2027-01-01T00:00:00Z'),
      certSummary: 'CN=x.io; issuer=br; valid_to=Jan  1 00:00:00 2027 GMT',
      startTime: t,
    });
    await db.insert(s.qaTestExecutions).values({
      testId: qt.id,
      projectId: qp.id,
      status: 'SUCCESS',
      durationMs: 99,
      screenshotUrls: ['runs/1/a.png'],
      startedAt: t,
    });
  }
  await sql.end();
}

// --------------------------------------------------------- orchestrator util

const BASE = process.env.DATABASE_URL;
function dbUrl(name: string): string {
  const u = new URL(BASE!);
  u.pathname = '/' + name;
  return u.toString();
}

interface RunResult {
  code: number;
  stderr: string;
}
async function run(cmd: string[], dbName: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: dbUrl(dbName) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode ?? 0, stderr };
}

async function counts(dbName: string): Promise<Record<string, number>> {
  const sql = postgres(dbUrl(dbName), { max: 1, onnotice: () => {} });
  try {
    const out: Record<string, number> = {};
    for (const t of ALL_TABLES) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(t)}`;
      out[t] = n;
    }
    return out;
  } finally {
    await sql.end();
  }
}

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// --------------------------------------------------------------- orchestrate

async function main() {
  if (process.argv.includes('--seed')) return seed();

  if (!BASE) {
    console.error('DATABASE_URL required');
    process.exit(2);
  }

  const SIBS = ['oo_br_src', 'oo_br_all', 'oo_br_win', 'oo_br_split'];
  let admin: ReturnType<typeof postgres> | null = null;
  try {
    admin = postgres(dbUrl('postgres'), { max: 1, onnotice: () => {} });
    // Capability probe — a non-superuser local role is a visible skip, not
    // a false green (mirrors fixtures.ts ensureSessionAccount posture).
    try {
      await admin`SELECT 1`;
      await admin.unsafe('DROP DATABASE IF EXISTS oo_br_probe');
      await admin.unsafe('CREATE DATABASE oo_br_probe');
      await admin.unsafe('DROP DATABASE oo_br_probe');
    } catch (e) {
      console.warn(
        `[backup-restore-test] SKIPPED: cannot CREATE DATABASE as this role ` +
          `(${e instanceof Error ? e.message : e}). Backup/restore coverage is ` +
          `dark this run — use a superuser DATABASE_URL to exercise it.`,
      );
      return;
    }
    for (const db of SIBS) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${db}`);
    }

    // Migrate every sibling — proves the dump's pinned schema head is real.
    for (const db of SIBS) {
      const m = await run(['bun', resolve(REPO, 'src/db/migrate.ts')], db);
      if (m.code !== 0) {
        check(`migrate ${db}`, false, m.stderr.trim().split('\n').pop());
        return;
      }
    }
    check('migrate 4 sibling DBs', true);

    // Seed src via the --seed re-exec (binds the singleton to oo_br_src).
    const sd = await run(['bun', SELF, '--seed'], 'oo_br_src');
    check('seed oo_br_src', sd.code === 0, sd.stderr.trim().split('\n').pop());
    if (sd.code !== 0) return;

    const tmp = mkdtempSync(resolve(tmpdir(), 'oo-br-'));
    const allGz = resolve(tmp, 'all.oodump.gz');
    const winGz = resolve(tmp, 'win.oodump.gz');
    const splitDir = resolve(tmp, 'split');
    const badGz = resolve(tmp, 'bad.oodump.gz');
    const exp = resolve(REPO, 'scripts/export.ts');
    const imp = resolve(REPO, 'scripts/import.ts');

    try {
      // Export the three forms from src.
      const e1 = await run(['bun', exp, '--scope', 'all', '-o', allGz], 'oo_br_src');
      const e2 = await run(['bun', exp, '-o', winGz], 'oo_br_src'); // default = 90d window
      const e3 = await run(['bun', exp, '--scope', 'all', '--split', splitDir], 'oo_br_src');
      check('export all/window/split', e1.code === 0 && e2.code === 0 && e3.code === 0);

      const src = await counts('oo_br_src');

      // 1) round-trip (scope all): empty oo_br_all == src exactly.
      const r1 = await run(['bun', imp, '--from', allGz], 'oo_br_all');
      const all = await counts('oo_br_all');
      check(
        'round-trip scope=all (counts identical)',
        r1.code === 0 && eq(src, all),
        r1.code !== 0 ? r1.stderr.trim().split('\n').pop() : diff(src, all),
      );

      // 2) window cutoff applied to EVERY execution table independently.
      const r2 = await run(['bun', imp, '--from', winGz], 'oo_br_win');
      const win = await counts('oo_br_win');
      let windowOk = r2.code === 0;
      let wdetail = '';
      for (const t of CONFIG_TABLES) {
        if (win[t] !== src[t]) {
          windowOk = false;
          wdetail += ` config ${t} ${src[t]}->${win[t]};`;
        }
      }
      for (const t of EXEC_TABLES) {
        if (win[t] !== src[t] - 1) {
          windowOk = false;
          wdetail += ` ${t} ${src[t]}->${win[t]} (want ${src[t] - 1});`;
        }
      }
      check('window scope: each exec table drops exactly its >120d row', windowOk, wdetail.trim());

      // 3) single == split.
      const r3 = await run(['bun', imp, '--from', splitDir], 'oo_br_split');
      const split = await counts('oo_br_split');
      check(
        'single-file == split (counts identical)',
        r3.code === 0 && eq(all, split),
        r3.code !== 0 ? r3.stderr.trim().split('\n').pop() : diff(all, split),
      );

      // 4) force semantics on the now-populated oo_br_all.
      const noForce = await run(['bun', imp, '--from', allGz], 'oo_br_all');
      check(
        'restore refuses non-empty target without --force',
        noForce.code !== 0 && /not empty/i.test(noForce.stderr),
        noForce.stderr.trim().split('\n').pop(),
      );
      const withForce = await run(['bun', imp, '--from', allGz, '--force'], 'oo_br_all');
      const reAll = await counts('oo_br_all');
      check(
        '--force wipes + restores (counts back to src)',
        withForce.code === 0 && eq(src, reAll),
        diff(src, reAll),
      );

      // 5) setval + FK/jsonb/array fidelity on oo_br_all.
      const probe = postgres(dbUrl('oo_br_all'), { max: 1, onnotice: () => {} });
      try {
        const [{ mx }] = await probe`SELECT COALESCE(MAX(id),0)::int AS mx FROM url_monitors`;
        // A broken setval leaves the sequence at 1 → this insert throws a
        // duplicate-key. Catch it so it's a clean FAIL, not a crash.
        let newId: number | null = null;
        try {
          const [ins] =
            await probe`INSERT INTO url_monitors (name, url) VALUES ('post', 'https://p.io') RETURNING id`;
          newId = ins.id as number;
        } catch (e) {
          check(
            'setval: post-restore insert gets fresh id (no PK collision)',
            false,
            e instanceof Error ? e.message : String(e),
          );
        }
        if (newId !== null)
          check(
            'setval: post-restore insert gets fresh id (no PK collision)',
            newId === mx + 1,
            `max=${mx} new=${newId}`,
          );
        const [{ joined }] =
          await probe`SELECT count(*)::int AS joined FROM url_monitor_executions e JOIN url_monitors m ON m.id = e.url_monitor_id`;
        const [{ hdr }] = await probe`SELECT headers->>'x-a' AS hdr FROM api_checks LIMIT 1`;
        const [{ scopes }] = await probe`SELECT scopes FROM api_keys LIMIT 1`;
        check(
          'FK + jsonb + text[] fidelity',
          joined === 2 && hdr === 'b' && Array.isArray(scopes) && scopes.includes('write'),
          `joined=${joined} hdr=${hdr} scopes=${JSON.stringify(scopes)}`,
        );
      } finally {
        await probe.end();
      }

      // 6a) --include-artifacts produces a tar.gz envelope (verify on-disk
      //     shape) and restores cleanly — even with no S3 configured the
      //     artifacts/ entries are absent, DB restore still runs.
      //
      //     Full S3 round-trip (object upload/download fidelity) requires
      //     test-bucket infrastructure outside scope of this script; that
      //     coverage lands separately. This subtest catches format
      //     regressions and the "no-S3 fallback" path.
      const tgz = resolve(tmp, 'art.oodump.tar.gz');
      const art1 = await run(
        ['bun', exp, '--scope', 'all', '--include-artifacts', '-o', tgz],
        'oo_br_src',
      );
      const tarGzOk =
        art1.code === 0 &&
        (() => {
          const buf = readFileSync(tgz);
          // gzip magic: 1f 8b
          if (buf[0] !== 0x1f || buf[1] !== 0x8b) return false;
          // Decompress and check for "ustar" at offset 257 (tar header magic).
          const inner = gunzipSync(buf);
          return inner.slice(257, 262).toString('ascii') === 'ustar';
        })();
      check(
        '--include-artifacts produces a valid tar.gz envelope',
        tarGzOk,
        art1.stderr.trim().split('\n').pop(),
      );

      // Restore the tar.gz envelope on a fresh sibling. With no S3
      // configured the artifacts/ entries (if any) are skipped with a
      // warning; the DB rows still round-trip identically.
      await admin.unsafe(`DROP DATABASE IF EXISTS oo_br_tar WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE oo_br_tar`);
      const tarMig = await run(['bun', resolve(REPO, 'src/db/migrate.ts')], 'oo_br_tar');
      if (tarMig.code === 0) {
        const tarImp = await run(['bun', imp, '--from', tgz], 'oo_br_tar');
        const tarCounts = await counts('oo_br_tar');
        check(
          'tar.gz envelope restores (DB rows round-trip; artifacts skipped if no S3)',
          tarImp.code === 0 && eq(src, tarCounts),
          tarImp.code !== 0 ? tarImp.stderr.trim().split('\n').pop() : diff(src, tarCounts),
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS oo_br_tar WITH (FORCE)`);
      } else {
        check('migrate oo_br_tar (for tar.gz restore subtest)', false, tarMig.stderr.trim());
      }

      // 6) schema-head guard rejects BEFORE truncate (split DB unchanged).
      const raw = gunzipSync(readFileSync(allGz)).toString('utf8');
      const lines = raw.split('\n');
      const m0 = JSON.parse(lines[0]);
      m0.manifest.schemaHead = '9999_tampered.sql';
      lines[0] = JSON.stringify(m0);
      writeFileSync(badGz, gzipSync(Buffer.from(lines.join('\n'))));
      const before = await counts('oo_br_split');
      const guard = await run(['bun', imp, '--from', badGz, '--force'], 'oo_br_split');
      const after = await counts('oo_br_split');
      check(
        'schema-head guard refuses + leaves target untouched',
        guard.code !== 0 && /schema mismatch/i.test(guard.stderr) && eq(before, after),
        guard.stderr.trim().split('\n').pop(),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    if (admin) {
      for (const db of SIBS) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
      }
      await admin.end();
    }
  }

  if (failed) {
    console.error('\nbackup-restore-test: FAILED');
    process.exit(1);
  }
  console.log('\nbackup-restore-test: all checks passed');
}

function eq(a: Record<string, number>, b: Record<string, number>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function diff(a: Record<string, number>, b: Record<string, number>): string {
  return ALL_TABLES.filter((t) => a[t] !== b[t])
    .map((t) => `${t}:${a[t]}!=${b[t]}`)
    .join(' ');
}

main().catch((err) => {
  console.error('backup-restore-test crashed:', err);
  process.exit(1);
});
