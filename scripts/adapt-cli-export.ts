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
// Still skipped (no self-host target yet): incidents.

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
  // CLI v1.26.0 heartbeats. `token` here is the SaaS `ping_key`, carried
  // across so existing services keep pinging the same public URL after
  // migration. periodSeconds/graceSeconds are oo-workers's field names
  // (CLI uses `period`/`grace_period`, both in seconds).
  heartbeats?: Array<{
    name: string;
    description?: string | null;
    periodSeconds: number;
    graceSeconds: number;
    token?: string;
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

import {
  adaptAlertChannels,
  adaptApiChecks,
  adaptHeartbeats,
  adaptQaSuites,
  adaptStatusPages,
  adaptUrlMonitors,
} from './adapt-cli-export-sections.ts';

interface SaaSExport {
  monitors?: Array<Record<string, unknown>>;
  api_checks?: Array<Record<string, unknown>>;
  heartbeats?: unknown[];
  suites?: Array<Record<string, unknown>>;
  alert_channels?: Array<Record<string, unknown>>;
  status_pages?: Array<Record<string, unknown>>;
  incidents?: unknown[];
}

export function adaptSaaSExport(src: SaaSExport): AdaptResult {
  const urlMonitors = adaptUrlMonitors(src);
  const apiChecks = adaptApiChecks(src);
  const { qaProjects, warnings: suiteWarnings, suitesSkipped } = adaptQaSuites(src);
  const { channels, channelsSkipped } = adaptAlertChannels(src);
  const { statusPages, statusPagesSkipped } = adaptStatusPages(src);
  const { heartbeats, warnings: hbWarnings } = adaptHeartbeats(src);
  const warnings = [...suiteWarnings, ...hbWarnings];

  return {
    payload: {
      version: 1,
      urlMonitors,
      apiChecks,
      qaProjects,
      channels,
      ...(statusPages.length > 0 && { statusPages }),
      ...(heartbeats.length > 0 && { heartbeats }),
    },
    skipped: {
      heartbeats_malformed: (src.heartbeats?.length ?? 0) - heartbeats.length,
      suites: suitesSkipped,
      alert_channels: channelsSkipped,
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
