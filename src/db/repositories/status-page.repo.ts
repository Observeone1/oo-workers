import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { statusPageMonitors, statusPages } from '../schema.ts';

export type StatusPageRow = typeof statusPages.$inferSelect;
export type MonitorType = 'url' | 'api' | 'tcp' | 'udp' | 'qa' | 'db' | 'tls';

export interface StatusPageMonitorBinding {
  monitorType: MonitorType;
  monitorId: number;
  sortOrder: number;
}

export const statusPageRepo = {
  create(data: { slug: string; title: string; description?: string | null }) {
    return db
      .insert(statusPages)
      .values({ slug: data.slug, title: data.title, description: data.description ?? null })
      .returning();
  },

  async findById(id: number): Promise<StatusPageRow | null> {
    const rows = await db.select().from(statusPages).where(eq(statusPages.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findBySlug(slug: string): Promise<StatusPageRow | null> {
    const rows = await db.select().from(statusPages).where(eq(statusPages.slug, slug)).limit(1);
    return rows[0] ?? null;
  },

  list() {
    return db
      .select({
        id: statusPages.id,
        slug: statusPages.slug,
        title: statusPages.title,
        description: statusPages.description,
        createdAt: statusPages.createdAt,
      })
      .from(statusPages)
      .orderBy(desc(statusPages.createdAt));
  },

  update(id: number, data: { title?: string; description?: string | null }) {
    return db.update(statusPages).set(data).where(eq(statusPages.id, id));
  },

  deleteById(id: number) {
    return db.delete(statusPages).where(eq(statusPages.id, id));
  },
};

export const statusPageMonitorRepo = {
  async forPage(statusPageId: number): Promise<StatusPageMonitorBinding[]> {
    const rows = await db
      .select({
        monitorType: statusPageMonitors.monitorType,
        monitorId: statusPageMonitors.monitorId,
        sortOrder: statusPageMonitors.sortOrder,
      })
      .from(statusPageMonitors)
      .where(eq(statusPageMonitors.statusPageId, statusPageId))
      .orderBy(asc(statusPageMonitors.sortOrder));
    return rows as StatusPageMonitorBinding[];
  },

  set(statusPageId: number, bindings: Array<{ monitorType: MonitorType; monitorId: number }>) {
    return db.transaction(async (tx) => {
      await tx.delete(statusPageMonitors).where(eq(statusPageMonitors.statusPageId, statusPageId));
      if (bindings.length === 0) return;
      await tx.insert(statusPageMonitors).values(
        bindings.map((b, idx) => ({
          statusPageId,
          monitorType: b.monitorType,
          monitorId: b.monitorId,
          sortOrder: idx,
        })),
      );
    });
  },

  clearForMonitor(monitorType: MonitorType, monitorId: number) {
    return db
      .delete(statusPageMonitors)
      .where(
        and(
          eq(statusPageMonitors.monitorType, monitorType),
          eq(statusPageMonitors.monitorId, monitorId),
        ),
      );
  },
};
