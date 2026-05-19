#!/usr/bin/env bun
/**
 * Gating regression test for the TLS cert-expiry probe. Pure — no DB, no
 * HTTP server, no network egress. Stands a throwaway `tls.createServer`
 * on an ephemeral 127.0.0.1 port with an openssl-generated self-signed
 * cert and probes it via tlsProbe directly.
 *
 * Deterministic by construction: a far-future cert must pass, a cert
 * inside `warnDays` must FAIL (anti-vacuous — a stuck-SUCCESS probe fails
 * that check), and a closed port must FAIL cleanly without hanging. The
 * 127.0.0.1 target also exercises the isIP-SNI guard (the db-tls
 * ship-blocker: tls.connect({servername:<ip>}) throws synchronously).
 *
 * openssl is the only external tool — universally present on the CI
 * ubuntu runner and the local stack. If it is genuinely absent the test
 * prints a loud SKIP and exits 0 (same visible-skip posture as
 * backup-restore-test's CREATE DATABASE guard — never a false green by
 * silently passing a real check).
 *
 * Run standalone: `bun scripts/tls-cert-test.ts`
 * Also a stage in scripts/run-integration.sh (pre-push + CI).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TlsOptions } from 'node:tls';
import { readFileSync } from 'node:fs';
import { tlsProbe } from '../src/services/tls-probe.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!haveOpenssl()) {
  console.warn(
    '\n⚠️  tls-cert-test: openssl not found — SKIPPING (no false green; ' +
      'install openssl to run this gate). Exit 0.\n',
  );
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'oo-tls-test-'));

/**
 * openssl-generate a self-signed cert valid `days` from now. `cn`
 * defaults to `oo-tls-<tag>`; `sans` adds DNS subjectAltName entries
 * (needed to exercise verify_hostname and the CN-or-SAN regex).
 */
function genCert(
  tag: string,
  days: number,
  certOpts: { cn?: string; sans?: string[] } = {},
): TlsOptions {
  const key = join(dir, `${tag}.key`);
  const crt = join(dir, `${tag}.crt`);
  const cn = certOpts.cn ?? `oo-tls-${tag}`;
  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    key,
    '-out',
    crt,
    '-days',
    String(days),
    '-nodes',
    '-subj',
    `/CN=${cn}`,
  ];
  if (certOpts.sans && certOpts.sans.length > 0) {
    args.push('-addext', `subjectAltName=${certOpts.sans.map((s) => `DNS:${s}`).join(',')}`);
  }
  execFileSync('openssl', args, { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

/** Stand a TLS server on an ephemeral 127.0.0.1 port; returns {port,close}. */
function serve(opts: TlsOptions): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer(opts, (s) => s.end());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ port: addr.port, close: () => server.close() });
      } else {
        reject(new Error('no server address'));
      }
    });
  });
}

try {
  // 1. Far-future cert, warnDays 30 → SUCCESS, cert parsed.
  const longCert = genCert('long', 825);
  const longSrv = await serve(longCert);
  const good = await tlsProbe({
    host: '127.0.0.1',
    port: longSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
  });
  longSrv.close();
  check(
    'far-future cert → SUCCESS',
    good.ok === true &&
      (good.daysRemaining ?? 0) > 700 &&
      !!good.validTo &&
      (good.certSummary ?? '').includes('CN=oo-tls-long'),
    JSON.stringify({ ok: good.ok, daysRemaining: good.daysRemaining, sum: good.certSummary }),
  );

  // 2. Cert inside warnDays → FAILED, but still parsed (anti-vacuous: a
  //    stuck-SUCCESS or no-op expiry check fails exactly here).
  const shortCert = genCert('short', 2);
  const shortSrv = await serve(shortCert);
  const soon = await tlsProbe({
    host: '127.0.0.1',
    port: shortSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
  });
  shortSrv.close();
  check(
    'in-window cert FAILS but is parsed',
    soon.ok === false &&
      !!soon.errorMessage &&
      (soon.daysRemaining ?? 99) <= 30 &&
      (soon.certSummary ?? '').includes('CN=oo-tls-short'),
    JSON.stringify({ ok: soon.ok, daysRemaining: soon.daysRemaining, err: soon.errorMessage }),
  );

  // 3. Same short cert but warnDays 0 → SUCCESS (proves the threshold is
  //    the knob, not a constant — a hard-coded FAIL would break here).
  const shortSrv2 = await serve(shortCert);
  const lenient = await tlsProbe({
    host: '127.0.0.1',
    port: shortSrv2.port,
    timeoutMs: 4000,
    warnDays: 0,
  });
  shortSrv2.close();
  check(
    'warnDays=0 tolerates the 2-day cert (threshold is the knob)',
    lenient.ok === true && (lenient.daysRemaining ?? -1) >= 0,
    JSON.stringify({ ok: lenient.ok, daysRemaining: lenient.daysRemaining }),
  );

  // 4. Closed port → FAILED cleanly, never hangs (timer/error backstop).
  const dead = await tlsProbe({ host: '127.0.0.1', port: 1, timeoutMs: 2000, warnDays: 30 });
  check(
    'closed port FAILS cleanly (no hang)',
    dead.ok === false && !!dead.errorMessage && dead.daysRemaining === undefined,
    JSON.stringify({ ok: dead.ok, err: dead.errorMessage }),
  );

  // ---- 0018 opt-in assertions (anti-vacuous matrix) ----
  // The same self-signed far-future cert drives 5 & 6: off→PASS proves
  // the legacy posture is byte-identical; on→FAIL proves the new check
  // bites. (verify_chain ON + a *publicly-trusted* cert → PASS is an
  // inherently online property — it cannot be minted offline, so it is
  // asserted by the MANUAL e2e against a real host, NOT this pure gate.
  // Stated, not pretended.)
  const farSelf = genCert('vc', 825);

  const vcOffSrv = await serve(farSelf);
  const vcOff = await tlsProbe({
    host: '127.0.0.1',
    port: vcOffSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    verifyChain: false,
    verifyHostname: false,
  });
  vcOffSrv.close();
  check(
    'verify_chain OFF + self-signed → SUCCESS (NO-REGRESSION — the critical one)',
    vcOff.ok === true,
    JSON.stringify({ ok: vcOff.ok, err: vcOff.errorMessage }),
  );

  const vcOnSrv = await serve(farSelf);
  const vcOn = await tlsProbe({
    host: '127.0.0.1',
    port: vcOnSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    verifyChain: true,
  });
  vcOnSrv.close();
  check(
    'verify_chain ON + self-signed → FAIL (the new check bites)',
    vcOn.ok === false && /chain not trusted/i.test(vcOn.errorMessage ?? ''),
    JSON.stringify({ ok: vcOn.ok, err: vcOn.errorMessage }),
  );

  // verify_hostname — isolate by leaving verify_chain OFF; cert SAN
  // controls the match. SNI (servername) is the identity asserted.
  const hostCert = genCert('vh', 825, { cn: 'oo-cn', sans: ['match.oo.test'] });

  const vhOkSrv = await serve(hostCert);
  const vhOk = await tlsProbe({
    host: '127.0.0.1',
    port: vhOkSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    servername: 'match.oo.test',
    verifyHostname: true,
  });
  vhOkSrv.close();
  check(
    'verify_hostname ON + SNI matches cert SAN → SUCCESS',
    vhOk.ok === true,
    JSON.stringify({ ok: vhOk.ok, err: vhOk.errorMessage }),
  );

  const vhBadSrv = await serve(hostCert);
  const vhBad = await tlsProbe({
    host: '127.0.0.1',
    port: vhBadSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    servername: 'other.oo.test',
    verifyHostname: true,
  });
  vhBadSrv.close();
  check(
    'verify_hostname ON + SNI does NOT match → FAIL',
    vhBad.ok === false && /not valid for other\.oo\.test/i.test(vhBad.errorMessage ?? ''),
    JSON.stringify({ ok: vhBad.ok, err: vhBad.errorMessage }),
  );

  // expect_cn_regex — match on CN, reject on no-match, AND match via a
  // DNS SAN when the CN itself doesn't (proves SAN coverage).
  const cnCert = genCert('cn', 825, { cn: 'svc.prod.oo', sans: ['api.prod.oo'] });

  const cnOkSrv = await serve(cnCert);
  const cnOk = await tlsProbe({
    host: '127.0.0.1',
    port: cnOkSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    expectCnRegex: '^svc\\.prod\\.oo$',
  });
  cnOkSrv.close();
  check(
    'expect_cn_regex matching CN → SUCCESS',
    cnOk.ok === true,
    JSON.stringify({ ok: cnOk.ok, err: cnOk.errorMessage }),
  );

  const cnBadSrv = await serve(cnCert);
  const cnBad = await tlsProbe({
    host: '127.0.0.1',
    port: cnBadSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    expectCnRegex: '^nope\\.',
  });
  cnBadSrv.close();
  check(
    'expect_cn_regex no match → FAIL',
    cnBad.ok === false && /No CN\/SAN matches/i.test(cnBad.errorMessage ?? ''),
    JSON.stringify({ ok: cnBad.ok, err: cnBad.errorMessage }),
  );

  const cnSanSrv = await serve(cnCert);
  const cnSan = await tlsProbe({
    host: '127.0.0.1',
    port: cnSanSrv.port,
    timeoutMs: 4000,
    warnDays: 30,
    expectCnRegex: '^api\\.prod\\.oo$', // matches the SAN, not the CN
  });
  cnSanSrv.close();
  check(
    'expect_cn_regex matches a DNS SAN (not the CN) → SUCCESS (SAN coverage)',
    cnSan.ok === true,
    JSON.stringify({ ok: cnSan.ok, err: cnSan.errorMessage }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? '\ntls-cert-test: FAILED' : '\ntls-cert-test: all checks passed');
process.exit(failed ? 1 : 0);
