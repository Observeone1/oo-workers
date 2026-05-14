/**
 * Server-side HTML renderer for the public status page.
 *
 * Plain HTML + inline CSS — no SPA boot, no auth, works without JS.
 * Reads system theme via `color-scheme: light dark`; the tokens.css
 * design system already publishes the dashboard's colors so a deployed
 * status page picks up the same look.
 *
 * Auto-refresh: meta-refresh every 60s so the bars + uptime stay live
 * without a server-pushed update path.
 */

import type { DayState, StatusPageSummary } from './status-page-aggregator.ts';

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function overallHeadline(overall: DayState): { label: string; emoji: string } {
  if (overall === 'down') return { label: 'Some services are degraded', emoji: '🔥' };
  if (overall === 'up') return { label: 'All systems operational', emoji: '✅' };
  return { label: 'Status unknown', emoji: '⚪' };
}

function uptimeLabel(uptime: number | null): string {
  if (uptime === null) return 'no data';
  return `${uptime}%`;
}

function bar(state: DayState, dayIdxFromNow: number): string {
  // 0 = today, 89 = 89 days ago.
  const date = new Date(Date.now() - dayIdxFromNow * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `<span class="bar bar-${state}" title="${date}: ${state}"></span>`;
}

export function renderStatusPageHtml(summary: StatusPageSummary): string {
  const { page, monitors, overall, generatedAt } = summary;
  const headline = overallHeadline(overall);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="60" />
  <title>${esc(page.title)} — status</title>
  <link rel="stylesheet" href="/tokens.css" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 880px; margin: 0 auto; padding: 32px 24px 64px; }
    .header {
      text-align: center;
      padding: 32px 0 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 32px;
    }
    .header h1 { margin: 0 0 4px; font-size: 26px; font-weight: 600; }
    .header p { color: var(--muted); margin: 0; }
    .overall {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 18px;
      margin: 24px 0 32px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 500;
      border: 1px solid var(--border);
    }
    .overall.up { background: color-mix(in srgb, var(--up) 12%, transparent); }
    .overall.down { background: color-mix(in srgb, var(--down) 12%, transparent); color: var(--down); }
    .overall.unknown { background: var(--panel-2); color: var(--muted); }
    .monitor {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      margin-bottom: 12px;
    }
    .monitor-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }
    .monitor-name { font-weight: 500; font-size: 15px; }
    .monitor-target { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; word-break: break-all; }
    .monitor-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .monitor-status.up { background: color-mix(in srgb, var(--up) 18%, transparent); color: var(--up); }
    .monitor-status.down { background: color-mix(in srgb, var(--down) 18%, transparent); color: var(--down); }
    .monitor-status.unknown { background: var(--panel-2); color: var(--muted); }
    .monitor-status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .bars {
      display: flex;
      gap: 2px;
      height: 28px;
      align-items: stretch;
      margin: 8px 0 6px;
    }
    .bar {
      flex: 1;
      border-radius: 2px;
      background: var(--unknown, #d1d5db);
    }
    .bar-up { background: var(--up); }
    .bar-down { background: var(--down); }
    .bar-unknown { background: color-mix(in srgb, var(--muted) 35%, transparent); }
    .meta-row {
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    footer {
      text-align: center;
      margin-top: 48px;
      color: var(--muted);
      font-size: 12px;
    }
    footer a { color: var(--muted); }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>${esc(page.title)}</h1>
      ${page.description ? `<p>${esc(page.description)}</p>` : ''}
    </div>

    <div class="overall ${overall}">
      <span>${headline.emoji}</span>
      <span>${esc(headline.label)}</span>
    </div>

    ${
      monitors.length === 0
        ? `<p style="text-align:center;color:var(--muted)">No monitors on this page yet.</p>`
        : monitors
            .map(
              (m) => `
      <div class="monitor">
        <div class="monitor-head">
          <div>
            <div class="monitor-name">${esc(m.name)}</div>
            <div class="monitor-target">${esc(m.target)}</div>
          </div>
          <div class="monitor-status ${m.currentStatus}">${esc(m.currentStatus)}</div>
        </div>
        <div class="bars">
          ${m.bars90d.map((s, idx) => bar(s, 89 - idx)).join('')}
        </div>
        <div class="meta-row">
          <span>90 days ago</span>
          <span>24h uptime: ${esc(uptimeLabel(m.uptime24h))}</span>
          <span>today</span>
        </div>
      </div>
    `,
            )
            .join('')
    }

    <footer>
      Powered by <a href="https://github.com/Observeone1/oo-workers" target="_blank" rel="noopener">oo-workers</a> ·
      Updated ${esc(new Date(generatedAt).toUTCString())} · auto-refresh every 60s
    </footer>
  </div>
</body>
</html>`;
}
