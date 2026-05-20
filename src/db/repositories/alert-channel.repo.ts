import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { alertChannels, monitorAlertChannels } from '../schema.ts';

export type AlertChannelRow = typeof alertChannels.$inferSelect;
export type ChannelType = 'webhook' | 'discord' | 'slack' | 'email';
export type MonitorType = 'url' | 'api' | 'tcp' | 'udp' | 'qa' | 'db' | 'tls' | 'heartbeat';

export interface AlertChannelLite {
  id: number;
  name: string;
  type: ChannelType;
}

export const alertChannelRepo = {
  create(data: { name: string; type: ChannelType; config: Record<string, unknown> }) {
    return db
      .insert(alertChannels)
      .values({ name: data.name, type: data.type, config: data.config })
      .returning();
  },

  async findById(id: number): Promise<AlertChannelRow | null> {
    const rows = await db.select().from(alertChannels).where(eq(alertChannels.id, id)).limit(1);
    return rows[0] ?? null;
  },

  list() {
    return db
      .select({
        id: alertChannels.id,
        name: alertChannels.name,
        type: alertChannels.type,
        enabled: alertChannels.enabled,
        createdAt: alertChannels.createdAt,
      })
      .from(alertChannels)
      .orderBy(desc(alertChannels.createdAt));
  },

  deleteById(id: number) {
    return db.delete(alertChannels).where(eq(alertChannels.id, id));
  },
};

export const monitorAlertChannelRepo = {
  /** Channels bound to the monitor — empty array means no alert routing. */
  forMonitor(monitorType: MonitorType, monitorId: number): Promise<AlertChannelRow[]> {
    return db
      .select({
        id: alertChannels.id,
        name: alertChannels.name,
        type: alertChannels.type,
        config: alertChannels.config,
        enabled: alertChannels.enabled,
        createdAt: alertChannels.createdAt,
        updatedAt: alertChannels.updatedAt,
      })
      .from(monitorAlertChannels)
      .innerJoin(alertChannels, eq(alertChannels.id, monitorAlertChannels.channelId))
      .where(
        and(
          eq(monitorAlertChannels.monitorType, monitorType),
          eq(monitorAlertChannels.monitorId, monitorId),
        ),
      );
  },

  /** Lite form for the dialog picker — omits the secret URL. */
  liteForMonitor(monitorType: MonitorType, monitorId: number): Promise<AlertChannelLite[]> {
    return db
      .select({
        id: alertChannels.id,
        name: alertChannels.name,
        type: alertChannels.type,
      })
      .from(monitorAlertChannels)
      .innerJoin(alertChannels, eq(alertChannels.id, monitorAlertChannels.channelId))
      .where(
        and(
          eq(monitorAlertChannels.monitorType, monitorType),
          eq(monitorAlertChannels.monitorId, monitorId),
        ),
      ) as unknown as Promise<AlertChannelLite[]>;
  },

  set(monitorType: MonitorType, monitorId: number, channelIds: number[]) {
    return db.transaction(async (tx) => {
      await tx
        .delete(monitorAlertChannels)
        .where(
          and(
            eq(monitorAlertChannels.monitorType, monitorType),
            eq(monitorAlertChannels.monitorId, monitorId),
          ),
        );
      if (channelIds.length === 0) return;
      await tx
        .insert(monitorAlertChannels)
        .values(channelIds.map((channelId) => ({ monitorType, monitorId, channelId })));
    });
  },

  clearForMonitor(monitorType: MonitorType, monitorId: number) {
    return db
      .delete(monitorAlertChannels)
      .where(
        and(
          eq(monitorAlertChannels.monitorType, monitorType),
          eq(monitorAlertChannels.monitorId, monitorId),
        ),
      );
  },
};
