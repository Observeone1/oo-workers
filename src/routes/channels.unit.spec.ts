/**
 * /api/channels HTTP contract — driven through a real Hono app via
 * app.request(): CRUD validation (per-type url/email rules), the test-send
 * flow with its 502 failure mapping, and the dev-only Mailpit read-back
 * augmentation. Repo, dispatch and mailpit are mocked at their module
 * boundaries; route logic runs for real.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

import { alertChannelRepoMock, mockAlertChannelRepo } from '../test-support/shared-mocks.ts';

const { list, create, findById, deleteById } = alertChannelRepoMock;
const sendToChannel = mock(async (): Promise<boolean> => true);
const isLocalMailpit = mock((): boolean => false);
const findRecentTestMessage = mock(async (): Promise<unknown> => ({ delivered: false }));

mockAlertChannelRepo();
mock.module('../services/alert-dispatch.ts', () => ({ sendToChannel }));
mock.module('../services/mailpit.ts', () => ({ isLocalMailpit, findRecentTestMessage }));

const { registerChannelRoutes } = await import('./channels.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerChannelRoutes(app);
  return app;
}

beforeEach(() => {
  for (const m of [
    list,
    create,
    findById,
    deleteById,
    sendToChannel,
    isLocalMailpit,
    findRecentTestMessage,
  ])
    m.mockReset();
  list.mockResolvedValue([]);
  create.mockImplementation(async (v: Record<string, unknown>) => [{ id: 9, ...v }]);
  findById.mockResolvedValue(null);
  sendToChannel.mockResolvedValue(true);
  isLocalMailpit.mockReturnValue(false);
});

function post(body: unknown) {
  return makeApp().request('/api/channels', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/channels validation', () => {
  test.each([
    [{ type: 'webhook', url: 'https://x.example' }, 'name is required'],
    [
      { name: 'c', type: 'pager', url: 'https://x.example' },
      'type must be one of webhook, discord, slack, email',
    ],
    [{ name: 'c', type: 'email', url: 'not-an-address' }, 'a recipient email address is required'],
    [
      { name: 'c', type: 'webhook', url: 'ftp://x.example' },
      'url is required (http:// or https://)',
    ],
    [{ name: 'c', type: 'slack', url: '' }, 'url is required (http:// or https://)'],
  ])('rejects %j', async (body, error) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(create).not.toHaveBeenCalled();
  });

  test('stores the recipient as config.to for email channels', async () => {
    const res = await post({ name: ' Ops mail ', type: 'email', url: ' ops@example.com ' });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      name: 'Ops mail',
      type: 'email',
      config: { to: 'ops@example.com' },
    });
    expect(await res.json()).toMatchObject({ id: 9, type: 'email' });
  });

  test('stores the url as config.url for webhook-style channels', async () => {
    await post({ name: 'hook', type: 'discord', url: 'https://discord.example/wh' });

    expect(create).toHaveBeenCalledWith({
      name: 'hook',
      type: 'discord',
      config: { url: 'https://discord.example/wh' },
    });
  });
});

describe('GET/DELETE /api/channels', () => {
  test('lists channels', async () => {
    list.mockResolvedValue([{ id: 1, name: 'hook' }]);
    const res = await makeApp().request('/api/channels');
    expect(await res.json()).toEqual([{ id: 1, name: 'hook' }]);
  });

  test('delete: 400 on bad id, 404 on missing, 204 on success', async () => {
    expect((await makeApp().request('/api/channels/x', { method: 'DELETE' })).status).toBe(400);
    expect((await makeApp().request('/api/channels/5', { method: 'DELETE' })).status).toBe(404);

    findById.mockResolvedValue({ id: 5 });
    const res = await makeApp().request('/api/channels/5', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteById).toHaveBeenCalledWith(5);
  });
});

describe('POST /api/channels/:id/test', () => {
  const testReq = (id: string) => makeApp().request(`/api/channels/${id}/test`, { method: 'POST' });

  test('404 for an unknown channel, 400 for a bad id', async () => {
    expect((await testReq('77')).status).toBe(404);
    expect((await testReq('nope')).status).toBe(400);
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  test('sends a synthetic test alert through the channel', async () => {
    findById.mockResolvedValue({ id: 5, type: 'webhook', config: { url: 'https://x' } });

    const res = await testReq('5');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [channel, ctx] = sendToChannel.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(channel).toMatchObject({ id: 5 });
    expect(ctx).toMatchObject({ event: 'test', status: 'TEST', statusCode: 200 });
  });

  test('maps delivery failure to 502', async () => {
    findById.mockResolvedValue({ id: 5, type: 'slack', config: { url: 'https://x' } });
    sendToChannel.mockResolvedValue(false);

    const res = await testReq('5');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'channel delivery failed; check worker logs',
    });
  });

  test('augments email test sends with the Mailpit read-back in dev', async () => {
    findById.mockResolvedValue({ id: 5, type: 'email', config: { to: 'ops@example.com' } });
    isLocalMailpit.mockReturnValue(true);
    findRecentTestMessage.mockResolvedValue({ delivered: true, subject: 'Test alert: x' });

    const res = await testReq('5');
    expect(await res.json()).toEqual({
      ok: true,
      mailpit: { delivered: true, subject: 'Test alert: x' },
    });
    expect(findRecentTestMessage).toHaveBeenCalledWith({
      to: 'ops@example.com',
      subjectIncludes: 'Test alert:',
    });
  });

  test('skips the read-back outside dev', async () => {
    findById.mockResolvedValue({ id: 5, type: 'email', config: { to: 'ops@example.com' } });
    isLocalMailpit.mockReturnValue(false);

    const res = await testReq('5');
    expect(await res.json()).toEqual({ ok: true });
    expect(findRecentTestMessage).not.toHaveBeenCalled();
  });
});
