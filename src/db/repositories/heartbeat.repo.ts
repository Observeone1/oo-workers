import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { heartbeatMonitors } from '../schema.ts';

export type HeartbeatRow = typeof heartbeatMonitors.$inferSelect;

// 32 bytes → 43 base64url chars. Match scripts/create-api-key.ts so
// tokens look familiar in logs. URL-safe by construction.
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export const heartbeatRepo = {
  /** List with the same `type` discriminator the other monitor repos use,
   *  so the unified GET /api/monitors response stays homogeneous. */
  async list(): Promise<Array<HeartbeatRow & { type: 'heartbeat' }>> {
    const rows = await db.select().from(heartbeatMonitors).orderBy(desc(heartbeatMonitors.id));
    return rows.map((r) => ({ ...r, type: 'heartbeat' as const }));
  },

  findById(id: number) {
    return db.select().from(heartbeatMonitors).where(eq(heartbeatMonitors.id, id)).limit(1);
  },

  findByToken(token: string) {
    return db.select().from(heartbeatMonitors).where(eq(heartbeatMonitors.token, token)).limit(1);
  },

  create(data: {
    name: string;
    description?: string | null;
    periodSeconds: number;
    graceSeconds?: number;
    enabled?: boolean;
  }) {
    return db
      .insert(heartbeatMonitors)
      .values({
        name: data.name,
        description: data.description ?? null,
        token: generateToken(),
        periodSeconds: data.periodSeconds,
        graceSeconds: data.graceSeconds ?? 60,
        enabled: data.enabled ?? true,
      })
      .returning();
  },

  update(
    id: number,
    data: Partial<{
      name: string;
      description: string | null;
      periodSeconds: number;
      graceSeconds: number;
      enabled: boolean;
    }>,
  ) {
    return db
      .update(heartbeatMonitors)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(heartbeatMonitors.id, id))
      .returning();
  },

  delete(id: number) {
    return db.delete(heartbeatMonitors).where(eq(heartbeatMonitors.id, id)).returning();
  },

  /** Public-path ingest. Bumps last_ping_at, transitions
   *  PENDING/OVERDUE → UP, and returns { row, wasOverdue } so the
   *  caller can fire a recovery alert when a ping resurrects an
   *  OVERDUE heartbeat. Returns null on unknown token. The 1-query
   *  race window (status read on a stale row) is acceptable —
   *  worst case is a missed recovery alert, no data loss. */
  async recordPing(token: string): Promise<{ row: HeartbeatRow; wasOverdue: boolean } | null> {
    const [prior] = await db
      .select({ status: heartbeatMonitors.status })
      .from(heartbeatMonitors)
      .where(eq(heartbeatMonitors.token, token))
      .limit(1);
    if (!prior) return null;
    const rows = await db
      .update(heartbeatMonitors)
      .set({
        lastPingAt: new Date(),
        status: 'UP',
        updatedAt: new Date(),
      })
      .where(eq(heartbeatMonitors.token, token))
      .returning();
    if (rows.length === 0) return null;
    return { row: rows[0], wasOverdue: prior.status === 'OVERDUE' };
  },

  /** Scheduler tick query: enabled UP heartbeats whose deadline has
   *  passed. PENDING heartbeats are excluded — a heartbeat that's
   *  never been pinged is grace-tolerant until its first ping. */
  findOverdue() {
    // (now - last_ping_at) > (period + grace) seconds.
    return db
      .select()
      .from(heartbeatMonitors)
      .where(
        and(
          eq(heartbeatMonitors.enabled, true),
          eq(heartbeatMonitors.status, 'UP'),
          sql`extract(epoch from (now() - ${heartbeatMonitors.lastPingAt})) > (${heartbeatMonitors.periodSeconds} + ${heartbeatMonitors.graceSeconds})`,
        ),
      );
  },

  /** Idempotent UP → OVERDUE transition. Returns updated row or null
   *  (already OVERDUE, or status changed under us — both are fine,
   *  caller treats null as "no alert needed"). */
  async markOverdue(id: number): Promise<HeartbeatRow | null> {
    const rows = await db
      .update(heartbeatMonitors)
      .set({ status: 'OVERDUE', updatedAt: new Date() })
      .where(and(eq(heartbeatMonitors.id, id), eq(heartbeatMonitors.status, 'UP')))
      .returning();
    return rows[0] ?? null;
  },
};
