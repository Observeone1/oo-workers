/**
 * Pure gating test for TCP banner/probe-read.
 * Ported from scripts/tcp-banner-test.ts.
 * Uses the testcontainers Redis as the probe target (PING→PONG).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { tcpProbe } from '../../src/services/tcp-probe.ts';

function redisHostPort(): { host: string; port: number } {
  try {
    const u = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

const PING = Buffer.from('PING\r\n');
let splitServer: Server | null = null;
let splitPort = 0;

beforeAll(async () => {
  splitServer = await new Promise<Server>((resolve) => {
    const s = createServer((sock) => {
      sock.write('220-server');
      setTimeout(() => {
        sock.write('.example.com ESMTP\r\n');
        sock.end();
      }, 50);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  splitPort = (splitServer.address() as { port: number }).port;
});

afterAll(() => {
  splitServer?.close();
});

describe('tcp-banner probe', () => {
  const { host, port } = redisHostPort();

  test('PING→PONG: payload + matching expectBanner → SUCCESS, banner captured', async () => {
    const r = await tcpProbe({ host, port, timeoutMs: 3000, payload: PING, expectBanner: 'PONG' });
    expect(r.ok).toBe(true);
    expect(r.banner ?? '').toContain('PONG');
  });

  test('banner mismatch FAILS but banner still captured', async () => {
    const r = await tcpProbe({ host, port, timeoutMs: 3000, payload: PING, expectBanner: 'NOPE' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect(r.banner ?? '').toContain('PONG');
  });

  test('bare connect, no payload/banner → SUCCESS, no banner', async () => {
    const r = await tcpProbe({ host, port, timeoutMs: 3000 });
    expect(r.ok).toBe(true);
    expect(r.banner).toBeFalsy();
  });

  test('unreachable port → FAILED cleanly', async () => {
    const r = await tcpProbe({ host, port: 1, timeoutMs: 2000, expectBanner: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });

  test('multi-packet banner: match survives split write', async () => {
    const r = await tcpProbe({ host: '127.0.0.1', port: splitPort, timeoutMs: 3000, expectBanner: 'ESMTP' });
    expect(r.ok).toBe(true);
    expect(r.banner ?? '').toContain('ESMTP');
  });
});
