import { eq } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { users } from '../schema.ts';

export type UserRow = typeof users.$inferSelect;

export const userRepo = {
  create(data: { email: string; passwordHash: string; name?: string; role?: string }) {
    return db
      .insert(users)
      .values({
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name ?? '',
        role: data.role ?? 'admin',
      })
      .returning();
  },

  findByEmail(email: string): Promise<UserRow | null> {
    return db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0] ?? null);
  },

  findById(id: number): Promise<UserRow | null> {
    return db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0] ?? null);
  },

  count(): Promise<number> {
    return db.$count(users).then((r) => r as number);
  },
};
