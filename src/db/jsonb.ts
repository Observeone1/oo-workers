import { sql } from 'drizzle-orm';

export const jsonbCast = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;
