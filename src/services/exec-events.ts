/**
 * Cross-process event bus for dashboard live updates.
 *
 * Every place that mutates state visible to the dashboard publishes a
 * typed event here. The SSE endpoint (`/api/events` in `routes/events.ts`)
 * subscribes per connection and forwards events to connected dashboards.
 *
 * Why Redis pub/sub and not a bare in-process EventEmitter: the shipped
 * `docker-compose` runs two processes — `worker` (scheduler + BullMQ
 * processors) and `ui` (HTTP API + the SSE stream). The scheduler/processor
 * events (executions, heartbeat OVERDUE, region online/offline) are emitted
 * in the worker, but the SSE stream lives in the ui process. A bare
 * EventEmitter cannot cross that boundary, so those updates never reached
 * the browser (regression shipped in v1.26.0–v1.28.0, fixed in v1.28.1).
 *
 * The bridge: `emit()` delivers to local listeners synchronously (so the
 * same process, and single-process tests, behave exactly as before) AND
 * publishes the event to a Redis channel. A dedicated subscriber connection
 * in every process re-dispatches incoming messages locally, skipping the
 * ones it published itself (origin dedup → no double-delivery). If the bus
 * is never wired to Redis (unit tests, ad-hoc scripts), `emit()` simply
 * stays in-process — graceful degradation, no hard Redis dependency.
 *
 * Events are coarse: one per execution row write, one per surfaced
 * monitor-state transition, one per monitor lifecycle change, one per
 * region status change. Payloads are intentionally small — clients
 * patch their in-memory state from the payload + a follow-up GET only
 * when they need details that don't fit on the wire.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../utils/logger.ts';

// Local union for monitor types — keep in sync with
// src/db/repositories/region.repo.ts MonitorType. Duplicated here so the
// SSE wire format doesn't pull a server-side type into the client bundle.
type EventMonitorType = 'url' | 'api' | 'qa' | 'tcp' | 'udp' | 'db' | 'tls' | 'heartbeat';

interface ExecutionEvent {
  type: EventMonitorType;
  monitorId: number;
  row: {
    id: number;
    status: string;
    latencyMs?: number | null;
    responseTimeMs?: number | null;
    statusCode?: number | null;
    errorMessage?: string | null;
    startTime: string;
    regionId?: number | null;
  };
}

interface MonitorStateEvent {
  type: EventMonitorType;
  monitorId: number;
  status: string;
  lastTransitionAt: string;
}

interface MonitorLifecycleEvent {
  type: EventMonitorType;
  monitorId: number;
}

interface RegionEvent {
  regionId: number;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
}

type BusEvents = {
  execution: [ExecutionEvent];
  'monitor-state': [MonitorStateEvent];
  'monitor-created': [MonitorLifecycleEvent];
  'monitor-deleted': [MonitorLifecycleEvent];
  region: [RegionEvent];
};

// EventEmitter typing trick — declare a typed wrapper so TS catches typos
// in emit() / on() event names.
interface TypedEmitter {
  emit<E extends keyof BusEvents>(event: E, ...args: BusEvents[E]): boolean;
  on<E extends keyof BusEvents>(event: E, listener: (...args: BusEvents[E]) => void): this;
  off<E extends keyof BusEvents>(event: E, listener: (...args: BusEvents[E]) => void): this;
  listenerCount<E extends keyof BusEvents>(event: E): number;
}

const emitter = new EventEmitter();
// SSE connections accumulate listeners in burst; the default 10-listener
// warning fires falsely. 256 is well above the realistic ceiling (one per
// open dashboard tab, per event type, per process).
emitter.setMaxListeners(256);

// --- Redis bridge state ---------------------------------------------------
// A stable id for this process so it can ignore the messages it published
// itself (the local emit already delivered those synchronously).
const ORIGIN = randomUUID();
/** Redis pub/sub channel carrying the cross-process events. Exported so the
 * bridge regression test can publish/subscribe on the exact same channel. */
export const EVENT_CHANNEL = 'oo:events';
let publisher: Redis | null = null;
let subscriber: Redis | null = null;

/**
 * Wire the bus to Redis so events cross the worker/ui process boundary.
 * Call once at process start, after the Redis connection exists. Idempotent:
 * a second call is ignored. The subscriber runs on a dedicated duplicate
 * connection because a Redis connection in subscribe mode can't issue other
 * commands.
 */
export function initEventBus(connection: Redis): void {
  if (publisher) return; // already wired
  publisher = connection;
  subscriber = connection.duplicate();
  subscriber.subscribe(EVENT_CHANNEL).catch((err) => {
    logger.error(`event bus: failed to subscribe to ${EVENT_CHANNEL}: ${err}`);
  });
  subscriber.on('message', (_channel, raw) => {
    try {
      const msg = JSON.parse(raw) as { origin: string; event: string; data: unknown };
      if (msg.origin === ORIGIN) return; // our own publish — already delivered locally
      emitter.emit(msg.event, msg.data);
    } catch (err) {
      logger.error(`event bus: bad message on ${EVENT_CHANNEL}: ${err}`);
    }
  });
  logger.info('event bus bridged via redis pub/sub');
}

/**
 * Tear down the Redis bridge so a test can re-wire it against a fresh
 * connection. Production never calls this — the bus lives for the whole
 * process lifetime. Exists only so the bridge regression test is
 * deterministic regardless of which integration file ran first.
 */
export function resetEventBus(): void {
  subscriber?.disconnect();
  subscriber = null;
  publisher = null;
}

// The public bus. emit() delivers locally (synchronous — same-process
// listeners and tests see it immediately) and, when bridged, fans the event
// out to other processes via Redis. on()/off() are plain local subscriptions.
export const execEvents: TypedEmitter = {
  emit(event, ...args) {
    const delivered = emitter.emit(event, ...args);
    if (publisher) {
      publisher
        .publish(EVENT_CHANNEL, JSON.stringify({ origin: ORIGIN, event, data: args[0] }))
        .catch((err) => logger.error(`event bus: publish failed: ${err}`));
    }
    return delivered;
  },
  on(event, listener) {
    emitter.on(event, listener as (...a: unknown[]) => void);
    return this;
  },
  off(event, listener) {
    emitter.off(event, listener as (...a: unknown[]) => void);
    return this;
  },
  listenerCount(event) {
    return emitter.listenerCount(event);
  },
};

/**
 * Convenience emitter used by every monitor-type processor. One line at
 * every processor exit point (success + final-attempt failure) feeds the
 * dashboard's list + detail views in real time without each processor
 * caring about the payload shape.
 *
 * Always-now startTime is acceptable for the wire format — the actual
 * row in the DB carries the authoritative timestamp; this payload is
 * just a hint for the dashboard to patch a row in place.
 */
export function emitExecution(
  type: EventMonitorType,
  monitorId: number,
  row: {
    id: number;
    status: string;
    latencyMs?: number | null;
    responseTimeMs?: number | null;
    statusCode?: number | null;
    errorMessage?: string | null;
    regionId?: number | null;
  },
): void {
  execEvents.emit('execution', {
    type,
    monitorId,
    row: { ...row, startTime: new Date().toISOString() },
  });
}

/** Used by routes/monitors.ts create / delete handlers and the public
 * heartbeat ingest (when a new heartbeat token is minted). */
export function emitMonitorCreated(type: EventMonitorType, monitorId: number): void {
  execEvents.emit('monitor-created', { type, monitorId });
}
export function emitMonitorDeleted(type: EventMonitorType, monitorId: number): void {
  execEvents.emit('monitor-deleted', { type, monitorId });
}
