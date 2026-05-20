import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { monitorRegions, regions } from '../schema.ts';

export type RegionRow = typeof regions.$inferSelect;
export type MonitorType = 'url' | 'api' | 'tcp' | 'udp' | 'qa' | 'db' | 'tls';

export const regionRepo = {
  create(data: { slug: string; label: string; apiKeyId: number }) {
    return db
      .insert(regions)
      .values({ slug: data.slug, label: data.label, apiKeyId: data.apiKeyId })
      .returning();
  },

  async findBySlug(slug: string): Promise<RegionRow | null> {
    const rows = await db.select().from(regions).where(eq(regions.slug, slug)).limit(1);
    return rows[0] ?? null;
  },

  async findById(id: number): Promise<RegionRow | null> {
    const rows = await db.select().from(regions).where(eq(regions.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findByApiKeyId(apiKeyId: number): Promise<RegionRow | null> {
    const rows = await db.select().from(regions).where(eq(regions.apiKeyId, apiKeyId)).limit(1);
    return rows[0] ?? null;
  },

  /** Fire-and-forget — keeps regions.last_seen_at fresh from long-poll
   *  traffic. If the agent sent X-Agent-Version, cache it alongside so
   *  the master can flag version skew on /api/regions GET. */
  touchLastSeen(id: number, agentVersion?: string | null) {
    const set: Record<string, unknown> = { lastSeenAt: sql`NOW()` };
    if (typeof agentVersion === 'string' && agentVersion.length > 0) {
      // Trim to schema length (32) defensively in case an agent sends
      // a longer version string somehow.
      set.agentVersion = agentVersion.slice(0, 32);
    }
    return db.update(regions).set(set).where(eq(regions.id, id));
  },

  list() {
    return db
      .select({
        id: regions.id,
        slug: regions.slug,
        label: regions.label,
        apiKeyId: regions.apiKeyId,
        lastSeenAt: regions.lastSeenAt,
        agentVersion: regions.agentVersion,
        createdAt: regions.createdAt,
      })
      .from(regions)
      .orderBy(desc(regions.createdAt));
  },

  deleteById(id: number) {
    return db.delete(regions).where(eq(regions.id, id));
  },
};

export const monitorRegionRepo = {
  /** Returns region rows attached to the given monitor. Empty array = run on master. */
  forMonitor(monitorType: MonitorType, monitorId: number) {
    return db
      .select({
        id: regions.id,
        slug: regions.slug,
        label: regions.label,
      })
      .from(monitorRegions)
      .innerJoin(regions, eq(regions.id, monitorRegions.regionId))
      .where(
        and(eq(monitorRegions.monitorType, monitorType), eq(monitorRegions.monitorId, monitorId)),
      );
  },

  set(monitorType: MonitorType, monitorId: number, regionIds: number[]) {
    return db.transaction(async (tx) => {
      await tx
        .delete(monitorRegions)
        .where(
          and(eq(monitorRegions.monitorType, monitorType), eq(monitorRegions.monitorId, monitorId)),
        );
      if (regionIds.length === 0) return;
      await tx
        .insert(monitorRegions)
        .values(regionIds.map((regionId) => ({ monitorType, monitorId, regionId })));
    });
  },

  clearForMonitor(monitorType: MonitorType, monitorId: number) {
    return db
      .delete(monitorRegions)
      .where(
        and(eq(monitorRegions.monitorType, monitorType), eq(monitorRegions.monitorId, monitorId)),
      );
  },
};
