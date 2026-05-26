/**
 * GET /api/events — Server-Sent Events feed for the dashboard.
 *
 * One connection per open dashboard tab. The server pushes a typed event
 * for every change visible to operators (execution, monitor-state,
 * monitor-created/deleted, region). Clients (`src/ui/events.ts`)
 * dispatch by event name to per-view handlers.
 *
 * Auth: same `requireAuth('read')` as the rest of `/api/*`. Cookie or
 * Bearer both work. The auth check fires once at connection open — if
 * the key is revoked or the session expires mid-stream, the next
 * client-driven request hits the gated middleware separately and the
 * dashboard's apiFetch shim handles the redirect.
 *
 * Wire format: standard text/event-stream. Each message is
 * `event: <name>\ndata: <JSON>\n\n`. A `:ping\n\n` comment line is sent
 * every 15s to keep proxies and load balancers from dropping idle
 * connections.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../middleware/auth.ts';
import { execEvents } from '../services/exec-events.ts';
import { logger } from '../utils/logger.ts';

const KEEPALIVE_MS = 15_000;

export function registerEventsRoutes(app: Hono): void {
  app.get('/api/events', requireAuth('read'), (c) => {
    return streamSSE(c, async (stream) => {
      const send = async (event: string, data: unknown) => {
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };

      // Bind listeners. Each one forwards the typed payload as the
      // matching SSE event. Capture references so we can off() them on
      // disconnect — leaking listeners means every reconnect doubles
      // the broadcast cost.
      const onExecution = (p: unknown) => void send('execution', p);
      const onMonitorState = (p: unknown) => void send('monitor-state', p);
      const onMonitorCreated = (p: unknown) => void send('monitor-created', p);
      const onMonitorDeleted = (p: unknown) => void send('monitor-deleted', p);
      const onRegion = (p: unknown) => void send('region', p);

      execEvents.on('execution', onExecution);
      execEvents.on('monitor-state', onMonitorState);
      execEvents.on('monitor-created', onMonitorCreated);
      execEvents.on('monitor-deleted', onMonitorDeleted);
      execEvents.on('region', onRegion);

      // Initial hello — gives the client a known synchronous event so the
      // EventSource "open" state can be confirmed in tests. Also useful
      // as a debug breadcrumb in logs.
      await send('hello', { ts: new Date().toISOString() });

      // Keepalive loop — emits an SSE comment (line starting with `:`)
      // so reverse proxies and CDNs don't drop the idle connection. The
      // hono streamSSE helper exposes the underlying writeRaw for this.
      const keepalive = setInterval(() => {
        // writeSSE-style comment: a comment is any line beginning with a
        // colon, terminated by an empty line. hono doesn't expose a
        // dedicated comment helper, so write the raw bytes.
        stream.writeln(':ping').catch(() => {
          // Connection closed mid-write; cleanup is driven by the
          // promise resolving below.
        });
      }, KEEPALIVE_MS);

      // Cleanup runs when hono's stream-aborted listener fires (client
      // disconnect, broken pipe, EOF). c.req.raw.signal.aborted does NOT
      // fire reliably for SSE response cancellations — use stream.onAbort
      // which hono's streamSSE wires up against its underlying writer.
      const cleanup = () => {
        clearInterval(keepalive);
        execEvents.off('execution', onExecution);
        execEvents.off('monitor-state', onMonitorState);
        execEvents.off('monitor-created', onMonitorCreated);
        execEvents.off('monitor-deleted', onMonitorDeleted);
        execEvents.off('region', onRegion);
        logger.info('SSE: client disconnected');
      };
      stream.onAbort(cleanup);

      // Keep the callback alive until aborted. Without an awaited promise
      // here, the helper would consider the stream "done" and close it
      // immediately. We resolve as soon as onAbort fires.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });
}
