/**
 * udpProbe socket-failure wiring — the two places a datagram can fail after
 * DNS has resolved, which the loopback contract spec in
 * `udp-probe.unit.spec.ts` cannot reach: the `socket.send()` error callback and
 * the async `socket.on('error')` listener. Both call
 * `mapSocketError(err, host, port)` with the operator's host/port, so both are
 * driven here with a stand-in socket — to pin that a real errno reaches the
 * operator-facing message instead of a bare `err.message`, and that neither
 * path can settle as a success.
 *
 * The stand-in replaces `node:dgram`'s `createSocket` via spyOn and is restored
 * after every test; `mock.module` would poison every other spec in the run.
 * Real loopback behaviour stays covered by the sibling spec.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as dgram from 'node:dgram';
import { udpProbe } from './udp-probe.ts';

type Handler = (...args: unknown[]) => void;
type SendCallback = (err: NodeJS.ErrnoException | null) => void;

interface FakeSocket {
  socket: unknown;
  sends: Array<{ payload: Buffer; port: number; address: string }>;
  sendCallback?: SendCallback;
  closed: boolean;
  fire(event: string, ...args: unknown[]): void;
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Minimal stand-in for the dgram Socket surface udp-probe.ts actually uses. */
function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const fake: FakeSocket = {
    sends: [],
    closed: false,
    socket: undefined,
    fire(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
  fake.socket = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
    send(payload: Buffer, port: number, address: string, cb?: SendCallback) {
      fake.sends.push({ payload, port, address });
      fake.sendCallback = cb;
    },
    close() {
      fake.closed = true;
    },
  };
  return fake;
}

const fakes: FakeSocket[] = [];
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

/** Install a fresh stand-in socket, start the probe, and wait for send(). */
async function probeUntilSend(opts: {
  port: number;
  payload?: Buffer | null;
  expectResponse?: boolean;
}): Promise<{ result: ReturnType<typeof udpProbe>; fake: FakeSocket }> {
  const fake = makeFakeSocket();
  fakes.push(fake);
  const spy = spyOn(dgram, 'createSocket').mockReturnValue(fake.socket as never);
  restore = () => spy.mockRestore();
  const result = udpProbe({
    host: '127.0.0.1',
    port: opts.port,
    payload: opts.payload ?? null,
    expectResponse: opts.expectResponse ?? false,
    timeoutMs: 2000,
  });
  // DNS for the literal 127.0.0.1 resolves without network I/O; the cap only
  // stops a regression from spinning here forever.
  for (let i = 0; i < 200 && !fake.sendCallback; i++) await Bun.sleep(5);
  if (!fake.sendCallback) throw new Error('udp-probe never called socket.send()');
  return { result, fake };
}

describe('udpProbe socket send errors', () => {
  test('a send() rejection fails the probe with the mapped errno message', async () => {
    const { result, fake } = await probeUntilSend({ port: 53, payload: Buffer.from('x') });

    // The datagram targets the resolved address, not the hostname, and the
    // destination port is the operator's — not the socket's ephemeral one.
    expect(fake.sends).toEqual([{ payload: Buffer.from('x'), port: 53, address: '127.0.0.1' }]);

    fake.sendCallback?.(errno('EACCES', 'permission denied'));

    expect(await result).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      errorMessage: 'Permission denied sending to 127.0.0.1:53 (port likely privileged)',
    });
    expect(fake.closed).toBe(true);
  });

  test('an unreachable network fails with the mapped errno, not the raw message', async () => {
    const { result, fake } = await probeUntilSend({ port: 5353, payload: Buffer.from('x') });

    fake.sendCallback?.(errno('ENETUNREACH', 'connect ENETUNREACH'));

    const settled = await result;
    expect(settled.ok).toBe(false);
    // The errno's own message names neither host nor port; the mapped arm is
    // what makes the failure actionable in the UI.
    expect(settled.errorMessage).toBe('Network unreachable (127.0.0.1)');
  });

  test('an async socket error fails the probe through the same mapper', async () => {
    const { result, fake } = await probeUntilSend({
      port: 5353,
      payload: Buffer.from('x'),
      expectResponse: true,
    });

    fake.fire('error', errno('EHOSTUNREACH', 'no route to host'));

    expect(await result).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      errorMessage: 'Host unreachable (127.0.0.1)',
    });
  });

  test('a late send() rejection cannot overwrite an already-received response', async () => {
    const { result, fake } = await probeUntilSend({
      port: 5353,
      payload: Buffer.from('x'),
      expectResponse: true,
    });

    // The reply can be delivered before send()'s callback runs; the first
    // settlement wins, so the probe must not be downgraded to FAILED after.
    fake.fire('message', Buffer.from('pong'), {
      port: 5353,
      address: '127.0.0.1',
      family: 'IPv4',
      size: 4,
    });
    fake.sendCallback?.(errno('EACCES', 'permission denied'));

    expect(await result).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      responseBytes: 4,
    });
  });

  test('an async error after a send() rejection keeps the first verdict', async () => {
    const { result, fake } = await probeUntilSend({ port: 53, payload: Buffer.from('x') });

    fake.sendCallback?.(errno('EACCES', 'permission denied'));
    fake.fire('error', errno('EHOSTUNREACH', 'no route to host'));

    expect((await result).errorMessage).toBe(
      'Permission denied sending to 127.0.0.1:53 (port likely privileged)',
    );
  });
});
