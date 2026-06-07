/**
 * Pure gating test for the TLS cert-expiry probe.
 * Ported from scripts/tls-cert-test.ts.
 * No DB, no Redis. Requires openssl (skips loudly if absent).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TlsOptions } from 'node:tls';
import { tlsProbe } from '../../src/services/tls-probe.ts';

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !haveOpenssl();
let dir = '';

function genCert(tag: string, days: number, opts: { cn?: string; sans?: string[] } = {}): TlsOptions {
  const key = join(dir, `${tag}.key`);
  const crt = join(dir, `${tag}.crt`);
  const cn = opts.cn ?? `oo-tls-${tag}`;
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt, '-days', String(days), '-nodes', '-subj', `/CN=${cn}`];
  if (opts.sans?.length) args.push('-addext', `subjectAltName=${opts.sans.map((s) => `DNS:${s}`).join(',')}`);
  execFileSync('openssl', args, { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

function serve(opts: TlsOptions): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const s = createServer(opts, (sock) => sock.end());
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') resolve({ port: addr.port, close: () => s.close() });
      else reject(new Error('no address'));
    });
  });
}

beforeAll(() => {
  if (!SKIP) dir = mkdtempSync(join(tmpdir(), 'oo-tls-it-'));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(SKIP)('tls-cert probe', () => {
  test('far-future cert → SUCCESS, cert parsed', async () => {
    const srv = await serve(genCert('long', 825));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30 });
    srv.close();
    expect(r.ok).toBe(true);
    expect(r.daysRemaining).toBeGreaterThan(700);
    expect(r.certSummary).toContain('CN=oo-tls-long');
  });

  test('in-window cert FAILS but is parsed', async () => {

    const srv = await serve(genCert('short', 2));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30 });
    srv.close();
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect((r.daysRemaining ?? 99) <= 30).toBe(true);
    expect(r.certSummary).toContain('CN=oo-tls-short');
  });

  test('warnDays=0 tolerates the 2-day cert', async () => {

    const srv = await serve(genCert('short2', 2));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 0 });
    srv.close();
    expect(r.ok).toBe(true);
    expect((r.daysRemaining ?? -1) >= 0).toBe(true);
  });

  test('closed port FAILS cleanly (no hang)', async () => {

    const r = await tlsProbe({ host: '127.0.0.1', port: 1, timeoutMs: 2000, warnDays: 30 });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect(r.daysRemaining).toBeUndefined();
  });

  test('verify_chain OFF + self-signed → SUCCESS (no-regression)', async () => {

    const srv = await serve(genCert('vc', 825));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, verifyChain: false, verifyHostname: false });
    srv.close();
    expect(r.ok).toBe(true);
  });

  test('verify_chain ON + self-signed → FAIL', async () => {

    const srv = await serve(genCert('vc2', 825));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, verifyChain: true });
    srv.close();
    expect(r.ok).toBe(false);
    expect(/chain not trusted/i.test(r.errorMessage ?? '')).toBe(true);
  });

  test('verify_hostname ON + matching SAN → SUCCESS', async () => {

    const srv = await serve(genCert('vh', 825, { cn: 'oo-cn', sans: ['match.oo.test'] }));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, servername: 'match.oo.test', verifyHostname: true });
    srv.close();
    expect(r.ok).toBe(true);
  });

  test('verify_hostname ON + non-matching SNI → FAIL', async () => {

    const srv = await serve(genCert('vh2', 825, { cn: 'oo-cn', sans: ['match.oo.test'] }));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, servername: 'other.oo.test', verifyHostname: true });
    srv.close();
    expect(r.ok).toBe(false);
    expect(/not valid for other\.oo\.test/i.test(r.errorMessage ?? '')).toBe(true);
  });

  test('expect_cn_regex matching CN → SUCCESS', async () => {

    const srv = await serve(genCert('cn', 825, { cn: 'svc.prod.oo', sans: ['api.prod.oo'] }));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, expectCnRegex: '^svc\\.prod\\.oo$' });
    srv.close();
    expect(r.ok).toBe(true);
  });

  test('expect_cn_regex no match → FAIL', async () => {

    const srv = await serve(genCert('cn2', 825, { cn: 'svc.prod.oo', sans: ['api.prod.oo'] }));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, expectCnRegex: '^nope\\.' });
    srv.close();
    expect(r.ok).toBe(false);
    expect(/No CN\/SAN matches/i.test(r.errorMessage ?? '')).toBe(true);
  });

  test('expect_cn_regex matches a DNS SAN (not CN) → SUCCESS', async () => {

    const srv = await serve(genCert('cn3', 825, { cn: 'svc.prod.oo', sans: ['api.prod.oo'] }));
    const r = await tlsProbe({ host: '127.0.0.1', port: srv.port, timeoutMs: 4000, warnDays: 30, expectCnRegex: '^api\\.prod\\.oo$' });
    srv.close();
    expect(r.ok).toBe(true);
  });
});
