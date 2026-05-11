import { SQL } from 'bun';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/oo_workers)',
  );
}

export const sql = new SQL(url);
