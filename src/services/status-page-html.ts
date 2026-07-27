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

import type {
  DayState,
  OverallStatus,
  PublicIncident,
  StatusPageSummary,
} from './status-page-aggregator.ts';
import { renderIncidentMarkdown } from './incident-render.ts';

const SEV_LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

function utc(ts: string): string {
  return new Date(ts).toUTCString();
}

function renderIncident(i: PublicIncident): string {
  const sev = SEV_LABEL[i.severity] ? i.severity : 'investigating';
  const latest = i.updates.at(-1);
  const thread = i.updates
    .map(
      (u) =>
        `<div class="upd"><div class="upd-meta"><span class="sev-pill sev-${
          SEV_LABEL[u.severity] ? u.severity : 'investigating'
        }">${esc(SEV_LABEL[u.severity] ?? u.severity)}</span><time>${esc(utc(u.createdAt))}</time></div>` +
        // renderIncidentMarkdown returns already-safe HTML — the single
        // intended unescaped path on this page (see incident-render.ts).
        `<div class="upd-body">${renderIncidentMarkdown(u.body)}</div></div>`,
    )
    .join('');
  return `
      <div class="incident sev-${sev}">
        <div class="incident-head">
          <span class="sev-pill sev-${sev}">${esc(SEV_LABEL[sev])}</span>
          <span class="incident-title">${esc(i.title)}</span>
        </div>
        ${
          latest
            ? `<div class="upd-body latest">${renderIncidentMarkdown(latest.body)}</div>
        <div class="incident-when">${esc(utc(latest.createdAt))}</div>`
            : ''
        }
        ${
          i.updates.length > 1
            ? `<details><summary>Full timeline (${i.updates.length} updates)</summary>${thread}</details>`
            : ''
        }
      </div>`;
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replaceAll(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function overallHeadline(overall: OverallStatus): { label: string; emoji: string } {
  if (overall === 'down') return { label: 'Some services are degraded', emoji: '🔥' };
  if (overall === 'degraded') return { label: 'Some services are degraded', emoji: '⚠️' };
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

export function renderStatusPageHtml(summary: StatusPageSummary, themeOverride?: string): string {
  const { page, monitors, incidents, overall, generatedAt } = summary;
  const headline = overallHeadline(overall);
  // CSP is `script-src 'none'`; honor the operator's theme via a class on
  // <html> read from the oo-theme cookie. The matching rule in the <style>
  // block below beats tokens.css :root (same specificity, later in cascade).
  const themeClass =
    themeOverride === 'light' || themeOverride === 'dark' ? ` class="theme-${themeOverride}"` : '';
  return `<!doctype html>
<html lang="en"${themeClass}>
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
    .overall.degraded { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
    .overall.unknown { background: var(--panel-2); color: var(--muted); }
    .incidents { margin: 0 0 28px; }
    .incident {
      background: var(--panel);
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 12px;
      padding: 16px 18px;
      margin-bottom: 12px;
    }
    .incident.sev-investigating { border-left-color: #d97706; }
    .incident.sev-identified { border-left-color: #ea580c; }
    .incident.sev-monitoring { border-left-color: #65a30d; }
    .incident.sev-resolved { border-left-color: var(--up); }
    .incident-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .incident-title { font-weight: 600; font-size: 15px; }
    .sev-pill {
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: .03em;
      white-space: nowrap;
      color: #fff;
    }
    .sev-pill.sev-investigating { background: #d97706; }
    .sev-pill.sev-identified { background: #ea580c; }
    .sev-pill.sev-monitoring { background: #65a30d; }
    .sev-pill.sev-resolved { background: var(--up); }
    .upd-body { font-size: 14px; }
    .upd-body.latest { margin: 4px 0 2px; }
    .upd-body p { margin: 6px 0; }
    .upd-body code {
      font-family: ui-monospace, monospace;
      background: var(--panel-2);
      padding: 1px 5px;
      border-radius: 4px;
    }
    .incident-when { color: var(--muted); font-size: 12px; }
    .incident details { margin-top: 12px; }
    .incident summary {
      cursor: pointer;
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      padding: 8px 12px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      list-style: none;
      user-select: none;
      transition: background 0.12s ease;
    }
    .incident summary:hover { background: var(--panel); }
    /* Hide the default disclosure triangle in WebKit/Blink so the
       chevron we draw below is the only marker. */
    .incident summary::-webkit-details-marker { display: none; }
    .incident summary::before {
      content: '';
      width: 7px;
      height: 7px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
    .incident details[open] summary::before { transform: rotate(45deg); }
    .incident .upd { border-top: 1px solid var(--border); padding: 10px 0 0; margin-top: 10px; }
    .incident .upd-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .incident .upd-meta time { color: var(--muted); font-size: 12px; }
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
    html.theme-light { color-scheme: light; }
    html.theme-dark { color-scheme: dark; }
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
      incidents.length > 0
        ? `<div class="incidents">${incidents.map(renderIncident).join('')}</div>`
        : ''
    }

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
