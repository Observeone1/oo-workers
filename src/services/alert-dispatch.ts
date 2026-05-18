/**
 * Alert dispatch — formats and POSTs payloads to each channel bound to a
 * monitor when its status transitions. Best-effort: a failing webhook
 * logs and moves on (no retries, no DLQ) so a flaky channel can't gum
 * up the result-write path.
 *
 * Transition model:
 *   SUCCESS → FAILED  → outage alert
 *   FAILED  → SUCCESS → recovery alert
 *   anything else    → silent
 *
 * Recovery + outage share the same payload shape; the `event` field is
 * 'outage' or 'recovery'. Channel-specific formatters add per-platform
 * niceties (color, emoji, embed structure).
 */

import { logger } from '../utils/logger.ts';
import { sendEmail } from './email.ts';
import {
  monitorAlertChannelRepo,
  type AlertChannelRow,
  type ChannelType,
  type MonitorType,
} from '../db/repositories/alert-channel.repo.ts';

type AlertEvent = 'outage' | 'recovery' | 'test';

export interface AlertContext {
  monitor: {
    type: MonitorType;
    id: number;
    name: string;
    target: string; // URL, host:port, or short identifier
  };
  event: AlertEvent;
  status: string; // 'FAILED' | 'SUCCESS' (always a transition target)
  statusCode?: number | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  startTime: string; // ISO
  regionSlug?: string | null;
}

const COLORS = {
  outage: 0xdc2626, // red-600
  recovery: 0x16a34a, // green-600
  test: 0x6b7280, // gray-500
} as const;

function headline(ctx: AlertContext): string {
  if (ctx.event === 'recovery') return `✅ ${ctx.monitor.name} recovered`;
  if (ctx.event === 'test') return `🧪 ${ctx.monitor.name} — test alert`;
  return `🔥 ${ctx.monitor.name} is down`;
}

function description(ctx: AlertContext): string {
  const parts: string[] = [];
  parts.push(`**Target:** ${ctx.monitor.target}`);
  parts.push(`**Type:** ${ctx.monitor.type.toUpperCase()}`);
  if (ctx.statusCode != null) parts.push(`**Status code:** ${ctx.statusCode}`);
  if (ctx.durationMs != null) parts.push(`**Latency:** ${ctx.durationMs}ms`);
  if (ctx.regionSlug) parts.push(`**Region:** ${ctx.regionSlug}`);
  if (ctx.errorMessage) parts.push(`**Error:** ${ctx.errorMessage.slice(0, 500)}`);
  return parts.join('\n');
}

function formatWebhook(ctx: AlertContext): { body: unknown; headers: Record<string, string> } {
  return {
    body: {
      event: ctx.event,
      monitor: ctx.monitor,
      status: ctx.status,
      statusCode: ctx.statusCode ?? null,
      errorMessage: ctx.errorMessage ?? null,
      durationMs: ctx.durationMs ?? null,
      startTime: ctx.startTime,
      regionSlug: ctx.regionSlug ?? null,
    },
    headers: { 'content-type': 'application/json' },
  };
}

function formatDiscord(ctx: AlertContext): { body: unknown; headers: Record<string, string> } {
  return {
    body: {
      embeds: [
        {
          title: headline(ctx),
          description: description(ctx),
          color: COLORS[ctx.event],
          timestamp: ctx.startTime,
          footer: { text: 'oo-workers' },
        },
      ],
    },
    headers: { 'content-type': 'application/json' },
  };
}

function formatSlack(ctx: AlertContext): { body: unknown; headers: Record<string, string> } {
  return {
    body: {
      text: headline(ctx),
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: headline(ctx), emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Target*\n${ctx.monitor.target}` },
            { type: 'mrkdwn', text: `*Type*\n${ctx.monitor.type.toUpperCase()}` },
            ...(ctx.statusCode != null
              ? [{ type: 'mrkdwn', text: `*Status code*\n${ctx.statusCode}` }]
              : []),
            ...(ctx.durationMs != null
              ? [{ type: 'mrkdwn', text: `*Latency*\n${ctx.durationMs}ms` }]
              : []),
            ...(ctx.regionSlug ? [{ type: 'mrkdwn', text: `*Region*\n${ctx.regionSlug}` }] : []),
          ],
        },
        ...(ctx.errorMessage
          ? [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*Error*\n\`\`\`${ctx.errorMessage.slice(0, 500)}\`\`\``,
                },
              },
            ]
          : []),
      ],
    },
    headers: { 'content-type': 'application/json' },
  };
}

function formatFor(
  type: ChannelType,
  ctx: AlertContext,
): { body: unknown; headers: Record<string, string> } {
  if (type === 'discord') return formatDiscord(ctx);
  if (type === 'slack') return formatSlack(ctx);
  return formatWebhook(ctx);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Email gets its own formatting (not the markdown headline/description the
// chat channels use): a plain subject with a filterable prefix, a clean
// label-aligned text part, and a table-layout HTML part with inline CSS so
// it renders consistently across mail clients.
const EMAIL_TONE = {
  outage: { tag: 'DOWN', color: '#dc2626', lead: (n: string) => `${n} is failing its check.` },
  recovery: { tag: 'RECOVERED', color: '#16a34a', lead: (n: string) => `${n} is back up.` },
  test: {
    tag: 'TEST',
    color: '#6b7280',
    lead: () => 'Test alert from oo-workers — this channel is wired up correctly.',
  },
} as const;

function whenUtc(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function emailFields(ctx: AlertContext): Array<[string, string, boolean]> {
  // [label, value, monospace]
  const f: Array<[string, string, boolean]> = [
    ['Target', ctx.monitor.target, true],
    ['Check', ctx.monitor.type.toUpperCase(), false],
  ];
  if (ctx.statusCode != null) f.push(['Status code', String(ctx.statusCode), false]);
  if (ctx.durationMs != null) f.push(['Latency', `${ctx.durationMs} ms`, false]);
  if (ctx.regionSlug) f.push(['Region', ctx.regionSlug, false]);
  f.push(['When', whenUtc(ctx.startTime), false]);
  if (ctx.errorMessage) f.push(['Error', ctx.errorMessage.slice(0, 500), true]);
  return f;
}

function emailSubject(ctx: AlertContext): string {
  const t = EMAIL_TONE[ctx.event];
  return `[oo-workers] ${t.tag === 'TEST' ? 'Test alert' : t.tag === 'RECOVERED' ? 'Recovered' : 'DOWN'}: ${ctx.monitor.name}`;
}

function emailText(ctx: AlertContext): string {
  const t = EMAIL_TONE[ctx.event];
  const fields = emailFields(ctx);
  const pad = Math.max(...fields.map(([l]) => l.length)) + 2;
  const body = fields.map(([l, v]) => `${(l + ':').padEnd(pad)}${v}`).join('\n');
  return `${t.lead(ctx.monitor.name)}\n\n${body}\n\n—\noo-workers · self-hosted monitoring`;
}

function emailHtml(ctx: AlertContext): string {
  const t = EMAIL_TONE[ctx.event];
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const rows = emailFields(ctx)
    .map(
      ([label, value, isMono]) => `
            <tr>
              <td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
              <td style="padding:6px 0;color:#111827;font-size:14px;${isMono ? `font-family:${mono};word-break:break-all` : ''}">${escapeHtml(value)}</td>
            </tr>`,
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:${font}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td style="background:${t.color};height:4px;border-radius:8px 8px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px;padding:24px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.06em;color:${t.color}">${t.tag}</div>
      <div style="font-size:18px;font-weight:600;color:#111827;margin:4px 0 12px">${escapeHtml(ctx.monitor.name)}</div>
      <div style="font-size:14px;color:#374151;margin-bottom:16px">${escapeHtml(t.lead(ctx.monitor.name))}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #f0f1f3;padding-top:8px">${rows}
      </table>
      <div style="margin-top:20px;padding-top:12px;border-top:1px solid #f0f1f3;font-size:12px;color:#9ca3af">Sent by oo-workers · self-hosted monitoring</div>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Email channel — SMTP, not an HTTP POST. Recipient is per-channel
 * (`config.to`); the SMTP server is operator-level env config. A clear
 * failure (incl. "SMTP not configured") is logged and surfaces as a
 * failed test/alert, same best-effort posture as the webhook path.
 */
async function sendEmailChannel(channel: AlertChannelRow, ctx: AlertContext): Promise<boolean> {
  const to = (channel.config?.to as string | undefined)?.trim();
  if (!to) {
    logger.error(`channel #${channel.id} ${channel.name}: missing config.to`);
    return false;
  }
  try {
    await sendEmail({
      to,
      subject: emailSubject(ctx),
      text: emailText(ctx),
      html: emailHtml(ctx),
    });
    return true;
  } catch (err) {
    logger.error(
      `channel #${channel.id} ${channel.name} (email) failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** Send to a single channel. Returns true on success, false otherwise. */
export async function sendToChannel(channel: AlertChannelRow, ctx: AlertContext): Promise<boolean> {
  if ((channel.type as ChannelType) === 'email') {
    return sendEmailChannel(channel, ctx);
  }
  const url = (channel.config?.url as string | undefined)?.trim();
  if (!url) {
    logger.error(`channel #${channel.id} ${channel.name}: missing config.url`);
    return false;
  }
  const { body, headers } = formatFor(channel.type as ChannelType, ctx);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(
        `channel #${channel.id} ${channel.name} (${channel.type}) HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      `channel #${channel.id} ${channel.name} (${channel.type}) failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** Dispatch to every enabled channel bound to the monitor. Fire-and-forget — never throws. */
export async function dispatchAlert(ctx: AlertContext): Promise<void> {
  let channels: AlertChannelRow[];
  try {
    channels = await monitorAlertChannelRepo.forMonitor(ctx.monitor.type, ctx.monitor.id);
  } catch (err) {
    logger.error(`alert dispatch: lookup failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0) return;
  await Promise.all(enabled.map((c) => sendToChannel(c, ctx)));
}
