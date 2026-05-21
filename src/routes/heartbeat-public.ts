/**
 * Public heartbeat endpoints (Roadmap 8).
 *
 * POST /heartbeat/:token — UNAUTHENTICATED. Services / cron jobs ping
 * this on each successful run; the repo debounces pings <1s apart
 * (leaked-token flood mitigation), updates last_ping_at, and flips
 * status to UP. If the heartbeat was OVERDUE we fire a recovery alert.
 *
 * GET /heartbeat/:token — read-only. Returns current status without
 * recording a ping. Previously GET also pinged, but Slack/iMessage/
 * Discord pre-fetch unfurled URLs which silently triggered pings every
 * time a token URL was pasted into chat.
 */
import type { Hono } from 'hono';
import { heartbeatRepo } from '../db/repositories/heartbeat.repo.ts';
import { dispatchAlert } from '../services/alert-dispatch.ts';

export function registerHeartbeatPublicRoutes(app: Hono): void {
  app.post('/heartbeat/:token', async (c) => {
    const token = c.req.param('token');
    if (!token) return c.json({ error: 'token required' }, 400);
    const result = await heartbeatRepo.recordPing(token);
    if (!result) return c.json({ error: 'unknown heartbeat' }, 404);
    const { row, wasOverdue } = result;
    if (wasOverdue) {
      // Fire-and-forget — never throws (see dispatchAlert contract).
      void dispatchAlert({
        monitor: { type: 'heartbeat', id: row.id, name: row.name, target: row.name },
        event: 'recovery',
        status: 'SUCCESS',
        startTime: new Date().toISOString(),
      }).catch(() => {});
    }
    return c.json({ ok: true, status: row.status, lastPingAt: row.lastPingAt }, 200);
  });

  app.get('/heartbeat/:token', async (c) => {
    const token = c.req.param('token');
    if (!token) return c.json({ error: 'token required' }, 400);
    const row = await heartbeatRepo.findByPublicToken(token);
    if (!row) return c.json({ error: 'unknown heartbeat' }, 404);
    return c.json({ ok: true, status: row.status, lastPingAt: row.lastPingAt }, 200);
  });
}
