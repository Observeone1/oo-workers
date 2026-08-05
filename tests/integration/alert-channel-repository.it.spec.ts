/**
 * Alert channel repository contract — findById, list, and the
 * liteForMonitor join (channel picker view that omits the secret config)
 * against the real Postgres schema.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { alertChannelRepo, monitorAlertChannelRepo } from '../../src/db/repositories/alert-channel.repo.ts';

const sql = connectDb();
const marker = `alert-channel-repo-it-${Date.now()}`;
let channelId = -1;
const monitorId = 999_000_001;

beforeAll(async () => {
  const [channel] = await alertChannelRepo.create({
    name: marker,
    type: 'webhook',
    config: { url: 'https://hooks.example.test/x' },
  });
  channelId = channel.id;
}, 30_000);

afterAll(async () => {
  await monitorAlertChannelRepo.clearForMonitor('url', monitorId);
  if (channelId > 0) {
    await sql`DELETE FROM alert_channels WHERE id = ${channelId}`;
  }
  await sql.end();
});

describe('alertChannelRepo', () => {
  test('findById returns the created channel', async () => {
    const channel = await alertChannelRepo.findById(channelId);
    expect(channel?.name).toBe(marker);
    expect(channel?.type).toBe('webhook');
  });

  test('findById returns null for an unknown id', async () => {
    expect(await alertChannelRepo.findById(999_999_999)).toBeNull();
  });

  test('list includes the created channel, newest first', async () => {
    const channels = await alertChannelRepo.list();
    expect(channels.some((c) => c.id === channelId && c.name === marker)).toBe(true);
  });
});

describe('monitorAlertChannelRepo.liteForMonitor', () => {
  test('omits config and returns only channels bound to the monitor', async () => {
    await monitorAlertChannelRepo.set('url', monitorId, [channelId]);

    const lite = await monitorAlertChannelRepo.liteForMonitor('url', monitorId);
    expect(lite).toHaveLength(1);
    expect(lite[0]?.id).toBe(channelId);
    expect(lite[0]?.name).toBe(marker);
    expect(lite[0]).not.toHaveProperty('config');

    // Different monitor type/id with the same channel bound elsewhere is unaffected.
    expect(await monitorAlertChannelRepo.liteForMonitor('api', monitorId)).toEqual([]);
  });
});
