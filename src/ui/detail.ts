import type { MonType, RunLite } from './types';
import { $, esc, fmtAge, statusClass } from './helpers';
import { iconActive, iconPaused } from './icons';
import { getDetail, getRegions, runMonitor, type RegionLite } from './api';

const main = $('#main');

// Filter state per detail-render. 'all' shows every run; 'master' = regionId === null;
// numeric = regionId of a specific region.
type Filter = 'all' | 'master' | number;

const REGION_PALETTE = [
  '#10b981', // master / fallback
  '#3b82f6',
  '#f59e0b',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
];

function colorForFilter(filter: Filter, regionOrder: number[]): string {
  if (filter === 'master' || filter === 'all') return REGION_PALETTE[0];
  const idx = regionOrder.indexOf(filter);
  return REGION_PALETTE[(idx + 1) % REGION_PALETTE.length];
}

function regionLabel(filter: Filter, regions: Map<number, RegionLite>): string {
  if (filter === 'all') return 'All regions';
  if (filter === 'master') return 'Master';
  return regions.get(filter)?.label ?? `region #${filter}`;
}

/**
 * QA-only column. Renders a trace-download icon + screenshot thumbnails
 * when the failed run has artifacts. Returns an empty <td> for passing
 * runs so the column stays aligned.
 */
function renderArtifactsCell(r: RunLite): string {
  const trace = r.traceUrl;
  const shots = Array.isArray(r.screenshotUrls) ? r.screenshotUrls : [];
  if (!trace && shots.length === 0) return '<td class="meta">—</td>';
  const traceLink = trace
    ? `<a class="artifact-link" href="/api/artifacts?key=${encodeURIComponent(trace)}" title="Download Playwright trace.zip — open with: npx playwright show-trace trace.zip">trace.zip</a>`
    : '';
  const thumbs = shots
    .map(
      (k) =>
        `<a class="artifact-thumb" href="/api/artifacts?key=${encodeURIComponent(k)}" target="_blank" title="${esc(k)}"><img src="/api/artifacts?key=${encodeURIComponent(k)}" alt="screenshot" loading="lazy" /></a>`,
    )
    .join('');
  return `<td class="artifacts">${traceLink}${thumbs ? '<div class="artifact-thumbs">' + thumbs + '</div>' : ''}</td>`;
}

function latenciesOf(runs: RunLite[]): number[] {
  return runs
    .map((r) => r.responseTimeMs ?? r.durationMs)
    .filter((v): v is number => typeof v === 'number')
    .reverse()
    .slice(-30);
}

function applyFilter(runs: RunLite[], filter: Filter): RunLite[] {
  if (filter === 'all') return runs;
  if (filter === 'master') return runs.filter((r) => r.regionId == null);
  return runs.filter((r) => r.regionId === filter);
}

export async function renderDetail(type: MonType, id: number) {
  const [data, regionsList] = await Promise.all([
    getDetail(type, id),
    getRegions().catch(() => [] as RegionLite[]),
  ]);
  if (data.error) {
    main.innerHTML = `<div class="empty">${esc(data.error)}</div>`;
    return;
  }
  const m = data.monitor;
  const runs: RunLite[] = data.runs;
  const regions = new Map<number, RegionLite>(regionsList.map((r) => [r.id, r]));

  // Buckets: 'master' (regionId null) + each distinct numeric regionId.
  const regionIdsInRuns = Array.from(
    new Set(runs.map((r) => r.regionId).filter((v): v is number => typeof v === 'number')),
  );
  const hasMasterRuns = runs.some((r) => r.regionId == null);
  const buckets: Filter[] = [];
  if (regionIdsInRuns.length + (hasMasterRuns ? 1 : 0) > 1) {
    buckets.push('all');
  }
  if (hasMasterRuns) buckets.push('master');
  regionIdsInRuns.forEach((rid) => buckets.push(rid));

  const initialFilter: Filter = buckets[0] ?? 'all';
  renderWithFilter(type, id, m, runs, regions, regionIdsInRuns, buckets, initialFilter);
}

function renderWithFilter(
  type: MonType,
  id: number,
  m: Record<string, unknown> & { name: string; intervalSeconds: number; enabled: boolean },
  allRuns: RunLite[],
  regions: Map<number, RegionLite>,
  regionOrder: number[],
  buckets: Filter[],
  filter: Filter,
) {
  const host = m.host as string | undefined;
  const port = m.port as number | undefined;
  const url = host
    ? `${host}:${port ?? ''}`
    : ((m.url as string | undefined) ?? (m.targetUrl as string | undefined) ?? '');

  const runs = applyFilter(allRuns, filter);
  const sparkline = sparklineSvg(latenciesOf(runs), 480, 60, colorForFilter(filter, regionOrder));

  const successCount = runs.filter((r) => ['SUCCESS', 'passed'].includes(r.status)).length;
  const successRate =
    runs.length === 0 ? '—' : `${Math.round((successCount / runs.length) * 100)}%`;
  const lastLatency = runs[0]?.responseTimeMs ?? runs[0]?.durationMs;

  const showChips = buckets.length > 1;
  const chips = showChips
    ? `<div class="region-chips">${buckets
        .map((b) => {
          const active = b === filter ? 'active' : '';
          const count = applyFilter(allRuns, b).length;
          const color = colorForFilter(b, regionOrder);
          const dot =
            b === 'all' ? '' : `<span class="region-chip-dot" style="background:${color}"></span>`;
          return `<button class="region-chip ${active}" data-filter="${b}">${dot}${esc(regionLabel(b, regions))}<span class="region-chip-count">${count}</span></button>`;
        })
        .join('')}</div>`
    : '';

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
    ${chips}
    <div class="detail-meta">
      <div class="meta-card"><div class="label">Runs (last 100)</div><div class="value">${runs.length}</div></div>
      <div class="meta-card"><div class="label">Success rate</div><div class="value">${successRate}</div></div>
      <div class="meta-card"><div class="label">Last latency</div><div class="value">${lastLatency != null ? `${lastLatency}ms` : '—'}</div></div>
      <div class="meta-card"><div class="label">Status</div><div class="value">${m.enabled ? `${iconActive} active` : `${iconPaused} paused`}</div></div>
    </div>
    <div class="meta-card" style="margin-bottom:16px">
      <div class="label">Latency (last 30 runs — ${esc(regionLabel(filter, regions))})</div>
      ${sparkline}
    </div>
    <table>
      <thead><tr><th></th><th>When</th>${showChips ? '<th>Region</th>' : ''}<th>Status</th><th>Latency</th><th>Detail</th>${type === 'qa' ? '<th>Artifacts</th>' : ''}</tr></thead>
      <tbody>
        ${runs
          .map((r) => {
            const cls = statusClass(r.status);
            const latency = r.responseTimeMs ?? r.durationMs;
            const regionCell = showChips
              ? `<td class="meta">${r.regionId == null ? 'master' : esc(regions.get(r.regionId)?.slug ?? `#${r.regionId}`)}</td>`
              : '';
            const artifactsCell = type === 'qa' ? renderArtifactsCell(r) : '';
            return `<tr>
            <td><span class="dot ${cls}"></span></td>
            <td class="meta">${fmtAge(r.startTime)}</td>
            ${regionCell}
            <td>${r.status}${r.statusCode ? ' · ' + r.statusCode : ''}</td>
            <td class="meta">${latency != null ? `${latency}ms` : '—'}</td>
            <td class="meta">${esc((r.errorMessage ?? '').slice(0, 120))}</td>
            ${artifactsCell}
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
  if (showChips) {
    document.querySelectorAll<HTMLButtonElement>('.region-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.filter;
        const next: Filter = v === 'all' || v === 'master' ? v : Number(v);
        renderWithFilter(type, id, m, allRuns, regions, regionOrder, buckets, next);
      });
    });
  }
}

function sparklineSvg(values: number[], w: number, h: number, stroke: string): string {
  if (values.length === 0) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}"></svg>`;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const step = w / Math.max(1, values.length - 1);
  const pts = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 8) - 4}`)
    .join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5" />
  </svg>`;
}
