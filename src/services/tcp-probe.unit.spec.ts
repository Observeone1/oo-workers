/**
 * tcpProbe contract — run against real TCP sockets on loopback: pure
 * connect-latency (no banner wanted), banner capture, expectBanner match
 * (including the multi-packet-wait path and the cap-exceeded FAIL),
 * timeout, and connection-refused/DNS error mapping.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { mapSocketError, tcpProbe } from './tcp-probe.ts';

function makeErrnoException(code: string, message = 'boom'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

let echoServer: Server;
let echoPort: number;
let silentServer: Server;
let silentPort: number;

beforeAll(async () => {
  echoServer = createServer((socket: Socket) => {
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', r));
  const echoAddr = echoServer.address();
  if (!echoAddr || typeof echoAddr !== 'object') throw new Error('no server address');
  echoPort = echoAddr.port;

  silentServer = createServer((socket: Socket) => {
    // Accept the connection but never write anything back.
    socket.on('data', () => {});
  });
  await new Promise<void>((r) => silentServer.listen(0, '127.0.0.1', r));
  const silentAddr = silentServer.address();
  if (!silentAddr || typeof silentAddr !== 'object') throw new Error('no server address');
  silentPort = silentAddr.port;
});

afterAll(() => {
  echoServer.close();
  silentServer.close();
});

describe('tcpProbe', () => {
  test('pure connect succeeds with no payload/expectBanner', async () => {
    const result = await tcpProbe({ host: '127.0.0.1', port: echoPort, timeoutMs: 2000 });

    expect(result.ok).toBe(true);
    expect(result.banner).toBeUndefined();
    expect(typeof result.latencyMs).toBe('number');
  });

  test('captures the first response chunk when a payload is sent, no expectBanner', async () => {
    const result = await tcpProbe({
      host: '127.0.0.1',
      port: echoPort,
      payload: Buffer.from('hello'),
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.banner).toBe('hello');
  });

  test('succeeds once the banner match is found', async () => {
    const result = await tcpProbe({
      host: '127.0.0.1',
      port: echoPort,
      payload: Buffer.from('SSH-2.0-test'),
      expectBanner: 'SSH-2.0',
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.banner).toContain('SSH-2.0');
  });

  test('FAILs when the banner cap is hit without a match', async () => {
    const bigServer = createServer((socket: Socket) => {
      // Reply with junk far past the 256-byte cap, never matching.
      socket.write(Buffer.alloc(1000, 'x'));
    });
    await new Promise<void>((r) => bigServer.listen(0, '127.0.0.1', r));
    const addr = bigServer.address();
    if (!addr || typeof addr !== 'object') throw new Error('no server address');

    const result = await tcpProbe({
      host: '127.0.0.1',
      port: addr.port,
      payload: Buffer.from('x'),
      expectBanner: 'never-matches',
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('Banner did not contain expected text');
    bigServer.close();
  });

  test('keeps waiting across multiple packets until the banner matches', async () => {
    const splitServer = createServer((socket: Socket) => {
      socket.write('SSH-2.');
      setTimeout(() => socket.write('0-openssh'), 20);
    });
    await new Promise<void>((r) => splitServer.listen(0, '127.0.0.1', r));
    const addr = splitServer.address();
    if (!addr || typeof addr !== 'object') throw new Error('no server address');

    const result = await tcpProbe({
      host: '127.0.0.1',
      port: addr.port,
      payload: Buffer.from('x'),
      expectBanner: 'openssh',
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.banner).toBe('SSH-2.0-openssh');
    splitServer.close();
  });

  test('times out after receiving a non-matching partial banner', async () => {
    const partialServer = createServer((socket: Socket) => {
      socket.write('nope');
    });
    await new Promise<void>((r) => partialServer.listen(0, '127.0.0.1', r));
    const addr = partialServer.address();
    if (!addr || typeof addr !== 'object') throw new Error('no server address');

    const result = await tcpProbe({
      host: '127.0.0.1',
      port: addr.port,
      payload: Buffer.from('x'),
      expectBanner: 'never-arrives',
      timeoutMs: 200,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('Banner did not contain expected text within 200ms');
    partialServer.close();
  });

  test('times out waiting for a banner from a silent server', async () => {
    const result = await tcpProbe({
      host: '127.0.0.1',
      port: silentPort,
      payload: Buffer.from('x'),
      expectBanner: 'anything',
      timeoutMs: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('No banner within 300ms');
  });

  test('maps connection-refused to a clear error', async () => {
    const probe = createServer(() => {});
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    if (!addr || typeof addr !== 'object') throw new Error('no server address');
    const deadPort = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));

    const result = await tcpProbe({ host: '127.0.0.1', port: deadPort, timeoutMs: 1000 });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('Connection refused');
  });

  test('maps DNS failures to a host-not-found message', async () => {
    const result = await tcpProbe({
      host: 'definitely-not-a-real-host.invalid',
      port: 80,
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('DNS resolution failed');
  }, 15_000);
});

describe('mapSocketError', () => {
  test('maps each known error code to its message', () => {
    expect(mapSocketError(makeErrnoException('ETIMEDOUT'), 'h', 80)).toBe(
      'Connection timed out (h:80)',
    );
    expect(mapSocketError(makeErrnoException('EHOSTUNREACH'), 'h', 80)).toBe(
      'Host unreachable (h)',
    );
    expect(mapSocketError(makeErrnoException('ENETUNREACH'), 'h', 80)).toBe(
      'Network unreachable (h)',
    );
  });

  test('falls back to the raw error message for unknown codes', () => {
    expect(mapSocketError(makeErrnoException('EWEIRD', 'something odd'), 'h', 80)).toBe(
      'something odd',
    );
  });
});
