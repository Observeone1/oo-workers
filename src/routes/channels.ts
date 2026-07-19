/**
 * /api/channels — alert channel CRUD + test send. The wire field is
 * `url` for every type; for email it carries the recipient address and
 * is stored as config.to (the SMTP server itself is operator env
 * config, not per-channel).
 */
import type { Hono } from 'hono';
import { alertChannelRepo, type ChannelType } from '../db/repositories/alert-channel.repo.ts';
import { sendToChannel } from '../services/alert-dispatch.ts';
import { isLocalMailpit, findRecentTestMessage } from '../services/mailpit.ts';
import { isValidEmailAddress } from '../utils/email.ts';

const VALID_CHANNEL_TYPES: ChannelType[] = ['webhook', 'discord', 'slack', 'email'];

export function registerChannelRoutes(app: Hono): void {
  app.get('/api/channels', async (c) => {
    const rows = await alertChannelRepo.list();
    return c.json(rows);
  });

  app.post('/api/channels', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const type = typeof body.type === 'string' ? body.type : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!VALID_CHANNEL_TYPES.includes(type as ChannelType)) {
      return c.json({ error: `type must be one of ${VALID_CHANNEL_TYPES.join(', ')}` }, 400);
    }
    let config: Record<string, unknown>;
    if (type === 'email') {
      if (!isValidEmailAddress(url)) {
        return c.json({ error: 'a recipient email address is required' }, 400);
      }
      config = { to: url };
    } else {
      if (!url || !/^https?:\/\//i.test(url)) {
        return c.json({ error: 'url is required (http:// or https://)' }, 400);
      }
      config = { url };
    }
    const [row] = await alertChannelRepo.create({
      name,
      type: type as ChannelType,
      config,
    });
    return c.json(row, 201);
  });

  app.delete('/api/channels/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const existing = await alertChannelRepo.findById(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    await alertChannelRepo.deleteById(id);
    return c.body(null, 204);
  });

  // Send a test payload through the channel. Helpful before binding it to
  // any monitor: operator pastes the URL, clicks Test, confirms the alert
  // lands in Discord/Slack/etc. before plumbing it into production.
  app.post('/api/channels/:id/test', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const channel = await alertChannelRepo.findById(id);
    if (!channel) return c.json({ error: 'not found' }, 404);
    const ok = await sendToChannel(channel, {
      monitor: {
        type: 'url',
        id: 0,
        name: 'oo-workers test alert',
        target: 'https://example.com',
      },
      event: 'test',
      status: 'TEST',
      statusCode: 200,
      errorMessage: 'This is a test alert from the oo-workers dashboard. Ignore.',
      durationMs: 42,
      startTime: new Date().toISOString(),
      regionSlug: null,
    });
    if (!ok) return c.json({ ok: false, error: 'channel delivery failed; check worker logs' }, 502);
    // Dev-only: when SMTP points at a local Mailpit, confirm the test
    // email actually landed (not just "SMTP accepted"). Production has no
    // OO_MAILPIT_API → isLocalMailpit() false → identical {ok:true}.
    if (channel.type === 'email' && isLocalMailpit()) {
      const to = (channel.config as { to?: string } | null)?.to ?? null;
      const mailpit = await findRecentTestMessage({ to, subjectIncludes: 'Test alert:' });
      return c.json({ ok: true, mailpit });
    }
    return c.json({ ok: true });
  });
}
