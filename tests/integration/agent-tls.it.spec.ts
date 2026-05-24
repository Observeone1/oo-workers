/**
 * Pure gating test for OO_AGENT_TLS_INSECURE.
 * Ported from scripts/agent-tls-test.ts.
 * No DB, no Redis. Requires openssl (skips loudly if absent).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import { pollJob } from '../../src/agent.ts';

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
let server: Server | null = null;
let masterUrl = '';
let cfg: { masterUrl: string; agentKey: string; regionSlug: string; pollWaitSec: number };

beforeAll(async () => {
  if (SKIP) return;
  dir = mkdtempSync(join(tmpdir(), 'oo-agent-tls-it-'));
  const key = join(dir, 'k');
  const crt = join(dir, 'c');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt, '-days', '2', '-nodes', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  server = createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
    if (req.url?.startsWith('/api/agent/jobs')) res.writeHead(204).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no server address');
  masterUrl = `https://127.0.0.1:${addr.port}`;
  cfg = { masterUrl, agentKey: 'oo_test', regionSlug: 'test', pollWaitSec: 1 };
});

afterAll(() => {
  if (server) server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('agent-tls', () => {
  test('tlsInsecure=false + self-signed master → REJECTED', async () => {
    if (SKIP) {
      console.warn('SKIP: openssl not found');
      return;
    }
    let threw = false;
    try {
      await pollJob({ ...cfg, tlsInsecure: false });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('tlsInsecure=true + self-signed master → SUCCEEDS (204 → null)', async () => {
    if (SKIP) {
      console.warn('SKIP: openssl not found');
      return;
    }
    let result: unknown = 'unset';
    let err = '';
    try {
      result = await pollJob({ ...cfg, tlsInsecure: true });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).toBe('');
    expect(result).toBeNull();
  });
});
