/**
 * Dashboard-side EventSource dispatcher.
 *
 * One EventSource per dashboard tab, owned by `app.ts` (which calls
 * `startEventStream()` once on mount). Views register/unregister
 * handlers as they navigate in and out — the connection stays open
 * across hash changes, no reconnect storm.
 *
 * Pauses on background tabs to avoid keeping idle SSE connections open
 * across every operator's 30 browser tabs.
 */

type Handler = (data: unknown) => void;

const handlers: Record<string, Set<Handler>> = {};
let es: EventSource | null = null;

const SSE_EVENT_NAMES = [
  'execution',
  'monitor-state',
  'monitor-created',
  'monitor-deleted',
  'region',
] as const;

function attachListeners(source: EventSource): void {
  for (const ev of SSE_EVENT_NAMES) {
    source.addEventListener(ev, (e) => {
      let data: unknown;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        return; // malformed payload — ignore rather than break the stream
      }
      handlers[ev]?.forEach((fn) => fn(data));
    });
  }
}

/**
 * Open the live-events stream. Idempotent — calling twice is a no-op
 * unless the previous stream is closed. Call once from app.ts on auth
 * success.
 */
export function startEventStream(): void {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource('/api/events', { withCredentials: true });
  attachListeners(es);
  es.onerror = () => {
    // EventSource auto-reconnects with exponential backoff. The browser
    // will keep retrying — nothing to do here. (When session expires,
    // the reconnect will get a 401 and the dashboard's apiFetch shim
    // catches the session_expired code on the next regular request.)
  };
}

/**
 * Subscribe to a stream event. Returns an unsubscribe function — call
 * it on view unmount to avoid leaking handlers across navigation.
 *
 *     const off = on('execution', (data) => patchRow(data));
 *     // later, on unmount:
 *     off();
 */
export function on(event: string, fn: Handler): () => void {
  (handlers[event] ??= new Set()).add(fn);
  return () => handlers[event]?.delete(fn);
}

/**
 * Close the current stream. Used by the visibility-hidden pause and on
 * logout. The next startEventStream() reopens.
 */
function closeEventStream(): void {
  if (es) {
    es.close();
    es = null;
  }
}

/**
 * Pause the stream when the tab is hidden. Operators commonly have many
 * tabs open across many self-host instances; keeping an SSE connection
 * alive for each one would be expensive and useless (no view consuming
 * the events when the tab isn't visible).
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      closeEventStream();
    } else if (handlers && Object.keys(handlers).some((k) => (handlers[k]?.size ?? 0) > 0)) {
      // Only reopen if at least one view is subscribed.
      startEventStream();
    }
  });
}
