import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { sessions } from '../schema.ts';

export type SessionRow = typeof sessions.$inferSelect;

export const sessionRepo = {
  create(data: { userId: number; tokenHash: string; expiresAt: Date }) {
    return db
      .insert(sessions)
      .values({
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      })
      .returning();
  },

  findByToken(tokenHash: string): Promise<SessionRow | null> {
    return db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`NOW()`)))
      .then((rows) => rows[0] ?? null);
  },

  deleteByToken(tokenHash: string) {
    return db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  },

  deleteExpired() {
    return db.delete(sessions).where(sql`${sessions.expiresAt} <= NOW()`);
  },
};
