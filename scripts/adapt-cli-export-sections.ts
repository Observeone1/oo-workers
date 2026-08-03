import type { ImportPayload } from './adapt-cli-export.ts';

export const cronToSeconds = (cron: string | null | undefined, fallback = 60): number => {
  if (!cron) return fallback;
  const m = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (m) return Number(m[1]) * 60;
  if (cron.trim() === '* * * * *') return 60;
  return fallback;
};

export const QA_DEFAULT_INTERVAL_S = 300;

const SUPPORTED_CHANNEL_TYPES = ['webhook', 'discord', 'slack', 'email'] as const;
type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HTTP_RE = /^https?:\/\//i;

interface SaaSSuite {
  suite_name?: string;
  target_url?: string;
  cron_expression?: string;
  schedule_active?: boolean;
  tests?: Array<{ name?: unknown; script?: unknown }>;
  secret_keys?: unknown;
}

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

export function readId(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function readChannelRefs(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const refs = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return refs.length > 0 ? refs : undefined;
}

export function readEnabled(src: Record<string, unknown>): boolean {
  if (src.enabled === false) return false;
  if (src.is_paused === true) return false;
  return true;
}

export function adaptUrlMonitors(src: {
  monitors?: Array<Record<string, unknown>>;
}): ImportPayload['urlMonitors'] {
  return (src.monitors ?? []).map((m) => {
    const id = readId(m.id);
    const channelRefs = readChannelRefs(m.channel_ids);
    return {
      ...(id !== undefined && { id }),
      name: m.name as string,
      url: m.url as string,
      timeoutMs: (m.timeout_ms as number) ?? 30000,
      intervalSeconds: cronToSeconds(m.interval as string),
      enabled: readEnabled(m),
      assertions: [{ operator: 'equals', statusCode: 200 }],
      ...(channelRefs !== undefined && { channelRefs }),
    };
  });
}

export function adaptApiChecks(src: {
  api_checks?: Array<Record<string, unknown>>;
}): ImportPayload['apiChecks'] {
  return (src.api_checks ?? []).map((c) => {
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
      enabled: readEnabled(c),
      assertions: ((c.assertions as Array<Record<string, unknown>>) ?? []).map((a) => ({
        type: a.type as string,
        operator: a.operator as string,
        path: (a.path as string) ?? null,
        value: a.value ?? null,
      })),
      ...(channelRefs !== undefined && { channelRefs }),
    };
  });
}

export function adaptQaSuites(src: { suites?: SaaSSuite[] }): {
  qaProjects: ImportPayload['qaProjects'];
  warnings: string[];
  suitesSkipped: number;
} {
  const qaProjects: ImportPayload['qaProjects'] = [];
  const warnings: string[] = [];
  let suitesSkipped = 0;
  for (const s of src.suites ?? []) {
    const tests = (Array.isArray(s.tests) ? s.tests : [])
      .filter((t) => t && typeof t.name === 'string' && typeof t.script === 'string')
      .map((t) => ({ name: t.name as string, script: t.script as string }));
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
  return { qaProjects, warnings, suitesSkipped };
}

function adaptEmailChannel(
  ch: SaaSChannel,
  id: number | undefined,
): ImportPayload['channels'][number] | null {
  const to = typeof ch.config?.email === 'string' ? ch.config.email.trim() : '';
  if (!EMAIL_RE.test(to)) return null;
  return {
    ...(id !== undefined && { id }),
    name: ch.name!,
    type: 'email',
    config: { to },
  };
}

function adaptWebhookChannel(
  ch: SaaSChannel,
  id: number | undefined,
  type: SupportedChannelType,
): ImportPayload['channels'][number] | null {
  const u = typeof ch.config?.webhook_url === 'string' ? ch.config.webhook_url.trim() : '';
  if (!HTTP_RE.test(u)) return null;
  return {
    ...(id !== undefined && { id }),
    name: ch.name!,
    type,
    config: { url: u },
  };
}

export function adaptAlertChannels(src: { alert_channels?: SaaSChannel[] }): {
  channels: ImportPayload['channels'];
  channelsSkipped: number;
} {
  const channels: ImportPayload['channels'] = [];
  let channelsSkipped = 0;
  for (const ch of src.alert_channels ?? []) {
    const type = ch.type;
    if (!ch.name || !type || !(SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type)) {
      channelsSkipped++;
      continue;
    }
    const id = readId((ch as Record<string, unknown>).id);
    const adapted =
      type === 'email'
        ? adaptEmailChannel(ch, id)
        : adaptWebhookChannel(ch, id, type as SupportedChannelType);
    if (!adapted) {
      channelsSkipped++;
      continue;
    }
    channels.push(adapted);
  }
  return { channels, channelsSkipped };
}

function parseStatusPageMonitorRef(m: {
  monitor_id?: unknown;
  monitor_type?: unknown;
}): { ref: number; type: 'url' | 'api' } | null {
  const ref = readId(m.monitor_id);
  const rawType = typeof m.monitor_type === 'string' ? m.monitor_type : '';
  const apiOrNull: 'api' | null = rawType === 'api_check' || rawType === 'api' ? 'api' : null;
  const type: 'url' | 'api' | null = rawType === 'url' ? 'url' : apiOrNull;
  if (ref === undefined || type === null) return null;
  return { ref, type };
}

export function adaptStatusPages(src: { status_pages?: SaaSStatusPage[] }): {
  statusPages: NonNullable<ImportPayload['statusPages']>;
  statusPagesSkipped: number;
} {
  const statusPages: NonNullable<ImportPayload['statusPages']> = [];
  let statusPagesSkipped = 0;
  for (const sp of src.status_pages ?? []) {
    if (!sp.slug || typeof sp.slug !== 'string') {
      statusPagesSkipped++;
      continue;
    }
    const monitors = (Array.isArray(sp.monitors) ? sp.monitors : [])
      .map((m) => parseStatusPageMonitorRef(m))
      .filter((m): m is { ref: number; type: 'url' | 'api' } => m !== null);
    if (monitors.length === 0) {
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
  return { statusPages, statusPagesSkipped };
}

export function adaptHeartbeats(src: { heartbeats?: unknown[] }): {
  heartbeats: NonNullable<ImportPayload['heartbeats']>;
  warnings: string[];
} {
  const heartbeats: NonNullable<ImportPayload['heartbeats']> = [];
  const warnings: string[] = [];
  let heartbeatsTokenless = 0;
  for (const h of (src.heartbeats ?? []) as Array<Record<string, unknown>>) {
    if (typeof h.name !== 'string') continue;
    const period = typeof h.period === 'number' ? h.period : null;
    const grace = typeof h.grace_period === 'number' ? h.grace_period : 60;
    if (period === null || !Number.isFinite(period) || period < 30) continue;
    const token = typeof h.ping_key === 'string' ? h.ping_key : undefined;
    if (token === undefined) heartbeatsTokenless++;
    heartbeats.push({
      name: h.name,
      ...(typeof h.description === 'string' ? { description: h.description } : {}),
      periodSeconds: period,
      graceSeconds: grace,
      ...(token !== undefined && { token }),
    });
  }
  if (heartbeatsTokenless > 0) {
    warnings.push(
      `${heartbeatsTokenless} heartbeat(s) imported without ping_key (CLI < v1.26.0). ` +
        `New ping URLs were generated; update the services posting to them.`,
    );
  }
  if (heartbeats.length > 0) {
    warnings.push(
      'Heartbeat alert-channel routing is not in the export bundle. ' +
        'Rewire alert channels on the self-host side after import.',
    );
  }
  return { heartbeats, warnings };
}
