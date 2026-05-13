import type { MonType, RunLite } from './types';
import { $, esc, fmtAge, statusClass } from './helpers';
import { iconActive, iconPaused } from './icons';
import { getDetail, runMonitor } from './api';

const main = $('#main');

export async function renderDetail(type: MonType, id: number) {
  const data = await getDetail(type, id);
  if (data.error) {
    main.innerHTML = `<div class="empty">${esc(data.error)}</div>`;
    return;
  }
  const m = data.monitor;
  const runs: RunLite[] = data.runs;
  const url = (m.url as string | undefined) ?? (m.targetUrl as string | undefined) ?? '';

  const latencyValues = runs
    .map((r) => r.responseTimeMs ?? r.durationMs)
    .filter((v): v is number => typeof v === 'number')
    .reverse()
    .slice(-30);
  const sparkline = sparklineSvg(latencyValues, 480, 60);

  const successCount = runs.filter((r) => ['SUCCESS', 'passed'].includes(r.status)).length;
  const successRate =
    runs.length === 0 ? '—' : `${Math.round((successCount / runs.length) * 100)}%`;
  const lastLatency = runs[0]?.responseTimeMs ?? runs[0]?.durationMs;

  main.innerHTML = `
    <a class="back-link" href="#/">← back</a>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <h1 style="margin:0;font-size:20px">${esc(m.name)}</h1>
        <div class="url" style="margin-top:4px">${esc(url)} · <span class="pill">${type.toUpperCase()}</span> · every ${m.intervalSeconds}s</div>
      </div>
      <div class="actions-bar">
        <button id="detail-run" class="primary">Run now</button>
      </div>
    </div>
    <div class="detail-meta">
      <div class="meta-card"><div class="label">Runs (last 100)</div><div class="value">${runs.length}</div></div>
      <div class="meta-card"><div class="label">Success rate</div><div class="value">${successRate}</div></div>
      <div class="meta-card"><div class="label">Last latency</div><div class="value">${lastLatency != null ? `${lastLatency}ms` : '—'}</div></div>
      <div class="meta-card"><div class="label">Status</div><div class="value">${m.enabled ? `${iconActive} active` : `${iconPaused} paused`}</div></div>
    </div>
    <div class="meta-card" style="margin-bottom:16px">
      <div class="label">Latency (last 30 runs)</div>
      ${sparkline}
    </div>
    <table>
      <thead><tr><th></th><th>When</th><th>Status</th><th>Latency</th><th>Detail</th></tr></thead>
      <tbody>
        ${runs
          .map((r) => {
            const cls = statusClass(r.status);
            const latency = r.responseTimeMs ?? r.durationMs;
            return `<tr>
            <td><span class="dot ${cls}"></span></td>
            <td class="meta">${fmtAge(r.startTime)}</td>
            <td>${r.status}${r.statusCode ? ' · ' + r.statusCode : ''}</td>
            <td class="meta">${latency != null ? `${latency}ms` : '—'}</td>
            <td class="meta">${esc((r.errorMessage ?? '').slice(0, 120))}</td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;
  $('#detail-run').addEventListener('click', async () => {
    await runMonitor(type, id);
    setTimeout(() => renderDetail(type, id), 1000);
  });
}

function sparklineSvg(values: number[], w: number, h: number): string {
  if (values.length === 0) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}"></svg>`;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const step = w / Math.max(1, values.length - 1);
  const pts = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 8) - 4}`)
    .join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="#10b981" stroke-width="1.5" />
  </svg>`;
}
