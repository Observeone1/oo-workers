// Adapts an ObserveOne SaaS `obs export` JSON into the exact payload
// `POST /api/import` consumes (see src/server.ts — camelCase keys:
// urlMonitors / apiChecks, timeoutMs, intervalSeconds, statusCode).
//
// Importable: `import { adaptSaaSExport } from './adapt-cli-export.ts'`.
// Also a CLI:  `bun scripts/adapt-cli-export.ts <input.json> <output.json>`
//
// Mapped: monitors→urlMonitors, api_checks→apiChecks, (3.1)
// suites→qaProjects (only suites with inline `tests[]` — i.e. exported
// with `obs export --include-scripts`; scriptless ones would monitor
// nothing so they're counted in `skipped.suites`, not fabricated empty;
// SaaS suite-only fields max_tests/is_public/allow_form_submit/
// secret_keys have no self-host target and are dropped), and (3.2)
// alert_channels→channels.
//
// Channel mapping is type-narrowed and secret-safe BY CONSTRUCTION: the
// SaaS channel `config` carries secrets (Discord/Slack webhook URLs,
// Telegram `bot_token`/`chat_id`, Twilio `account_sid`/`auth_token`).
// We never copy the SaaS config object — only the single field oo-workers
// needs is read out: email→{to:config.email}, webhook/discord/slack→
// {url:config.webhook_url}. SaaS-only channel types with no oo-workers
// equivalent (teams, telegram, sms) and channels with a missing/invalid
// endpoint are counted in `skipped.alert_channels`, never half-created.
// Still skipped (no self-host target yet): heartbeats, status_pages,
// incidents.

// `id` fields throughout are CLI v1.25.0 bundle-local surrogate ids.
// They are NOT real DB ids on the target — the import handler uses them
// to resolve cross-references within the same payload (e.g. a monitor's
// `channelRefs` → the channel just created in the same call). Optional
// for back-compat with pre-1.25.0 exports (id absent → no remap, same
// behavior as before).
export interface ImportPayload {
  version: 1;
  urlMonitors: Array<{
    id?: number;
    name: string;
    url: string;
    timeoutMs: number;
    intervalSeconds: number;
    enabled: boolean;
    assertions: Array<{ operator: string; statusCode: number }>;
    // Surrogate ids referring to `channels[].id` in this same payload.
    channelRefs?: number[];
  }>;
  apiChecks: Array<{
    id?: number;
    name: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    timeoutMs: number;
    intervalSeconds: number;
    enabled: boolean;
    assertions: Array<{ type: string; operator: string; path: string | null; value: unknown }>;
    channelRefs?: number[];
  }>;
  qaProjects: Array<{
    name: string;
    targetUrl: string;
    intervalSeconds: number;
    enabled: boolean;
    tests: Array<{ name: string; script: string }>;
  }>;
  channels: Array<{
    id?: number;
    name: string;
    type: 'webhook' | 'discord' | 'slack' | 'email';
    config: Record<string, unknown>;
  }>;
  // CLI v1.25.0 status pages with bundle-local monitor refs. `type` is
  // normalized to oo-workers's enum ('api' instead of SaaS's 'api_check').
  statusPages?: Array<{
    slug: string;
    title: string;
    description: string | null;
    monitors: Array<{ ref: number; type: 'url' | 'api' }>;
  }>;
}

export interface AdaptResult {
  payload: ImportPayload;
  skipped: Record<string, number>;
  // Human-readable advisories for things that imported but won't fully
  // work without operator follow-up — NOT counted as skipped (the rows
  // ARE created). Surfaced loudly by the CLI + wrapper so a migration
  // doesn't silently half-work.
  warnings: string[];
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
  // SaaS exports the secret *names* a suite uses, never the values
  // (security — the SaaS API does not dump secret values anywhere). We
  // can't migrate values; we DO warn so the operator recreates them.
  secret_keys?: unknown;
}

// SaaS channel types: email|slack|discord|teams|telegram|sms|webhook.
// oo-workers supports only these four; the rest have no faithful target.
const SUPPORTED_CHANNEL_TYPES = ['webhook', 'discord', 'slack', 'email'] as const;
type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HTTP_RE = /^https?:\/\//i;

// Only the two non-secret fields oo-workers consumes are typed; the rest
// of the SaaS config (bot_token, account_sid, …) is intentionally never
// referenced so it cannot leak into the import payload.
interface SaaSChannel {
  name?: string;
  type?: string;
  config?: { email?: unknown; webhook_url?: unknown };
}

interface SaaSStatusPage {
  slug?: string;
  name?: string;
  description?: string | null;
  monitors?: Array<{ monitor_type?: string; monitor_id?: number; display_name?: string }>;
}

interface SaaSExport {
  monitors?: Array<Record<string, unknown>>;
  api_checks?: Array<Record<string, unknown>>;
  heartbeats?: unknown[];
  suites?: SaaSSuite[];
  alert_channels?: SaaSChannel[];
  status_pages?: SaaSStatusPage[];
  incidents?: unknown[];
}

// Read an optional numeric surrogate id. CLI v1.25.0+ emits these on
// monitors/api_checks/alert_channels; older exports don't, so missing
// is fine (just no remap will happen on import).
function readId(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// channel_ids on a monitor/api_check is `number[]` per CLI v1.25.0 spec.
// Tolerate odd shapes: drop non-numeric entries, return undefined on empty.
function readChannelRefs(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const refs = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return refs.length > 0 ? refs : undefined;
}

export function adaptSaaSExport(src: SaaSExport): AdaptResult {
  const urlMonitors: ImportPayload['urlMonitors'] = (src.monitors ?? []).map((m) => {
    const id = readId(m.id);
    const channelRefs = readChannelRefs(m.channel_ids);
    return {
      ...(id !== undefined && { id }),
      name: m.name as string,
      url: m.url as string,
      timeoutMs: (m.timeout_ms as number) ?? 30000,
      intervalSeconds: cronToSeconds(m.interval as string),
      enabled: true,
      // SaaS HTTP monitors are uptime checks → assert 200.
      assertions: [{ operator: 'equals', statusCode: 200 }],
      ...(channelRefs !== undefined && { channelRefs }),
    };
  });

  const apiChecks: ImportPayload['apiChecks'] = (src.api_checks ?? []).map((c) => {
    const id = readId(c.id);
    const channelRefs = readChannelRefs(c.channel_ids);
    return {
      ...(id !== undefined && { id }),
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
      ...(channelRefs !== undefined && { channelRefs }),
    };
  });

  // suites → qaProjects, but only suites with inline tests (see header).
  const qaProjects: ImportPayload['qaProjects'] = [];
  const warnings: string[] = [];
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
    // The suite imported, but if its tests reference secrets those will
    // be MISSING on the self-host (the SaaS export never carries secret
    // values — only names). The test will fail at runtime until the
    // operator recreates them. Warn with the names so they know which.
    const secretKeys = (Array.isArray(s.secret_keys) ? s.secret_keys : []).filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    if (secretKeys.length > 0) {
      warnings.push(
        `QA suite "${s.suite_name}" imported but uses ${secretKeys.length} secret(s) ` +
          `[${secretKeys.join(', ')}] that are NOT migrated — the SaaS export never ` +
          `includes secret values. Its tests will fail until you recreate these ` +
          `secrets on the self-host.`,
      );
    }
  }

  // alert_channels → channels. Secret-safe: only config.email /
  // config.webhook_url are ever read (see header). Unsupported types
  // (teams/telegram/sms) and missing/invalid endpoints are skipped.
  const channels: ImportPayload['channels'] = [];
  let channelsSkipped = 0;
  for (const ch of src.alert_channels ?? []) {
    const type = ch.type;
    if (!ch.name || !type || !(SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type)) {
      channelsSkipped++;
      continue;
    }
    const id = readId((ch as Record<string, unknown>).id);
    if (type === 'email') {
      const to = typeof ch.config?.email === 'string' ? ch.config.email.trim() : '';
      if (!EMAIL_RE.test(to)) {
        channelsSkipped++;
        continue;
      }
      channels.push({
        ...(id !== undefined && { id }),
        name: ch.name,
        type: 'email',
        config: { to },
      });
    } else {
      const u = typeof ch.config?.webhook_url === 'string' ? ch.config.webhook_url.trim() : '';
      if (!HTTP_RE.test(u)) {
        channelsSkipped++;
        continue;
      }
      channels.push({
        ...(id !== undefined && { id }),
        name: ch.name,
        type: type as SupportedChannelType,
        config: { url: u },
      });
    }
  }

  // status_pages → statusPages. CLI v1.25.0 emits `{ slug, name,
  // description, monitors: [{ monitor_type, monitor_id, display_name }] }`.
  // We normalize SaaS's `monitor_type: 'api_check'` → oo-workers's `'api'`
  // and use `ref` (matching channelRefs naming) for the surrogate-id pointer.
  // A status page with no resolvable monitors gets skipped (an empty SP
  // has no value); same for ones missing slug.
  const statusPages: NonNullable<ImportPayload['statusPages']> = [];
  let statusPagesSkipped = 0;
  for (const sp of src.status_pages ?? []) {
    if (!sp.slug || typeof sp.slug !== 'string') {
      statusPagesSkipped++;
      continue;
    }
    const monitors = (Array.isArray(sp.monitors) ? sp.monitors : [])
      .map((m) => {
        const ref = readId(m.monitor_id);
        const rawType = typeof m.monitor_type === 'string' ? m.monitor_type : '';
        const type: 'url' | 'api' | null =
          rawType === 'url' ? 'url' : rawType === 'api_check' || rawType === 'api' ? 'api' : null;
        if (ref === undefined || type === null) return null;
        return { ref, type };
      })
      .filter((m): m is { ref: number; type: 'url' | 'api' } => m !== null);
    if (monitors.length === 0) {
      // Either no monitors attached on SaaS, or none had a usable
      // surrogate id (pre-1.25.0 export). Either way an empty status
      // page is not useful — skip rather than create a hollow one.
      statusPagesSkipped++;
      continue;
    }
    statusPages.push({
      slug: sp.slug,
      title: typeof sp.name === 'string' ? sp.name : sp.slug,
      description: typeof sp.description === 'string' ? sp.description : null,
      monitors,
    });
  }

  // NOTE: the monitor→alert-channel "routing not migrated" advisory is
  // emitted SERVER-side by /api/import (path-independent — it must also
  // reach the UI import dialog, which never runs this adapter). Keeping
  // it in one place avoids divergent wording. This adapter's `warnings`
  // carry only SaaS-export-derived advisories (suite secrets above).

  return {
    payload: {
      version: 1,
      urlMonitors,
      apiChecks,
      qaProjects,
      channels,
      // Only emit statusPages when there's at least one — keeps the
      // payload trivially back-compatible with older /api/import builds
      // that don't know about the field.
      ...(statusPages.length > 0 && { statusPages }),
    },
    skipped: {
      heartbeats: src.heartbeats?.length ?? 0,
      // suites NOT brought across (no inline scripts / malformed) — a
      // re-export with `obs export --include-scripts` recovers them.
      suites: suitesSkipped,
      // channels NOT brought across: unsupported type (teams/telegram/
      // sms) or missing/invalid endpoint.
      alert_channels: channelsSkipped,
      // status_pages NOT brought across: missing slug, or no monitors
      // with resolvable surrogate ids (pre-1.25.0 CLI export). The
      // imported ones are in payload.statusPages.
      status_pages: statusPagesSkipped,
      incidents: src.incidents?.length ?? 0,
    },
    warnings,
  };
}

if (import.meta.main) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: adapt-cli-export.ts <input.json> <output.json>');
    process.exit(1);
  }
  const { payload, skipped, warnings } = adaptSaaSExport(JSON.parse(await Bun.file(inPath).text()));
  await Bun.write(outPath, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${outPath}`);
  console.log(`  urlMonitors: ${payload.urlMonitors.length}`);
  console.log(`  apiChecks:   ${payload.apiChecks.length}`);
  console.log(`  qaProjects:  ${payload.qaProjects.length}`);
  console.log(`  channels:    ${payload.channels.length}`);
  if (payload.statusPages && payload.statusPages.length > 0) {
    console.log(`  statusPages: ${payload.statusPages.length}`);
  }
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
  if (skipped.alert_channels > 0) {
    console.log(
      `  ⚠ ${skipped.alert_channels} alert channel(s) skipped ` +
        `(unsupported type — teams/telegram/sms — or missing/invalid endpoint).`,
    );
  }
  if (warnings.length > 0) {
    console.log('');
    console.log('  ⚠ ACTION NEEDED — imported, but won’t fully work until you act:');
    for (const w of warnings) console.log(`    • ${w}`);
  }
}
