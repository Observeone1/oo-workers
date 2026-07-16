/**
 * udpProbe contract — run against real UDP sockets on loopback: fire-and-
 * forget success, response round-trips with payload delivery, the
 * wrong-source anti-spoof filter (a reply from a different port must NOT
 * count), response timeouts, DNS failures, and the hex payload parser.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { parseHexPayload, udpProbe } from './udp-probe.ts';

let echoServer: Socket;
let echoPort: number;
let received: Buffer[];

let silentServer: Socket;
let silentPort: number;
/** Replies to datagrams on silentPort, but from a DIFFERENT source port. */
let spoofReplies = false;
let spoofSocket: Socket;

beforeAll(async () => {
  received = [];
  echoServer = createSocket('udp4');
  // A pong can bounce (ICMP unreachable) when the probe socket has already
  // closed; that surfaces as an async 'error' on the sender — ignore it.
  echoServer.on('error', () => {});
  echoServer.on('message', (msg, rinfo) => {
    received.push(Buffer.from(msg));
    echoServer.send(Buffer.from('pong'), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => echoServer.bind(0, '127.0.0.1', resolve));
  echoPort = echoServer.address().port;

  spoofSocket = createSocket('udp4');
  spoofSocket.on('error', () => {});
  await new Promise<void>((resolve) => spoofSocket.bind(0, '127.0.0.1', resolve));

  silentServer = createSocket('udp4');
  silentServer.on('error', () => {});
  silentServer.on('message', (_msg, rinfo) => {
    if (spoofReplies) {
      // Reply from an unrelated socket: same host, wrong source port.
      spoofSocket.send(Buffer.from('spoof'), rinfo.port, rinfo.address);
    }
  });
  await new Promise<void>((resolve) => silentServer.bind(0, '127.0.0.1', resolve));
  silentPort = silentServer.address().port;
});

afterAll(() => {
  echoServer.close();
  silentServer.close();
  spoofSocket.close();
});

describe('udpProbe', () => {
  test('fire-and-forget succeeds once the datagram is sent', async () => {
    // Target the silent server so no reply bounces off the closed socket.
    const result = await udpProbe({
      host: '127.0.0.1',
      port: silentPort,
      payload: Buffer.from('ping'),
      expectResponse: false,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.responseBytes).toBeUndefined();
    expect(typeof result.latencyMs).toBe('number');
  });

  test('delivers the payload and counts the response from the target', async () => {
    received.length = 0;
    const result = await udpProbe({
      host: '127.0.0.1',
      port: echoPort,
      payload: Buffer.from('hello-udp'),
      expectResponse: true,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.responseBytes).toBe(4); // "pong"
    expect(received.map((b) => b.toString())).toEqual(['hello-udp']);
  });

  test('sends an empty datagram when payload is null', async () => {
    received.length = 0;
    const result = await udpProbe({
      host: '127.0.0.1',
      port: echoPort,
      payload: null,
      expectResponse: true,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(received[0]?.length).toBe(0);
  });

  test('ignores replies from the wrong source port (anti-spoof)', async () => {
    spoofReplies = true;
    try {
      const result = await udpProbe({
        host: '127.0.0.1',
        port: silentPort,
        payload: Buffer.from('x'),
        expectResponse: true,
        timeoutMs: 400,
      });

      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('No response within 400ms');
    } finally {
      spoofReplies = false;
    }
  });

  test('times out when the target never answers', async () => {
    const result = await udpProbe({
      host: '127.0.0.1',
      port: silentPort,
      payload: Buffer.from('x'),
      expectResponse: true,
      timeoutMs: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe(`No response within 300ms (127.0.0.1:${silentPort})`);
  });

  test('maps DNS failures to a host-not-found message', async () => {
    const result = await udpProbe({
      host: 'definitely-not-a-real-host.invalid',
      port: 53,
      payload: null,
      expectResponse: false,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('DNS resolution failed');
  });
});

describe('parseHexPayload', () => {
  test('returns null for empty input', () => {
    expect(parseHexPayload(null)).toBeNull();
    expect(parseHexPayload(undefined)).toBeNull();
    expect(parseHexPayload('')).toBeNull();
    expect(parseHexPayload('   ')).toBeNull();
  });

  test('parses hex with mixed case and whitespace', () => {
    expect(parseHexPayload('deadbeef')).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(parseHexPayload('DE AD BE EF')).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  test('rejects odd-length and non-hex strings', () => {
    expect(() => parseHexPayload('abc')).toThrow('even-length');
    expect(() => parseHexPayload('zz')).toThrow('hex characters');
  });
});
