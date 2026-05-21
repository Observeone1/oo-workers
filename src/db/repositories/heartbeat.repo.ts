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
    // Optional pre-existing token. Used by the SaaS-import path to reuse
    // the upstream ping_key so services pointed at the old /heartbeat/:token
    // URL keep working after migration. Default behavior (no token passed)
    // generates a fresh one, same as before.
    token?: string;
  }) {
    return db
      .insert(heartbeatMonitors)
      .values({
        name: data.name,
        description: data.description ?? null,
        token: data.token ?? generateToken(),
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
   *  PENDING/OVERDUE → UP, and returns `{ row, wasOverdue }` so the
   *  caller can fire a recovery alert when a ping resurrects an
   *  OVERDUE heartbeat.
   *
   *  Returns null on unknown token OR disabled row (caller treats
   *  both as 404 — disabled rows shouldn't leak existence).
   *
   *  Debounces rapid-fire pings: if the last ping arrived <1s ago,
   *  skips the UPDATE and returns the existing row with
   *  wasOverdue=false. Prevents a leaked token from flooding the
   *  DB with SELECT+UPDATE pairs. The 1s window is far below any
   *  legitimate cadence (real heartbeats fire every 30s+).
   *
   *  Race: the peek-then-update pattern is the same as before.
   *  Worst case (scheduler ticks the row OVERDUE between our peek
   *  and update) is a missed recovery alert — acceptable, no data
   *  loss. */
  async recordPing(token: string): Promise<{ row: HeartbeatRow; wasOverdue: boolean } | null> {
    const [prior] = await db
      .select()
      .from(heartbeatMonitors)
      .where(and(eq(heartbeatMonitors.token, token), eq(heartbeatMonitors.enabled, true)))
      .limit(1);
    if (!prior) return null;

    // Debounce: <1s since last ping → no-op, return existing row.
    if (prior.lastPingAt && Date.now() - prior.lastPingAt.getTime() < 1000) {
      return { row: prior, wasOverdue: false };
    }

    const rows = await db
      .update(heartbeatMonitors)
      .set({ lastPingAt: new Date(), status: 'UP', updatedAt: new Date() })
      .where(and(eq(heartbeatMonitors.token, token), eq(heartbeatMonitors.enabled, true)))
      .returning();
    if (rows.length === 0) return null;
    return { row: rows[0], wasOverdue: prior.status === 'OVERDUE' };
  },

  /** Read-only lookup used by GET /heartbeat/:token. Same
   *  unknown-or-disabled-equals-null posture as recordPing — GETs
   *  on a disabled or non-existent heartbeat return 404 the same
   *  way, so a curious requester can't distinguish them. */
  async findByPublicToken(token: string): Promise<HeartbeatRow | null> {
    const [row] = await db
      .select()
      .from(heartbeatMonitors)
      .where(and(eq(heartbeatMonitors.token, token), eq(heartbeatMonitors.enabled, true)))
      .limit(1);
    return row ?? null;
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
