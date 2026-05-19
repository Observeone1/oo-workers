#!/usr/bin/env bun
/**
 * Gating test for OO_AGENT_TLS_INSECURE (v1.15.0). Pure — no DB, no
 * Redis. Stands a throwaway self-signed HTTPS "master" that answers the
 * agent long-poll, and drives the REAL agent `pollJob` against it.
 *
 * The whole correctness story of the flag is: the per-request
 * `tls:{rejectUnauthorized:false}` is applied to the agent→master
 * fetch ONLY when tlsInsecure is set. So, against a self-signed master:
 *
 *   tlsInsecure=false → pollJob MUST throw (cert rejected)
 *   tlsInsecure=true  → pollJob MUST succeed (204 → null)
 *
 * Anti-vacuous by construction: if the flag did nothing, the off-case
 * would pass (false green) — the off→throw assertion catches that. If
 * it were always-on (global bypass), the off-case wouldn't throw —
 * same assertion catches that too.
 *
 * openssl is the only external tool; absent → loud SKIP, exit 0 (same
 * visible-skip posture as tls-cert-test). Run: `bun run test:agent-tls`.
 * Also a stage in scripts/run-integration.sh.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { pollJob } from '../src/agent.ts';

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
  console.warn('\n⚠️  agent-tls-test: openssl not found — SKIPPING (no false green). Exit 0.\n');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'oo-agent-tls-'));
try {
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

  // Self-signed HTTPS "master": 204 = no job (the long-poll idle path).
  const server = createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
    if (req.url?.startsWith('/api/agent/jobs')) res.writeHead(204).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no server address');
  const cfg = {
    masterUrl: `https://127.0.0.1:${addr.port}`,
    agentKey: 'oo_test',
    regionSlug: 'test',
    pollWaitSec: 1,
  };

  // tlsInsecure=false → the self-signed cert MUST be rejected.
  let offThrew = false;
  let offErr = '';
  try {
    await pollJob({ ...cfg, tlsInsecure: false });
  } catch (e) {
    offThrew = true;
    offErr = e instanceof Error ? e.message : String(e);
  }
  check(
    'tlsInsecure=false + self-signed master → REJECTED (the gate bites)',
    offThrew,
    offThrew ? offErr.slice(0, 80) : 'pollJob did NOT throw — cert verification is not happening!',
  );

  // tlsInsecure=true → the same cert MUST now be accepted (204 → null).
  let onResult: unknown = 'unset';
  let onErr = '';
  try {
    onResult = await pollJob({ ...cfg, tlsInsecure: true });
  } catch (e) {
    onErr = e instanceof Error ? e.message : String(e);
  }
  check(
    'tlsInsecure=true + same self-signed master → SUCCEEDS (204 → null)',
    onResult === null && onErr === '',
    onErr ? `unexpected throw: ${onErr.slice(0, 80)}` : `result=${JSON.stringify(onResult)}`,
  );

  server.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? '\nagent-tls-test: FAILED' : '\nagent-tls-test: all checks passed');
process.exit(failed ? 1 : 0);
