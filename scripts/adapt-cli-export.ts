// Adapts an ObserveOne SaaS `obs export` JSON into the exact payload
// `POST /api/import` consumes (see src/server.ts — camelCase keys:
// urlMonitors / apiChecks, timeoutMs, intervalSeconds, statusCode).
//
// Importable: `import { adaptSaaSExport } from './adapt-cli-export.ts'`.
// Also a CLI:  `bun scripts/adapt-cli-export.ts <input.json> <output.json>`
//
// SaaS-only resources that have no clean self-host mapping yet — suites
// (QA), heartbeats, alert_channels, status_pages, incidents — are reported
// as skipped, not silently dropped. Bringing those across is the
// full-parity follow-up, deliberately out of scope here.

export interface ImportPayload {
  version: 1;
  urlMonitors: Array<{
    name: string;
    url: string;
    timeoutMs: number;
    intervalSeconds: number;
    enabled: boolean;
    assertions: Array<{ operator: string; statusCode: number }>;
  }>;
  apiChecks: Array<{
    name: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    timeoutMs: number;
    intervalSeconds: number;
    enabled: boolean;
    assertions: Array<{ type: string; operator: string; path: string | null; value: unknown }>;
  }>;
  qaProjects: never[];
}

export interface AdaptResult {
  payload: ImportPayload;
  skipped: Record<string, number>;
}

// SaaS schedules are cron; oo-workers monitors are interval-seconds.
const cronToSeconds = (cron: string | null | undefined, fallback = 60): number => {
  if (!cron) return fallback;
  const m = cron.trim().match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return Number(m[1]) * 60;
  if (cron.trim() === '* * * * *') return 60;
  return fallback;
};

interface SaaSExport {
  monitors?: Array<Record<string, unknown>>;
  api_checks?: Array<Record<string, unknown>>;
  heartbeats?: unknown[];
  suites?: unknown[];
  alert_channels?: unknown[];
  status_pages?: unknown[];
  incidents?: unknown[];
}

export function adaptSaaSExport(src: SaaSExport): AdaptResult {
  const urlMonitors = (src.monitors ?? []).map((m) => ({
    name: m.name as string,
    url: m.url as string,
    timeoutMs: (m.timeout_ms as number) ?? 30000,
    intervalSeconds: cronToSeconds(m.interval as string),
    enabled: true,
    // SaaS HTTP monitors are uptime checks → assert 200.
    assertions: [{ operator: 'equals', statusCode: 200 }],
  }));

  const apiChecks = (src.api_checks ?? []).map((c) => ({
    name: c.name as string,
    url: c.url as string,
    method: (c.method as string) ?? 'GET',
    headers: (c.headers as Record<string, string>) ?? {},
    body: (c.body as string) ?? null,
    timeoutMs: (c.timeout_ms as number) ?? 10000,
    intervalSeconds: cronToSeconds(c.cron_expression as string),
    enabled: true,
    assertions: ((c.assertions as Array<Record<string, unknown>>) ?? []).map((a) => ({
      type: a.type as string,
      operator: a.operator as string,
      path: (a.path as string) ?? null,
      value: a.value ?? null,
    })),
  }));

  return {
    payload: { version: 1, urlMonitors, apiChecks, qaProjects: [] },
    skipped: {
      heartbeats: src.heartbeats?.length ?? 0,
      suites: src.suites?.length ?? 0,
      alert_channels: src.alert_channels?.length ?? 0,
      status_pages: src.status_pages?.length ?? 0,
      incidents: src.incidents?.length ?? 0,
    },
  };
}

if (import.meta.main) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: adapt-cli-export.ts <input.json> <output.json>');
    process.exit(1);
  }
  const { payload, skipped } = adaptSaaSExport(JSON.parse(await Bun.file(inPath).text()));
  await Bun.write(outPath, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${outPath}`);
  console.log(`  urlMonitors: ${payload.urlMonitors.length}`);
  console.log(`  apiChecks:   ${payload.apiChecks.length}`);
  console.log(
    `  skipped:     ${Object.entries(skipped)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
}
