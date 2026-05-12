import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../db/schema.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/oo_workers)');
}

// postgres-js (not bun:sql): the bun-sql Drizzle adapter has an unresolved
// JSONB parameter-encoding bug (drizzle-team/drizzle-orm#4385, #5287) that
// double-encodes arrays/objects on write. postgres-js had the same bug
// historically but was fixed in #1785.
export const sql = postgres(url);
export const db = drizzle(sql, { schema });
