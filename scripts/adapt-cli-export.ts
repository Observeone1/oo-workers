// Adapts an ObserveOne SaaS `obs export` JSON into the exact payload
// `POST /api/import` consumes (see src/server.ts — camelCase keys:
// urlMonitors / apiChecks, timeoutMs, intervalSeconds, statusCode).
//
// Importable: `import { adaptSaaSExport } from './adapt-cli-export.ts'`.
// Also a CLI:  `bun scripts/adapt-cli-export.ts <input.json> <output.json>`
//
// Mapped: monitors→urlMonitors, api_checks→apiChecks, and (3.1)
// suites→qaProjects — but ONLY suites that carry inline `tests[]`
// (i.e. the export was run with `obs export --include-scripts`). A
// suite with no scripts would import as a QA project that monitors
// nothing; rather than create that silent footgun it is reported in
// `skipped.suites` so the operator knows to re-export with scripts.
// SaaS suite fields with no oo-workers equivalent (max_tests,
// is_public, allow_form_submit, secret_keys) are intentionally not
// carried. Still skipped (no self-host target yet): heartbeats,
// alert_channels, status_pages, incidents.

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
  qaProjects: Array<{
    name: string;
    targetUrl: string;
    intervalSeconds: number;
    enabled: boolean;
    tests: Array<{ name: string; script: string }>;
  }>;
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

// Mirrors DEFAULTS.QA_INTERVAL_SECONDS (src/constants.ts). QA runs are
// heavy — an unparseable/missing suite cron must fall back to the QA
// default, NOT the 60s url/api default (would force tight QA polls).
const QA_DEFAULT_INTERVAL_S = 300;

interface SaaSSuite {
  suite_name?: string;
  target_url?: string;
  cron_expression?: string;
  schedule_active?: boolean;
  tests?: Array<{ name?: unknown; script?: unknown }>;
}

interface SaaSExport {
  monitors?: Array<Record<string, unknown>>;
  api_checks?: Array<Record<string, unknown>>;
  heartbeats?: unknown[];
  suites?: SaaSSuite[];
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

  // suites → qaProjects, but only suites with inline tests (see header).
  const qaProjects: ImportPayload['qaProjects'] = [];
  let suitesSkipped = 0;
  for (const s of src.suites ?? []) {
    const tests = (Array.isArray(s.tests) ? s.tests : [])
      .filter((t) => t && typeof t.name === 'string' && typeof t.script === 'string')
      .map((t) => ({ name: t.name as string, script: t.script as string }));
    // No suite_name / target_url / no inline scripts → would be an empty
    // QA project that monitors nothing; skip + count, don't fabricate.
    if (!s.suite_name || !s.target_url || tests.length === 0) {
      suitesSkipped++;
      continue;
    }
    qaProjects.push({
      name: s.suite_name,
      targetUrl: s.target_url,
      intervalSeconds: cronToSeconds(s.cron_expression, QA_DEFAULT_INTERVAL_S),
      enabled: s.schedule_active ?? true,
      tests,
    });
  }

  return {
    payload: { version: 1, urlMonitors, apiChecks, qaProjects },
    skipped: {
      heartbeats: src.heartbeats?.length ?? 0,
      // suites NOT brought across (no inline scripts / malformed) — a
      // re-export with `obs export --include-scripts` recovers them.
      suites: suitesSkipped,
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
  console.log(`  qaProjects:  ${payload.qaProjects.length}`);
  console.log(
    `  skipped:     ${Object.entries(skipped)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  if (skipped.suites > 0) {
    console.log(
      `  ⚠ ${skipped.suites} QA suite(s) skipped (no inline scripts). ` +
        `Re-run the SaaS export with \`obs export --include-scripts\` to bring them across.`,
    );
  }
}
