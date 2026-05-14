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

/** Send to a single channel. Returns true on 2xx, false otherwise. */
export async function sendToChannel(channel: AlertChannelRow, ctx: AlertContext): Promise<boolean> {
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
