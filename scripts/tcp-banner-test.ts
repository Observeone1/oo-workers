#!/usr/bin/env bun
/**
 * Gating regression test for TCP banner/probe-read. Pure — calls tcpProbe
 * directly against the integration stack's Redis (REDIS host:port), no DB
 * or HTTP server. Redis is a perfect fixture: `PING\r\n` → `+PONG`.
 *
 * Run standalone: `bun scripts/tcp-banner-test.ts`
 * Also a stage in scripts/run-integration.sh (pre-push + CI).
 */

import { createServer, type Server } from 'node:net';
import { tcpProbe } from '../src/services/tcp-probe.ts';

// run-integration.sh exports REDIS_URL=redis://[:pw@]host:port
function redisHostPort(): { host: string; port: number } {
  try {
    const u = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

const { host, port } = redisHostPort();
const PING = Buffer.from('PING\r\n'); // 50 49 4e 47 0d 0a

// 1. payload + matching expectBanner → SUCCESS, banner captured.
const ok = await tcpProbe({ host, port, timeoutMs: 3000, payload: PING, expectBanner: 'PONG' });
check(
  'PING→PONG matches',
  ok.ok === true && (ok.banner ?? '').includes('PONG'),
  JSON.stringify(ok),
);

// 2. payload + non-matching expectBanner → FAILED, banner still captured
//    (anti-vacuous: a broken matcher that always-passes fails this).
const neg = await tcpProbe({ host, port, timeoutMs: 3000, payload: PING, expectBanner: 'NOPE' });
check(
  'banner mismatch FAILS but is captured',
  neg.ok === false && !!neg.errorMessage && (neg.banner ?? '').includes('PONG'),
  JSON.stringify(neg),
);

// 3. bare connect, no payload/banner → SUCCESS, no banner read
//    (backward compat — identical to pre-feature behaviour).
const bare = await tcpProbe({ host, port, timeoutMs: 3000 });
check('bare TCP unchanged (no banner)', bare.ok === true && !bare.banner, JSON.stringify(bare));

// 4. unreachable port → FAILED, never hangs (timer backstop).
const dead = await tcpProbe({ host, port: 1, timeoutMs: 2000, expectBanner: 'x' });
check('closed/again port FAILS cleanly', dead.ok === false && !!dead.errorMessage);

// 5. Multi-packet banner: server writes "220-server" then sleeps 50ms then
//    writes ".example.com ESMTP\r\n". The probe expects `ESMTP`. The old
//    behavior was to FAIL on the first chunk (no match yet) — the fix lets
//    the buffer keep filling until match OR cap OR timeout.
const splitServer: Server = await new Promise((resolve) => {
  const s = createServer((sock) => {
    sock.write('220-server');
    setTimeout(() => {
      sock.write('.example.com ESMTP\r\n');
      sock.end();
    }, 50);
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const splitPort = (splitServer.address() as { port: number }).port;
const split = await tcpProbe({
  host: '127.0.0.1',
  port: splitPort,
  timeoutMs: 3000,
  expectBanner: 'ESMTP',
});
check(
  'multi-packet banner: match survives split write',
  split.ok === true && (split.banner ?? '').includes('ESMTP'),
  JSON.stringify(split),
);
await new Promise<void>((r) => splitServer.close(() => r()));

console.log(failed ? '\ntcp-banner-test: FAILED' : '\ntcp-banner-test: all checks passed');
process.exit(failed ? 1 : 0);
