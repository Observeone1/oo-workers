/**
 * exec-events teardown/error paths — the Redis-bridge failure branches the
 * integration suite can't reach without breaking its own Redis: subscribe
 * rejection, malformed channel messages, publish rejection, and the
 * reset/re-wire lifecycle. Redis itself is stubbed; only the bus logic runs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const loggerError = mock((_msg: string) => {});
mock.module('../utils/logger.ts', () => ({
  logger: { info: mock(() => {}), warn: mock(() => {}), error: loggerError },
}));

type MessageHandler = (channel: string, raw: string) => void;

function makeSubscriber() {
  const handlers = new Map<string, MessageHandler[]>();
  return {
    handlers,
    subscribe: mock(async (_channel: string) => {}),
    on: mock((event: string, handler: MessageHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    disconnect: mock(() => {}),
    emitMessage: (channel: string, raw: string) => {
      for (const h of handlers.get('message') ?? []) h(channel, raw);
    },
  };
}

function makeConnection(subscriber: ReturnType<typeof makeSubscriber>) {
  return {
    duplicate: mock(() => subscriber),
    publish: mock(async (_channel: string, _raw: string) => 1),
  };
}

const { execEvents, initEventBus, resetEventBus, EVENT_CHANNEL } = await import('./exec-events.ts');

beforeEach(() => {
  resetEventBus();
  loggerError.mockClear();
});

afterEach(() => {
  resetEventBus();
});

describe('exec-events bridge failure paths', () => {
  test('a subscribe rejection is logged instead of throwing', async () => {
    const sub = makeSubscriber();
    sub.subscribe.mockRejectedValueOnce(new Error('connection lost'));
    initEventBus(makeConnection(sub) as never);

    await Bun.sleep(10);
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('failed to subscribe'));
  });

  test('a malformed channel message is logged and ignored', () => {
    const sub = makeSubscriber();
    initEventBus(makeConnection(sub) as never);
    const listener = mock(() => {});
    execEvents.on('execution', listener as never);

    sub.emitMessage(EVENT_CHANNEL, 'this is not json{{{');
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('bad message'));
    expect(listener).not.toHaveBeenCalled();
    execEvents.off('execution', listener as never);
  });

  test('a foreign-origin message redispatches to local listeners', () => {
    const sub = makeSubscriber();
    initEventBus(makeConnection(sub) as never);
    const seen: unknown[] = [];
    const listener = (p: unknown) => {
      seen.push(p);
    };
    execEvents.on('execution', listener as never);

    sub.emitMessage(
      EVENT_CHANNEL,
      JSON.stringify({ origin: 'another-process', event: 'execution', data: { monitorId: 9 } }),
    );
    expect(seen).toEqual([{ monitorId: 9 }]);
    execEvents.off('execution', listener as never);
  });

  test('a publish rejection is logged and the local emit still delivers', async () => {
    const sub = makeSubscriber();
    const conn = makeConnection(sub);
    conn.publish.mockRejectedValueOnce(new Error('redis down'));
    initEventBus(conn as never);
    const seen: unknown[] = [];
    const listener = (p: unknown) => {
      seen.push(p);
    };
    execEvents.on('execution', listener as never);

    execEvents.emit('execution', {
      type: 'url',
      monitorId: 3,
      row: { id: 1, status: 'x' },
    } as never);
    expect(seen).toHaveLength(1);
    await Bun.sleep(10);
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('publish failed'));
    execEvents.off('execution', listener as never);
  });

  test('resetEventBus allows re-wiring against a fresh connection', () => {
    const first = makeSubscriber();
    const second = makeSubscriber();
    initEventBus(makeConnection(first) as never);
    // Second call is ignored while wired (idempotent).
    initEventBus(makeConnection(second) as never);
    expect(second.subscribe).not.toHaveBeenCalled();

    resetEventBus();
    initEventBus(makeConnection(second) as never);
    expect(second.subscribe).toHaveBeenCalledWith(EVENT_CHANNEL);
  });
});
