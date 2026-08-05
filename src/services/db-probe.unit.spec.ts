/**
 * dbProbe contract — run against real TCP/TLS servers on loopback speaking
 * each protocol's opening bytes: redis (+/-), mysql (handshake/ERR), and
 * postgres (R/E), plus the tls:true liveness wrap, timeout, protocol
 * mismatch, close-before-response, and connection-refused/DNS mapping.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { dbProbe, mapErr } from './db-probe.ts';

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP_TLS = !haveOpenssl();
let dir = '';
let tlsServer: TlsServer | null = null;
let tlsPort = 0;

beforeAll(async () => {
  if (SKIP_TLS) return;
  dir = mkdtempSync(join(tmpdir(), 'oo-db-probe-unit-'));
  const key = join(dir, 'k');
  const crt = join(dir, 'c');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      crt,
      '-days',
      '2',
      '-nodes',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  tlsServer = createTlsServer({ key: readFileSync(key), cert: readFileSync(crt) }, (socket) => {
    socket.write('+PONG\r\n');
  });
  await new Promise<void>((r) => tlsServer!.listen(0, '127.0.0.1', r));
  const addr = tlsServer.address();
  if (!addr || typeof addr !== 'object') throw new Error('no server address');
  tlsPort = addr.port;
});

afterAll(() => {
  tlsServer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function withServer(
  handler: (socket: Socket) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createNetServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no server address');
  try {
    await run(addr.port);
  } finally {
    server.close();
  }
}

describe('dbProbe', () => {
  test('redis: a "+" reply proves liveness', async () => {
    await withServer(
      (socket) => socket.on('data', () => socket.write('+PONG\r\n')),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'redis',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('redis: a "-" (NOAUTH) reply still proves liveness', async () => {
    await withServer(
      (socket) => socket.on('data', () => socket.write('-NOAUTH Authentication required.\r\n')),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'redis',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('redis: an unrelated reply FAILs as a protocol mismatch', async () => {
    await withServer(
      (socket) => socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\n')),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'redis',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('response did not look like redis');
      },
    );
  });

  test('mysql: a handshake protocol-version byte proves liveness (server speaks first)', async () => {
    await withServer(
      (socket) => {
        // 4-byte header + payload[0]=0x0a (protocol version 10).
        socket.write(Buffer.from([0, 0, 0, 0, 0x0a, ...Buffer.from('5.7.0')]));
      },
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'mysql',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('mysql: an ERR packet (0xff) still proves liveness', async () => {
    await withServer(
      (socket) => {
        socket.write(Buffer.from([0, 0, 0, 0, 0xff, 0, 0]));
      },
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'mysql',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('mysql: a short/garbage reply FAILs as a protocol mismatch', async () => {
    await withServer(
      (socket) => socket.write(Buffer.from([1, 2])),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'mysql',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('response did not look like mysql');
      },
    );
  });

  test('postgres: an Authentication (R) reply proves liveness', async () => {
    await withServer(
      (socket) => socket.on('data', () => socket.write(Buffer.from('R'))),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'postgres',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('postgres: an ErrorResponse (E) reply still proves liveness', async () => {
    await withServer(
      (socket) => socket.on('data', () => socket.write(Buffer.from('E'))),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'postgres',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  test('postgres: sends a StartupMessage and rejects an unrelated reply', async () => {
    let received: Buffer | undefined;
    await withServer(
      (socket) =>
        socket.on('data', (d: Buffer) => {
          received = d;
          socket.write(Buffer.from('X'));
        }),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'postgres',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('response did not look like postgres');
      },
    );
    // StartupMessage: length + protocol 3.0 (0x00030000) + user\0liveness\0\0.
    expect(received?.readInt32BE(4)).toBe(196608);
  });

  test('tls: wraps the liveness exchange and still proves redis is up', async () => {
    if (SKIP_TLS) return;
    const result = await dbProbe({
      host: '127.0.0.1',
      port: tlsPort,
      protocol: 'redis',
      timeoutMs: 2000,
      tls: true,
    });

    expect(result.ok).toBe(true);
  });

  test('FAILs when the server closes before any response', async () => {
    await withServer(
      (socket) => socket.end(),
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'redis',
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('closed before a redis response');
      },
    );
  });

  test('times out when the server never responds', async () => {
    await withServer(
      () => {
        /* accept, never respond */
      },
      async (port) => {
        const result = await dbProbe({
          host: '127.0.0.1',
          port,
          protocol: 'redis',
          timeoutMs: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('timed out after 300ms (redis');
      },
    );
  });

  test('maps connection-refused to a clear error', async () => {
    const server = createNetServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no server address');
    const deadPort = addr.port;
    await new Promise<void>((r) => server.close(() => r()));

    const result = await dbProbe({
      host: '127.0.0.1',
      port: deadPort,
      protocol: 'redis',
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('connection refused');
  });

  test('maps DNS failures to a host-not-found message', async () => {
    const result = await dbProbe({
      host: 'definitely-not-a-real-host.invalid',
      port: 6379,
      protocol: 'redis',
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('DNS resolution failed');
  }, 15_000);
});

function makeErrnoException(code: string, message = 'boom'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('mapErr', () => {
  // ETIMEDOUT/EHOSTUNREACH/ENETUNREACH require real network conditions
  // loopback can't produce — exercise the pure mapping directly instead.
  const opts = { host: 'h', port: 6379, protocol: 'redis' as const, timeoutMs: 1000 };

  test('maps each known error code to its message', () => {
    expect(mapErr(makeErrnoException('ETIMEDOUT'), opts)).toBe('connect timed out (h:6379)');
    expect(mapErr(makeErrnoException('EHOSTUNREACH'), opts)).toBe('host unreachable (h)');
    expect(mapErr(makeErrnoException('ENETUNREACH'), opts)).toBe('network unreachable (h)');
  });

  test('falls back to the raw error message for unknown codes', () => {
    expect(mapErr(makeErrnoException('EWEIRD', 'something odd'), opts)).toBe('something odd');
  });
});
