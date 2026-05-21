import { and, asc, desc, eq, gte, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { DEFAULTS } from '../../constants.ts';
import { incidents, incidentUpdates } from '../schema.ts';

export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentUpdateRow = typeof incidentUpdates.$inferSelect;

export type Severity = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export const SEVERITIES: readonly Severity[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
];

export interface IncidentWithUpdates extends IncidentRow {
  updates: IncidentUpdateRow[];
}

export const incidentRepo = {
  /** Create an incident + its first update in one transaction. */
  async create(data: {
    statusPageId: number;
    title: string;
    severity: Severity;
    body: string;
  }): Promise<IncidentRow> {
    return db.transaction(async (tx) => {
      const [inc] = await tx
        .insert(incidents)
        .values({
          statusPageId: data.statusPageId,
          title: data.title,
          severity: data.severity,
          resolvedAt: data.severity === 'resolved' ? new Date() : null,
        })
        .returning();
      await tx.insert(incidentUpdates).values({
        incidentId: inc.id,
        severity: data.severity,
        body: data.body,
      });
      return inc;
    });
  },

  /** Append an update; severity is denormalised onto the incident, and
   *  resolved_at is set on resolve / cleared if it is re-opened. */
  async addUpdate(
    incidentId: number,
    data: { severity: Severity; body: string },
  ): Promise<IncidentUpdateRow | null> {
    return db.transaction(async (tx) => {
      const [inc] = await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .limit(1);
      if (!inc) return null;
      const [upd] = await tx
        .insert(incidentUpdates)
        .values({ incidentId, severity: data.severity, body: data.body })
        .returning();
      await tx
        .update(incidents)
        .set({
          severity: data.severity,
          resolvedAt: data.severity === 'resolved' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(incidents.id, incidentId));
      return upd;
    });
  },

  updateTitle(id: number, title: string) {
    return db.update(incidents).set({ title, updatedAt: new Date() }).where(eq(incidents.id, id));
  },

  deleteById(id: number) {
    return db.delete(incidents).where(eq(incidents.id, id));
  },

  async findById(id: number): Promise<IncidentWithUpdates | null> {
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
    if (!inc) return null;
    const updates = await db
      .select()
      .from(incidentUpdates)
      .where(eq(incidentUpdates.incidentId, id))
      .orderBy(asc(incidentUpdates.createdAt));
    return { ...inc, updates };
  },

  /** Admin list for one page (newest activity first), optionally only
   *  active or only resolved. Capped at LIST_DEFAULT_LIMIT to bound
   *  memory on long-lived pages with thousands of incidents. */
  listForPage(statusPageId: number, filter: 'all' | 'active' | 'resolved' = 'all') {
    const cond =
      filter === 'active'
        ? and(eq(incidents.statusPageId, statusPageId), isNull(incidents.resolvedAt))
        : filter === 'resolved'
          ? and(eq(incidents.statusPageId, statusPageId), isNotNull(incidents.resolvedAt))
          : eq(incidents.statusPageId, statusPageId);
    return db
      .select()
      .from(incidents)
      .where(cond)
      .orderBy(desc(incidents.updatedAt))
      .limit(DEFAULTS.LIST_DEFAULT_LIMIT);
  },

  /**
   * Public render set for a page: every still-active incident, plus
   * incidents resolved within the last 24h. Active sorted by latest
   * activity (updated_at desc — a freshly-updated incident outranks an
   * older idle one); recently-resolved by resolved_at desc.
   */
  async forPublic(statusPageId: number): Promise<IncidentWithUpdates[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.statusPageId, statusPageId),
          or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, cutoff)),
        ),
      );
    if (rows.length === 0) return [];
    rows.sort((a, b) => {
      const aActive = a.resolvedAt == null;
      const bActive = b.resolvedAt == null;
      if (aActive !== bActive) return aActive ? -1 : 1; // active first
      if (aActive) return b.updatedAt.getTime() - a.updatedAt.getTime();
      return (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0);
    });
    const ids = rows.map((r) => r.id);
    const allUpdates = await db
      .select()
      .from(incidentUpdates)
      .where(
        ids.length === 1
          ? eq(incidentUpdates.incidentId, ids[0])
          : or(...ids.map((id) => eq(incidentUpdates.incidentId, id))),
      )
      .orderBy(asc(incidentUpdates.createdAt));
    return rows.map((r) => ({
      ...r,
      updates: allUpdates.filter((u) => u.incidentId === r.id),
    }));
  },
};
