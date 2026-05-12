// Adapts `obs export` (SaaS) JSON → oo-workers import schema.
// Usage: bun scripts/adapt-cli-export.ts <input.json> <output.json>

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: adapt-cli-export.ts <input.json> <output.json>');
  process.exit(1);
}

const cronToSeconds = (cron: string | null | undefined, fallback = 60): number => {
  if (!cron) return fallback;
  const m = cron.trim().match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return Number(m[1]) * 60;
  if (cron.trim() === '* * * * *') return 60;
  return fallback;
};

const src = JSON.parse(await Bun.file(inPath).text());

const url_monitors = (src.monitors ?? []).map((m: any) => ({
  name: m.name,
  url: m.url,
  timeout_ms: m.timeout_ms ?? 30000,
  interval_seconds: cronToSeconds(m.interval),
  enabled: true,
  assertions: [{ operator: 'equals', status_code: 200 }],
}));

const api_checks = (src.api_checks ?? []).map((c: any) => ({
  name: c.name,
  url: c.url,
  method: c.method ?? 'GET',
  headers: c.headers ?? {},
  body: c.body ?? null,
  timeout_ms: c.timeout_ms ?? 10000,
  interval_seconds: cronToSeconds(c.cron_expression),
  enabled: true,
  assertions: (c.assertions ?? []).map((a: any) => ({
    type: a.type,
    operator: a.operator,
    value: a.value,
    path: a.path ?? null,
  })),
}));

const out = { version: 1, url_monitors, api_checks, qa_projects: [] };

await Bun.write(outPath, JSON.stringify(out, null, 2));

console.log(`✓ wrote ${outPath}`);
console.log(`  url_monitors: ${url_monitors.length}`);
console.log(`  api_checks:   ${api_checks.length}`);
console.log(`  skipped:      heartbeats=${src.heartbeats?.length ?? 0}, suites=${src.suites?.length ?? 0}, alert_channels=${src.alert_channels?.length ?? 0}, status_pages=${src.status_pages?.length ?? 0}, incidents=${src.incidents?.length ?? 0}`);
