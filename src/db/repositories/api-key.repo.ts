import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { apiKeys } from '../schema.ts';

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export const apiKeyRepo = {
  create(data: { name: string; keyPrefix: string; keyHash: string; scopes?: string[] }) {
    return db
      .insert(apiKeys)
      .values({
        name: data.name,
        keyPrefix: data.keyPrefix,
        keyHash: data.keyHash,
        scopes: data.scopes ?? ['write'],
      })
      .returning();
  },

  /**
   * Look up the live (non-revoked) row matching this prefix. Returns null
   * if no active key exists for that prefix. The caller still has to
   * verify the bcrypt/argon2 hash against the rest of the cleartext key.
   */
  async findActiveByPrefix(keyPrefix: string): Promise<ApiKeyRow | null> {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyPrefix, keyPrefix), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Fire-and-forget — don't await in the request path. */
  touchLastUsed(id: number) {
    return db
      .update(apiKeys)
      .set({ lastUsedAt: sql`NOW()` })
      .where(eq(apiKeys.id, id));
  },

  revoke(id: number) {
    return db
      .update(apiKeys)
      .set({ revokedAt: sql`NOW()` })
      .where(eq(apiKeys.id, id));
  },

  list() {
    return db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt));
  },
};
