/**
 * HTTP server: REST API + static UI.
 * Runs in the same process as workers + scheduler.
 *
 * This file is the orchestrator: it creates the Hono app, the per-type
 * BullMQ queues, the dedicated blocking-pop Redis connection for agent
 * long-polls, the auth middleware on every prefix that mutates state,
 * then mounts each `registerX(app, deps)` route module. Route handlers
 * themselves live in `src/routes/*.ts` — one file per resource group.
 */

import { Hono } from 'hono';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { requireAuth } from './middleware/auth.ts';
import { sessionRepo } from './db/repositories/session.repo.ts';
import { logger } from './utils/logger.ts';

import type { RouteDeps } from './routes/types.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerApiKeyRoutes } from './routes/api-keys.ts';
import { registerArtifactsRoutes } from './routes/artifacts.ts';
import { registerMonitorRoutes } from './routes/monitors.ts';
import { registerImportRoutes } from './routes/import.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { registerRegionRoutes } from './routes/regions.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerStatusPageRoutes } from './routes/status-pages.ts';
import { registerIncidentRoutes } from './routes/incidents.ts';
import { registerHeartbeatPublicRoutes } from './routes/heartbeat-public.ts';
import { registerStatusPublicRoutes } from './routes/status-public.ts';
import { registerAgentRoutes } from './routes/agent.ts';
import { registerEventsRoutes } from './routes/events.ts';
import { registerStaticRoutes } from './routes/static-ui.ts';

function buildApp(connection: Redis) {
  const app = new Hono();
  const urlQ = new Queue('url-monitor', { connection });
  const apiQ = new Queue('api-check', { connection });
  const qaQ = new Queue('qa-project', { connection });
  const tcpQ = new Queue('tcp-monitor', { connection });
  const udpQ = new Queue('udp-monitor', { connection });
  const dbQ = new Queue('db-monitor', { connection });
  const tlsQ = new Queue('tls-monitor', { connection });

  // Dedicated connection for blocking pops in /api/agent/jobs. BRPOP holds
  // the connection for the duration of the wait, so it must not share with
  // the BullMQ Queue ops above.
  const blockingConn = connection.duplicate();

  // ---------- Auth ----------
  // All /api/* endpoints require auth. Reads need 'read' scope (write keys
  // also satisfy), writes need 'write'. Public surfaces (the public status
  // page, heartbeat ingest, auth/setup bootstrap, /api/auth/me) live on
  // distinct routes and are not gated here.
  //
  // Each gated namespace covers two paths: the bare path (e.g. /api/monitors)
  // and the wildcard (/api/monitors/*). Hono's /* does NOT match the bare
  // path — leaving only the wildcard would let GET /api/monitors slip past.
  const writeAuth = requireAuth('write');
  const readAuth = requireAuth('read');
  const methodScoped: import('hono').MiddlewareHandler = (c, next) =>
    (c.req.method === 'GET' ? readAuth : writeAuth)(c, next);

  app.use('/api/monitors', methodScoped);
  app.use('/api/monitors/*', methodScoped);
  app.use('/api/availability', readAuth);
  app.use('/api/channels', methodScoped);
  app.use('/api/channels/*', methodScoped);
  app.use('/api/regions', methodScoped);
  app.use('/api/regions/*', methodScoped);
  app.use('/api/status-pages', methodScoped);
  app.use('/api/status-pages/*', methodScoped);

  // Write-only namespaces — even reads need a write key (or session).
  app.use('/api/import', writeAuth);
  // Backup dump contains API-key + password hashes; never reachable unauthed.
  app.use('/api/backup', writeAuth);
  app.use('/api/backup/*', writeAuth);
  app.use('/api/restore', writeAuth);
  // Incidents admin API is operator-only (the public consumes incidents
  // through /status/<slug> only, never /api/incidents).
  app.use('/api/incidents', writeAuth);
  app.use('/api/incidents/*', writeAuth);

  const deps: RouteDeps = {
    writeAuth,
    urlQ,
    apiQ,
    qaQ,
    tcpQ,
    udpQ,
    dbQ,
    tlsQ,
    blockingConn,
  };

  // ---------- Route groups ----------
  registerAuthRoutes(app);
  registerApiKeyRoutes(app, deps);
  registerArtifactsRoutes(app);
  registerMonitorRoutes(app, deps);
  registerImportRoutes(app);
  registerBackupRoutes(app);
  registerRegionRoutes(app);
  registerChannelRoutes(app);
  registerStatusPageRoutes(app);
  registerIncidentRoutes(app);
  registerHeartbeatPublicRoutes(app);
  registerStatusPublicRoutes(app);
  registerAgentRoutes(app, deps);
  registerEventsRoutes(app);
  // Static UI last so /api/* routes always win the route table.
  registerStaticRoutes(app);

  return {
    app,
    close: async () => {
      await Promise.all([
        urlQ.close(),
        apiQ.close(),
        qaQ.close(),
        tcpQ.close(),
        udpQ.close(),
        dbQ.close(),
        tlsQ.close(),
      ]);
      await blockingConn.quit().catch(() => {});
    },
  };
}

export function startServer(connection: Redis, port: number) {
  const { app, close } = buildApp(connection);
  // idleTimeout default is 10s — too short for agent long-polls (up to 60s).
  // Bumping to 120s gives ample headroom; the agent's BRPOP wait is capped
  // at 60s in /api/agent/jobs so this only closes truly dead connections.
  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
  logger.info(`🌐 server listening on http://localhost:${port}`);

  // Reap expired session rows on boot, then daily. Nothing else prunes
  // them — sessions are 30-day, so without this the table grows forever.
  const reap = () =>
    sessionRepo.deleteExpired().catch((err) => {
      logger.error(`session reap failed: ${err instanceof Error ? err.message : err}`);
    });
  void reap();
  const reaper = setInterval(reap, 24 * 60 * 60 * 1000);

  return async () => {
    clearInterval(reaper);
    server.stop();
    await close();
  };
}
