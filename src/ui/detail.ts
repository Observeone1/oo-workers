import type { MonType, RunLite } from './types';
import { $, esc, fmtAge, statusClass } from './helpers';
import { iconActive, iconPaused } from './icons';
import { getDetail, getRegions, runMonitor, type RegionLite } from './api';
import { openEditDialog } from './dialogs/add-monitor-dialog';

const main = $('#main');

// Filter state per detail-render. 'all' shows every run; 'master' = regionId === null;
// numeric = regionId of a specific region.
type Filter = 'all' | 'master' | number;

// Preserve the operator's region-chip selection across the 5s background
// re-render. Keyed by (type, id) so navigating to a different monitor
// correctly resets to the default bucket.
let lastFilterKey: string | null = null;
let lastFilter: Filter | null = null;

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
    ? `<a class="artifact-link" data-testid="artifact-trace-link" href="/api/artifacts?key=${encodeURIComponent(trace)}" title="Download Playwright trace.zip. Open with: npx playwright show-trace trace.zip">trace.zip</a>`
    : '';
  const thumbs = shots
    .map(
      (k) =>
        `<a class="artifact-thumb" data-testid="artifact-screenshot-thumb" href="/api/artifacts?key=${encodeURIComponent(k)}" target="_blank" title="${esc(k)}"><img src="/api/artifacts?key=${encodeURIComponent(k)}" alt="screenshot" loading="lazy" /></a>`,
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
  // Heartbeats short-circuit the runs/regions/latency-chart machinery —
  // they have none of those (inverted-direction). Show the public URL,
  // status, last ping, and a copy-paste curl example instead.
  if (type === 'heartbeat') {
    const data = await getDetail(type, id);
    if (data.error) {
      main.innerHTML = `<div class="empty">${esc(data.error)}</div>`;
      return;
    }
    renderHeartbeatDetail(data.monitor as Record<string, unknown>);
    return;
  }

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

  const key = `${type}:${id}`;
  const preserved =
    lastFilterKey === key && lastFilter !== null && buckets.includes(lastFilter)
      ? lastFilter
      : null;
  const initialFilter: Filter = preserved ?? buckets[0] ?? 'all';
  lastFilterKey = key;
  lastFilter = initialFilter;
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
    ? `<div class="chip-row">${buckets
        .map((b) => {
          const active = b === filter ? 'active' : '';
          const count = applyFilter(allRuns, b).length;
          const color = colorForFilter(b, regionOrder);
          const dot = b === 'all' ? '' : `<span class="dot" style="background:${color}"></span>`;
          return `<button class="region-chip ${active}" data-filter="${b}">${dot}${esc(regionLabel(b, regions))}<span class="ct">${count}</span></button>`;
        })
        .join('')}</div>`
    : '';

  main.innerHTML = `
    <a class="back-link" href="#/">← back</a>
    <div class="page-head">
      <div>
        <h2 style="font-size:var(--fs-22)">${esc(m.name)}</h2>
        <div class="sub">${esc(url)} · <span class="pill">${type.toUpperCase()}</span> · every ${m.intervalSeconds}s</div>
      </div>
      <div style="display:flex;gap:6px">
        <button id="detail-edit" class="btn" data-testid="detail-edit-btn" title="Edit monitor">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button id="detail-run" class="btn primary">Run now</button>
      </div>
    </div>
    ${chips}
    <div class="detail-grid" data-testid="detail-meta-cards">
      <div class="meta-card"><div class="label">Runs (last 100)</div><div class="value">${runs.length}</div></div>
      <div class="meta-card"><div class="label">Success rate</div><div class="value">${successRate}</div></div>
      <div class="meta-card"><div class="label">Last latency</div><div class="value">${lastLatency != null ? `${lastLatency}ms` : '—'}</div></div>
      <div class="meta-card"><div class="label">Status</div><div class="value flex">${m.enabled ? `${iconActive} active` : `${iconPaused} paused`}</div></div>
    </div>
    <div class="sparkline-wrap">
      <div class="head">
        <span class="cell-meta">Latency, last 30 runs</span>
        <span class="cell-meta">${esc(regionLabel(filter, regions))}</span>
      </div>
      ${sparkline}
    </div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th></th><th>When</th>${showChips ? '<th>Region</th>' : ''}<th>Status</th><th>Latency</th><th>Detail</th>${type === 'qa' ? '<th>Artifacts</th>' : ''}</tr></thead>
      <tbody>
        ${runs
          .map((r) => {
            const cls = statusClass(r.status);
            const latency = r.responseTimeMs ?? r.durationMs;
            const regionCell = showChips
              ? `<td class="cell-meta">${r.regionId == null ? 'master' : esc(regions.get(r.regionId)?.slug ?? `#${r.regionId}`)}</td>`
              : '';
            const artifactsCell = type === 'qa' ? renderArtifactsCell(r) : '';
            return `<tr>
            <td><span class="dot ${cls}"></span></td>
            <td class="cell-meta">${fmtAge(r.startTime)}</td>
            ${regionCell}
            <td>${r.status}${r.statusCode ? ' · ' + r.statusCode : ''}</td>
            <td class="cell-meta">${latency != null ? `${latency}ms` : '—'}</td>
            <td class="cell-meta">${esc((r.errorMessage ?? '').slice(0, 120))}</td>
            ${artifactsCell}
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>
    </div>
  `;
  $('#detail-run').addEventListener('click', async () => {
    await runMonitor(type, id);
    setTimeout(() => renderDetail(type, id), 1000);
  });
  $('#detail-edit').addEventListener('click', async () => {
    const data = await getDetail(type, id);
    if (data.error) return;
    const raw = data as unknown as Record<string, unknown>;
    await openEditDialog(type, id, raw.monitor as Record<string, unknown>, {
      assertions: raw.assertions as Array<Record<string, unknown>>,
      tests: raw.tests as Array<Record<string, unknown>>,
    });
  });
  if (showChips) {
    document.querySelectorAll<HTMLButtonElement>('.region-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.filter;
        const next: Filter = v === 'all' || v === 'master' ? v : Number(v);
        lastFilterKey = `${type}:${id}`;
        lastFilter = next;
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

// Heartbeat detail — no runs, no regions, no latency. Just the public
// ingest URL (the operator's primary action: copy it to their cron),
// status + last-ping age, and a copy-paste curl example.
function renderHeartbeatDetail(m: Record<string, unknown>) {
  const name = String(m.name ?? '');
  const description = m.description ? String(m.description) : '';
  const status = String(m.status ?? 'PENDING') as 'PENDING' | 'UP' | 'OVERDUE';
  const token = String(m.token ?? '');
  const periodSeconds = Number(m.periodSeconds ?? 0);
  const graceSeconds = Number(m.graceSeconds ?? 0);
  const enabled = m.enabled === true;
  const lastPingAt = m.lastPingAt ? String(m.lastPingAt) : null;
  const pingUrl = `${location.origin}/heartbeat/${token}`;
  const curl = `curl -fsS -X POST ${pingUrl}`;
  const cronExample = `*/${Math.max(1, Math.round(periodSeconds / 60))} * * * * ${curl} >/dev/null`;
  const dotClass = statusClass(status);

  main.innerHTML = `
    <a href="#/" class="back-link">← All monitors</a>
    <header class="detail-head">
      <h1>${esc(name)} ${enabled ? iconActive : iconPaused}</h1>
      ${description ? `<p class="detail-desc">${esc(description)}</p>` : ''}
    </header>
    <div class="detail-grid" data-testid="detail-meta-cards">
      <div class="meta-card">
        <span class="lbl">Status</span>
        <span class="val"><span class="dot ${dotClass}"></span> ${esc(status)}</span>
      </div>
      <div class="meta-card">
        <span class="lbl">Period</span>
        <span class="val">${periodSeconds}s</span>
      </div>
      <div class="meta-card">
        <span class="lbl">Grace</span>
        <span class="val">${graceSeconds}s</span>
      </div>
      <div class="meta-card">
        <span class="lbl">Last ping</span>
        <span class="val">${lastPingAt ? esc(fmtAge(lastPingAt)) : 'never'}</span>
      </div>
    </div>

    <section class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <span class="h"><em>Public ping URL</em></span>
      </div>
      <div class="panel-body">
        <p class="help" style="margin-bottom: 8px">
          Your service POSTs (or GETs) this URL on every successful run.
          We track the timestamp and alert if we don't see a ping within
          <strong>${periodSeconds}s + ${graceSeconds}s grace</strong>.
          The URL is the only secret. Anyone with it can mark your
          heartbeat alive. If it leaks, delete and recreate this monitor.
        </p>
        <div class="codeblock" data-testid="heartbeat-ping-url">
          <code>${esc(pingUrl)}</code>
          <button type="button" class="btn sm" data-copy="${esc(pingUrl)}" data-testid="heartbeat-copy-url">Copy</button>
        </div>
        <p class="help" style="margin-top: 12px"><strong>curl one-shot:</strong></p>
        <div class="codeblock"><code>${esc(curl)}</code><button type="button" class="btn sm" data-copy="${esc(curl)}">Copy</button></div>
        <p class="help" style="margin-top: 12px"><strong>cron line (every ${Math.round(periodSeconds / 60)} min):</strong></p>
        <div class="codeblock"><code>${esc(cronExample)}</code><button type="button" class="btn sm" data-copy="${esc(cronExample)}">Copy</button></div>
      </div>
    </section>
  `;

  // Wire copy buttons.
  main.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy ?? '';
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      } catch {
        // ignore — secure-context only; show no feedback rather than alert
      }
    });
  });
}
