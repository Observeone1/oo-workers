#!/usr/bin/env bun
/**
 * Agent preflight — validates that an agent box can reach the master
 * with the configured key + region slug before the agent goes live.
 *
 * Reports each step (URL parse, DNS, TCP/TLS, auth, region binding)
 * with a clear ✅ / ❌ and an actionable hint on failure. Exits non-zero
 * on the first failure so it composes with shell pipelines:
 *
 *   docker compose -f docker-compose.agent.yml exec agent \
 *     bun scripts/check-agent-connectivity.ts && \
 *     docker compose -f docker-compose.agent.yml up -d agent
 *
 * Reads the same env vars the agent runtime reads (OO_MASTER_URL,
 * OO_AGENT_KEY, OO_REGION_SLUG) so it works against a `.env` without
 * re-typing values. Flags override env if supplied.
 *
 * Usage:
 *   bun scripts/check-agent-connectivity.ts
 *   bun scripts/check-agent-connectivity.ts --master-url https://master.example.com \
 *     --agent-key oo_... --region-slug us-east
 */

interface Args {
  masterUrl: string;
  agentKey: string;
  regionSlug: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let masterUrl = process.env.OO_MASTER_URL ?? '';
  let agentKey = process.env.OO_AGENT_KEY ?? '';
  let regionSlug = process.env.OO_REGION_SLUG ?? '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--master-url') masterUrl = argv[++i] ?? '';
    else if (arg === '--agent-key') agentKey = argv[++i] ?? '';
    else if (arg === '--region-slug') regionSlug = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun scripts/check-agent-connectivity.ts ' +
          '[--master-url URL] [--agent-key KEY] [--region-slug SLUG]\n\n' +
          'Reads OO_MASTER_URL, OO_AGENT_KEY, OO_REGION_SLUG from env when flags omitted.',
      );
      process.exit(0);
    }
  }
  return { masterUrl, agentKey, regionSlug };
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string, hint?: string): never {
  console.log(`  ❌ ${msg}`);
  if (hint) console.log(`     ${hint}`);
  process.exit(1);
}

async function main() {
  const { masterUrl, agentKey, regionSlug } = parseArgs();
  console.log('oo-workers agent preflight\n');

  console.log('1. config');
  if (!masterUrl)
    fail('OO_MASTER_URL is not set', 'export OO_MASTER_URL=https://master.example.com');
  if (!agentKey)
    fail('OO_AGENT_KEY is not set', 'paste the cleartext key returned from create-region');
  if (!regionSlug)
    fail(
      'OO_REGION_SLUG is not set',
      'set to the slug used when the region was created (e.g. us-east)',
    );
  ok(`master ${masterUrl}, region '${regionSlug}', key ${agentKey.slice(0, 11)}…`);

  console.log('\n2. URL');
  let parsed: URL;
  try {
    parsed = new URL(masterUrl);
  } catch {
    fail(
      `OO_MASTER_URL is not a valid URL: ${masterUrl}`,
      'expected https://host[:port] or http://host[:port]',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`unsupported protocol ${parsed.protocol}`, 'use http:// or https://');
  }
  ok(`${parsed.protocol}//${parsed.host}`);

  console.log('\n3. reachability');
  const meUrl = new URL('/api/agent/me', masterUrl).toString();
  let res: Response;
  try {
    res = await fetch(meUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentKey}`, Connection: 'close' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/self.signed|unable to verify|UNABLE_TO_VERIFY|CERT/i.test(msg)) {
      fail(
        `TLS handshake failed: ${msg}`,
        "self-signed certs aren't supported. Use a real cert (Let's Encrypt) or a private CA installed system-wide.",
      );
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      fail(
        `DNS lookup failed: ${msg}`,
        `cannot resolve ${parsed.hostname}. Check /etc/resolv.conf or the URL.`,
      );
    }
    if (/ECONNREFUSED/i.test(msg)) {
      fail(
        `connection refused: ${msg}`,
        `master not reachable at ${parsed.host}. Is it running? Is OO_BIND_ADDR=0.0.0.0?`,
      );
    }
    if (/timeout/i.test(msg)) {
      fail(
        `connection timed out: ${msg}`,
        `${parsed.host} is unreachable from this box. Check firewall / VPN.`,
      );
    }
    fail(`network error: ${msg}`);
  }
  ok(`HTTP ${res.status} from ${meUrl}`);

  console.log('\n4. auth');
  if (res.status === 401) {
    fail(
      'agent key was rejected (401)',
      'the key was revoked or mis-pasted. Rotate it from the Regions page or run rotate-region-key.ts.',
    );
  }
  if (res.status === 403) {
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      /* ignore */
    }
    fail(
      `agent key was rejected (403): ${body.error ?? ''}`,
      "the key exists but lacks 'agent' scope or is unbound.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(`unexpected ${res.status} from /api/agent/me`, text.slice(0, 200));
  }
  ok('key accepted, agent scope confirmed');

  console.log('\n5. region binding');
  const body = (await res.json()) as { region?: { id: number; slug: string; label: string } };
  const bound = body.region;
  if (!bound) {
    fail(
      'master returned no region for this key',
      'unexpected — re-create the region via the Regions page.',
    );
  }
  if (bound.slug !== regionSlug) {
    fail(
      `region slug mismatch: master says '${bound.slug}', OO_REGION_SLUG='${regionSlug}'`,
      'the key is bound to a different region than OO_REGION_SLUG. Master routes by key, so jobs would still flow, but the mismatched env hints at a copy-paste mistake. Update OO_REGION_SLUG to match the bound slug.',
    );
  }
  ok(`bound to region #${bound.id} '${bound.slug}' (${bound.label})`);

  console.log('\nall green — agent is ready to start.');
}

main().catch((err) => {
  console.error('\npreflight crashed:', err);
  process.exit(1);
});
