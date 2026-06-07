/**
 * End-to-end backup/restore round-trip.
 * Ported from scripts/backup-restore-test.ts.
 *
 * Creates sibling DBs in the testcontainers Postgres instance,
 * runs export.ts / import.ts CLIs as sub-processes, and verifies
 * data-fidelity invariants. Skips gracefully if CREATE DATABASE fails.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomBytes, createHash } from 'node:crypto';
import { isStorageConfigured, putObject, getObjectResponse, deleteObject } from '../../src/services/object-storage.ts';

const REPO = resolve(import.meta.dir, '../..');
const EXPORT_SCRIPT = resolve(REPO, 'scripts/export.ts');
const IMPORT_SCRIPT = resolve(REPO, 'scripts/import.ts');
const MIGRATE_SCRIPT = resolve(REPO, 'src/db/migrate.ts');

// heartbeat_monitors was missing from backup-shared.ts TABLES, so heartbeats
// silently disappeared on restore. Now that it's in TABLES it must also be
// in the count comparison below.
const CONFIG_TABLES = ['api_keys','users','regions','url_monitors','api_checks','tcp_monitors','udp_monitors','db_monitors','tls_monitors','qa_projects','heartbeat_monitors','url_monitor_assertions','api_assertions','qa_generated_tests','alert_channels','monitor_alert_channels','monitor_regions','status_pages','status_page_monitors','incidents','incident_updates'];
const EXEC_TABLES = ['url_monitor_executions','api_executions','tcp_executions','udp_executions','db_executions','tls_executions','qa_test_executions'];
const ALL_TABLES = [...CONFIG_TABLES, ...EXEC_TABLES];
const SIBS = ['oo_br_src','oo_br_all','oo_br_win','oo_br_split'];

// Probe whether CREATE DATABASE is available at collection time so describe.skipIf
// can gate the whole suite. Uses a short-lived connection to the admin DB.
const BASE_URL = process.env.DATABASE_URL!;
const _probeUrl = new URL(BASE_URL);
_probeUrl.pathname = '/postgres';
const _probe = postgres(_probeUrl.toString(), { max: 1, onnotice: () => {} });
let CAN_CREATE_DB = false;
try {
  await _probe.unsafe('DROP DATABASE IF EXISTS oo_br_probe');
  await _probe.unsafe('CREATE DATABASE oo_br_probe');
  await _probe.unsafe('DROP DATABASE oo_br_probe');
  CAN_CREATE_DB = true;
} catch {}
await _probe.end();

let admin: ReturnType<typeof postgres> | null = null;
let tmp = '';

function dbUrl(name: string): string {
  const u = new URL(BASE_URL);
  u.pathname = '/' + name;
  return u.toString();
}

async function run(cmd: string[], dbName: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: dbUrl(dbName) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode ?? 0, stderr };
}

// Seed one row of every config table plus, for each execution table, a recent
// and a >120d-old row. Heartbeat monitors are NOT excluded — that's the bug
// this spec previously missed: heartbeat_monitors wasn't even in the TABLES
// array, so the seed got dropped on restore.
const OLD_DAYS = 200;
const RECENT_DAYS = 1;
async function seed(dbName: string): Promise<void> {
  const sql = postgres(dbUrl(dbName), { max: 1, onnotice: () => {} });
  const OLD = new Date(Date.now() - OLD_DAYS * 86_400_000);
  const NEW = new Date(Date.now() - RECENT_DAYS * 86_400_000);
  try {
    const [{ id: keyId }] = await sql<[{ id: number }]>`
      INSERT INTO api_keys (name, key_prefix, key_hash, scopes)
      VALUES ('br', 'oo_brbrbr', 'h', ARRAY['write','read']) RETURNING id`;
    await sql`INSERT INTO users (email, password_hash, name) VALUES ('br@x.io', 'p', 'BR')`;
    const [{ id: regionId }] = await sql<[{ id: number }]>`
      INSERT INTO regions (slug, label, api_key_id) VALUES ('br-eu', 'EU', ${keyId}) RETURNING id`;
    const [{ id: umId }] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url) VALUES ('br-url', 'https://x.io') RETURNING id`;
    await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${umId}, 'eq', 200)`;
    const [{ id: acId }] = await sql<[{ id: number }]>`
      INSERT INTO api_checks (name, url, headers) VALUES ('br-api', 'https://x.io/api', '{"x-a":"b"}'::jsonb) RETURNING id`;
    await sql`INSERT INTO api_assertions (api_check_id, type, operator, value) VALUES (${acId}, 'status_code', 'eq', '200')`;
    const [{ id: tcpId }] = await sql<[{ id: number }]>`
      INSERT INTO tcp_monitors (name, host, port) VALUES ('br-tcp', 'x.io', 22) RETURNING id`;
    const [{ id: udpId }] = await sql<[{ id: number }]>`
      INSERT INTO udp_monitors (name, host, port) VALUES ('br-udp', 'x.io', 53) RETURNING id`;
    const [{ id: dbId }] = await sql<[{ id: number }]>`
      INSERT INTO db_monitors (name, protocol, host, port, tls) VALUES ('br-db', 'redis', 'x.io', 6379, true) RETURNING id`;
    const [{ id: tlsId }] = await sql<[{ id: number }]>`
      INSERT INTO tls_monitors (name, host, port, warn_days) VALUES ('br-tls', 'x.io', 443, 30) RETURNING id`;
    const [{ id: qaId }] = await sql<[{ id: number }]>`
      INSERT INTO qa_projects (name, target_url, config, credentials)
      VALUES ('br-qa', 'https://x.io', '{"headed":false}'::jsonb, '{"u":"a"}'::jsonb) RETURNING id`;
    const [{ id: qaTestId }] = await sql<[{ id: number }]>`
      INSERT INTO qa_generated_tests (project_id, test_name, test_type, script)
      VALUES (${qaId}, 't1', 'browser', 'test(''t'', async () => {});') RETURNING id`;
    await sql`INSERT INTO heartbeat_monitors (name, token, period_seconds, grace_seconds) VALUES ('br-hb', 'br-token-123', 300, 60)`;
    const [{ id: chId }] = await sql<[{ id: number }]>`
      INSERT INTO alert_channels (name, type, config) VALUES ('br-ch', 'webhook', '{"url":"https://hook"}'::jsonb) RETURNING id`;
    await sql`INSERT INTO monitor_alert_channels (monitor_type, monitor_id, channel_id) VALUES ('url', ${umId}, ${chId})`;
    await sql`INSERT INTO monitor_regions (monitor_type, monitor_id, region_id) VALUES ('url', ${umId}, ${regionId})`;
    const [{ id: spId }] = await sql<[{ id: number }]>`
      INSERT INTO status_pages (slug, title) VALUES ('br-sp', 'BR') RETURNING id`;
    await sql`INSERT INTO status_page_monitors (status_page_id, monitor_type, monitor_id) VALUES (${spId}, 'url', ${umId})`;
    const [{ id: incId }] = await sql<[{ id: number }]>`
      INSERT INTO incidents (status_page_id, title, severity) VALUES (${spId}, 'br-incident', 'investigating') RETURNING id`;
    await sql`INSERT INTO incident_updates (incident_id, severity, body) VALUES (${incId}, 'investigating', 'seed **body**')`;

    // One recent + one >120d-old execution per exec table.
    for (const ts of [NEW, OLD]) {
      await sql`INSERT INTO url_monitor_executions (url_monitor_id, region_id, status, start_time) VALUES (${umId}, ${regionId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO api_executions (api_check_id, status, start_time) VALUES (${acId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO tcp_executions (tcp_monitor_id, status, start_time) VALUES (${tcpId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO udp_executions (udp_monitor_id, status, start_time) VALUES (${udpId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO db_executions (db_monitor_id, status, start_time) VALUES (${dbId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO tls_executions (tls_monitor_id, status, start_time) VALUES (${tlsId}, 'SUCCESS', ${ts})`;
      await sql`INSERT INTO qa_test_executions (test_id, project_id, status, started_at) VALUES (${qaTestId}, ${qaId}, 'SUCCESS', ${ts})`;
    }
  } finally {
    await sql.end();
  }
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

function eq(a: Record<string, number>, b: Record<string, number>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function diff(a: Record<string, number>, b: Record<string, number>): string {
  return ALL_TABLES.filter((t) => a[t] !== b[t]).map((t) => `${t}:${a[t]}!=${b[t]}`).join(' ');
}

beforeAll(async () => {
  const u = new URL(BASE_URL);
  u.pathname = '/postgres';
  admin = postgres(u.toString(), { max: 1, onnotice: () => {} });

  for (const db of SIBS) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${db}`);
  }

  tmp = mkdtempSync(resolve(tmpdir(), 'oo-br-it-'));
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const db of SIBS) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS oo_br_tar WITH (FORCE)`).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS oo_br_art WITH (FORCE)`).catch(() => {});
  }
  if (admin) await admin.end();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!CAN_CREATE_DB)('backup-restore round-trip', () => {
  test('migrate 4 sibling DBs', async () => {

    for (const db of SIBS) {
      const m = await run(['bun', MIGRATE_SCRIPT], db);
      expect(m.code).toBe(0);
    }
  }, 60_000);

  test('seed oo_br_src (one row per config table + recent/old exec rows + 1 heartbeat)', async () => {

    await seed('oo_br_src');
    const c = await counts('oo_br_src');
    expect(c.heartbeat_monitors).toBe(1);
    expect(c.url_monitor_executions).toBe(2);
  }, 30_000);

  test('export all / window / split from src', async () => {

    const allGz = resolve(tmp, 'all.oodump.gz');
    const winGz = resolve(tmp, 'win.oodump.gz');
    const splitDir = resolve(tmp, 'split');
    const [e1, e2, e3] = await Promise.all([
      run(['bun', EXPORT_SCRIPT, '--scope', 'all', '-o', allGz], 'oo_br_src'),
      run(['bun', EXPORT_SCRIPT, '-o', winGz], 'oo_br_src'),
      run(['bun', EXPORT_SCRIPT, '--scope', 'all', '--split', splitDir], 'oo_br_src'),
    ]);
    expect(e1.code).toBe(0);
    expect(e2.code).toBe(0);
    expect(e3.code).toBe(0);
  }, 60_000);

  test('round-trip scope=all: counts identical', async () => {

    const allGz = resolve(tmp, 'all.oodump.gz');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', allGz], 'oo_br_all');
    expect(r.code).toBe(0);
    const src = await counts('oo_br_src');
    const all = await counts('oo_br_all');
    expect(eq(src, all)).toBe(true);
  }, 30_000);

  test('window scope: each exec table drops exactly its >120d row', async () => {

    const winGz = resolve(tmp, 'win.oodump.gz');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', winGz], 'oo_br_win');
    expect(r.code).toBe(0);
    const src = await counts('oo_br_src');
    const win = await counts('oo_br_win');
    for (const t of CONFIG_TABLES) expect(win[t]).toBe(src[t]);
    for (const t of EXEC_TABLES) expect(win[t]).toBe(src[t] - 1);
  }, 30_000);

  test('single-file == split (counts identical)', async () => {

    const splitDir = resolve(tmp, 'split');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', splitDir], 'oo_br_split');
    expect(r.code).toBe(0);
    const all = await counts('oo_br_all');
    const split = await counts('oo_br_split');
    expect(eq(all, split)).toBe(true);
  }, 30_000);

  test('restore refuses non-empty target without --force', async () => {

    const allGz = resolve(tmp, 'all.oodump.gz');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', allGz], 'oo_br_all');
    expect(r.code).not.toBe(0);
    expect(/not empty/i.test(r.stderr)).toBe(true);
  }, 30_000);

  test('--force wipes + restores (counts back to src)', async () => {

    const allGz = resolve(tmp, 'all.oodump.gz');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', allGz, '--force'], 'oo_br_all');
    expect(r.code).toBe(0);
    const src = await counts('oo_br_src');
    const all = await counts('oo_br_all');
    expect(eq(src, all)).toBe(true);
  }, 30_000);

  test('FK + jsonb + text[] fidelity', async () => {

    const probe = postgres(dbUrl('oo_br_all'), { max: 1, onnotice: () => {} });
    try {
      const [{ mx }] = await probe`SELECT COALESCE(MAX(id),0)::int AS mx FROM url_monitors`;
      const [ins] = await probe`INSERT INTO url_monitors (name, url) VALUES ('post', 'https://p.io') RETURNING id`;
      expect(ins.id).toBe(mx + 1);
      const [{ joined }] = await probe`SELECT count(*)::int AS joined FROM url_monitor_executions e JOIN url_monitors m ON m.id = e.url_monitor_id`;
      const [{ hdr }] = await probe`SELECT headers->>'x-a' AS hdr FROM api_checks LIMIT 1`;
      const [{ scopes }] = await probe`SELECT scopes FROM api_keys LIMIT 1`;
      expect(joined).toBe(2);
      expect(hdr).toBe('b');
      expect(Array.isArray(scopes) && scopes.includes('write')).toBe(true);
    } finally {
      await probe.end();
    }
  }, 30_000);

  test('--include-artifacts produces a valid tar.gz envelope', async () => {

    const tgz = resolve(tmp, 'art.oodump.tar.gz');
    const r = await run(['bun', EXPORT_SCRIPT, '--scope', 'all', '--include-artifacts', '-o', tgz], 'oo_br_src');
    expect(r.code).toBe(0);
    const buf = readFileSync(tgz);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
    const inner = gunzipSync(buf);
    expect(inner.slice(257, 262).toString('ascii')).toBe('ustar');
  }, 30_000);

  test('tar.gz envelope restores (DB rows round-trip)', async () => {

    const tgz = resolve(tmp, 'art.oodump.tar.gz');
    await admin!.unsafe('DROP DATABASE IF EXISTS oo_br_tar WITH (FORCE)');
    await admin!.unsafe('CREATE DATABASE oo_br_tar');
    await run(['bun', MIGRATE_SCRIPT], 'oo_br_tar');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', tgz], 'oo_br_tar');
    expect(r.code).toBe(0);
    const src = await counts('oo_br_src');
    const tar = await counts('oo_br_tar');
    expect(eq(src, tar)).toBe(true);
  }, 60_000);

  test.skipIf(!isStorageConfigured())('real-S3 round-trip: seed → export → wipe → restore → SHA-256 byte equality', async () => {

    const prefix = `e2e-backup-${randomBytes(4).toString('hex')}/`;
    const objs = [
      { key: `${prefix}script.spec.ts`, body: Buffer.from("test('hi',()=>{});\n", 'utf8') },
      { key: `${prefix}trace.zip`,       body: randomBytes(2048) },
      { key: `${prefix}screenshot.png`,  body: randomBytes(1024) },
    ];
    const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const seeded = objs.map((o) => ({ ...o, sha: sha256(o.body) }));

    try {
      for (const o of seeded) await putObject(o.key, o.body, 'application/octet-stream');

      const rtTgz = resolve(tmp, 'art-rt.oodump.tar.gz');
      const rtExp = await run(['bun', EXPORT_SCRIPT, '--scope', 'all', '--include-artifacts', '-o', rtTgz], 'oo_br_src');
      expect(rtExp.code, `export failed: ${rtExp.stderr.trim().split('\n').pop()}`).toBe(0);

      for (const o of seeded) await deleteObject(o.key).catch(() => {});

      await admin!.unsafe('DROP DATABASE IF EXISTS oo_br_art WITH (FORCE)');
      await admin!.unsafe('CREATE DATABASE oo_br_art');
      const artMig = await run(['bun', MIGRATE_SCRIPT], 'oo_br_art');
      expect(artMig.code, `migrate oo_br_art failed: ${artMig.stderr.trim()}`).toBe(0);

      const rtImp = await run(['bun', IMPORT_SCRIPT, '--from', rtTgz], 'oo_br_art');
      expect(rtImp.code, `restore failed: ${rtImp.stderr.trim().split('\n').pop()}`).toBe(0);

      for (const o of seeded) {
        const res = await getObjectResponse(o.key);
        const buf = Buffer.from(await res.arrayBuffer());
        const got = sha256(buf);
        expect(got, `SHA-256 mismatch for ${o.key}`).toBe(o.sha);
      }
    } finally {
      for (const o of seeded) await deleteObject(o.key).catch(() => {});
      await admin!.unsafe('DROP DATABASE IF EXISTS oo_br_art WITH (FORCE)').catch(() => {});
    }
  }, 60_000);

  test('schema-head guard refuses + leaves target untouched', async () => {

    const allGz = resolve(tmp, 'all.oodump.gz');
    const badGz = resolve(tmp, 'bad.oodump.gz');
    const raw = gunzipSync(readFileSync(allGz)).toString('utf8');
    const lines = raw.split('\n');
    const m0 = JSON.parse(lines[0]);
    m0.manifest.schemaHead = '9999_tampered.sql';
    lines[0] = JSON.stringify(m0);
    writeFileSync(badGz, gzipSync(Buffer.from(lines.join('\n'))));
    const before = await counts('oo_br_split');
    const r = await run(['bun', IMPORT_SCRIPT, '--from', badGz, '--force'], 'oo_br_split');
    const after = await counts('oo_br_split');
    expect(r.code).not.toBe(0);
    expect(/schema mismatch/i.test(r.stderr)).toBe(true);
    expect(eq(before, after)).toBe(true);
  }, 30_000);
});
