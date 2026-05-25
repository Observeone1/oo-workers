import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../migrations');

type Sql = ReturnType<typeof postgres>;

async function ensureMigrationsTable(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function appliedMigrations(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations`;
  return new Set(rows.map((r) => r.name));
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function applyMigration(sql: Sql, filename: string) {
  const path = join(MIGRATIONS_DIR, filename);
  const contents = await readFile(path, 'utf8');
  console.log(`→ applying ${filename}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(contents);
    await tx`INSERT INTO schema_migrations (name) VALUES (${filename})`;
  });
  console.log(`✓ ${filename}`);
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl);
  try {
    await ensureMigrationsTable(sql);
    const already = await appliedMigrations(sql);
    const files = await listMigrationFiles();
    const pending = files.filter((f) => !already.has(f));

    if (pending.length === 0) {
      console.log('schema up to date');
    } else {
      console.log(`applying ${pending.length} migration(s)...`);
      for (const f of pending) await applyMigration(sql, f);
      console.log('done');
    }
  } finally {
    await sql.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await runMigrations(url);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}
