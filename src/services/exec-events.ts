/**
 * In-process event bus for dashboard live updates.
 *
 * Every place in the worker that mutates state visible to the dashboard
 * publishes a typed event here. The SSE endpoint (`/api/events` in
 * `routes/events.ts`) subscribes per connection and forwards events to
 * connected dashboards. No external dependencies — this is just a thin
 * EventTarget wrapper with strong types.
 *
 * Why an in-process bus and not Redis pub/sub: oo-workers runs a single
 * master process today (the one that processes BullMQ jobs is the same
 * one that serves the HTTP API). If multi-process scale ever lands, swap
 * the internal emit/subscribe for Redis publish/subscribe — the public
 * shape of this module doesn't change.
 *
 * Events are coarse: one per execution row write, one per surfaced
 * monitor-state transition, one per monitor lifecycle change, one per
 * region status change. Payloads are intentionally small — clients
 * patch their in-memory state from the payload + a follow-up GET only
 * when they need details that don't fit on the wire.
 */
import { EventEmitter } from 'node:events';

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
}

const emitter = new EventEmitter() as EventEmitter & TypedEmitter;
// SSE connections accumulate listeners in burst; the default 10-listener
// warning fires falsely. 256 is well above the realistic ceiling (one per
// open dashboard tab, per event type, per process).
emitter.setMaxListeners(256);

export const execEvents: TypedEmitter = emitter;

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
