import type { adaptSaaSExport } from './adapt-cli-export.ts';

type ImportPayload = ReturnType<typeof adaptSaaSExport>['payload'];

function logAdaptSummary(
  payload: ImportPayload,
  skipped: Record<string, number>,
  warnings: string[],
): void {
  console.log(
    `adapted: urlMonitors=${payload.urlMonitors.length} apiChecks=${payload.apiChecks.length} qaProjects=${payload.qaProjects.length} channels=${payload.channels.length}`,
  );
  const notTransferred = Object.entries(skipped).filter(([, n]) => n > 0);
  if (notTransferred.length) {
    console.log(
      `not brought across (unsupported, invalid, or no self-host import yet): ${notTransferred
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')}`,
    );
  }
  if (warnings.length) {
    console.log('\n⚠ ACTION NEEDED — these imported but will NOT fully work yet:');
    for (const w of warnings) console.log(`  • ${w}`);
    console.log('');
  }
}

function findImportNameCollisions(
  payload: ImportPayload,
  existing: Record<string, Array<{ name: string }>>,
  existingChannels: Array<{ name: string }>,
): string[] {
  const have = new Set([
    ...(existing.url ?? []).map((m) => `url:${m.name}`),
    ...(existing.api ?? []).map((m) => `api:${m.name}`),
    ...(existing.heartbeat ?? []).map((m) => `heartbeat:${m.name}`),
    ...existingChannels.map((ch) => `channel:${ch.name}`),
  ]);
  return [
    ...payload.urlMonitors.filter((m) => have.has(`url:${m.name}`)).map((m) => `url ${m.name}`),
    ...payload.apiChecks.filter((m) => have.has(`api:${m.name}`)).map((m) => `api ${m.name}`),
    ...(payload.heartbeats ?? [])
      .filter((h) => have.has(`heartbeat:${h.name}`))
      .map((h) => `heartbeat ${h.name}`),
    ...payload.channels
      .filter((ch) => have.has(`channel:${ch.name}`))
      .map((ch) => `channel ${ch.name}`),
  ];
}

async function ensureNoNameCollisions(
  url: string,
  key: string,
  payload: ImportPayload,
  allowDuplicates: boolean,
): Promise<void> {
  const [listRes, chRes] = await Promise.all([
    fetch(`${url}/api/monitors`, { headers: { authorization: `Bearer ${key}` } }),
    fetch(`${url}/api/channels`, { headers: { authorization: `Bearer ${key}` } }),
  ]);
  if (!listRes.ok) return;

  const existing = (await listRes.json()) as Record<string, Array<{ name: string }>>;
  const existingChannels = chRes.ok ? ((await chRes.json()) as Array<{ name: string }>) : [];
  const collisions = findImportNameCollisions(payload, existing, existingChannels);
  if (collisions.length === 0) return;

  if (!allowDuplicates) {
    console.error(
      `\n⚠ ${collisions.length} name(s) already exist on the target. /api/import is not ` +
        `idempotent and has no unique-name constraint — posting these would create ` +
        `DUPLICATES, not update or skip them:`,
    );
    for (const c of collisions) console.error(`  - ${c}`);
    console.error('\nTreat import as a one-time seed. Re-run with --allow-duplicates to override.');
    process.exit(1);
  }
  console.warn(`⚠ proceeding with ${collisions.length} duplicate name(s) (--allow-duplicates).`);
}

async function postImportPayload(url: string, key: string, payload: ImportPayload): Promise<void> {
  const res = await fetch(`${url}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`POST ${url}/api/import → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const result = (await res.json()) as {
    url: number;
    api: number;
    qa: number;
    tcp: number;
    udp: number;
    heartbeat?: number;
    channels: number;
    skipped?: string[];
    warnings?: string[];
  };
  console.log(
    `imported: url=${result.url} api=${result.api} qa=${result.qa} heartbeat=${result.heartbeat ?? 0} channels=${result.channels}`,
  );
  for (const w of result.warnings ?? []) console.log(`  • ${w}`);
  const errored = result.skipped ?? [];
  if (errored.length) {
    console.warn(`\n⚠ ${errored.length} item(s) the server could not create:`);
    for (const s of errored) console.warn(`  - ${s}`);
    process.exit(1);
  }
  console.log('✓ done.');
}

export { logAdaptSummary, ensureNoNameCollisions, postImportPayload };
