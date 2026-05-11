/**
 * Single-file UI. Plain TS, no framework. Hash-based routing:
 *   #/           → monitor list
 *   #/<type>/<id> → monitor detail
 */

type MonType = 'url' | 'api' | 'qa';

interface RunLite {
  id: number;
  status: string;
  status_code?: number | null;
  response_time_ms?: number | null;
  duration_ms?: number | null;
  error_message?: string | null;
  start_time: string;
}
interface Monitor {
  id: number;
  name: string;
  type: MonType;
  enabled: boolean;
  interval_seconds: number;
  url?: string;
  target_url?: string;
  latest?: RunLite | null;
  test_count?: number;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];
const main = $('#main');

const esc = (s: string) => (s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const fmtAge = (iso?: string | null) => {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
};

// ------------- list view -------------
let activeTab: MonType = 'url';

async function renderList() {
  const data = await (await fetch('/api/monitors')).json() as { url: Monitor[]; api: Monitor[]; qa: Monitor[] };
  const counts = { url: data.url.length, api: data.api.length, qa: data.qa.length };
  const monitors = data[activeTab];
  main.innerHTML = `
    <div class="tabs">
      ${(['url','api','qa'] as const).map(t =>
        `<div class="tab ${t===activeTab?'active':''}" data-tab="${t}">${t.toUpperCase()}<span class="count">${counts[t]}</span></div>`
      ).join('')}
    </div>
    ${monitors.length === 0
      ? `<div class="empty">No ${activeTab.toUpperCase()} monitors yet. Click <b>+ Add monitor</b> to create one.</div>`
      : `<table>
          <thead><tr><th></th><th>Name</th><th>Interval</th><th>Last run</th><th>Latency</th><th></th></tr></thead>
          <tbody>${monitors.map(rowFor).join('')}</tbody>
        </table>`}
  `;
  $$('.tab').forEach(t => t.addEventListener('click', () => { activeTab = t.dataset.tab as MonType; renderList(); }));
  $$('[data-run]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const {type, id} = (e.currentTarget as HTMLElement).dataset;
    await fetch(`/api/monitors/${type}/${id}/run`, {method:'POST'});
    setTimeout(renderList, 800);
  }));
  $$('[data-toggle]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const {type, id, enabled} = (e.currentTarget as HTMLElement).dataset;
    await fetch(`/api/monitors/${type}/${id}`, {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({enabled: enabled === 'false'})});
    renderList();
  }));
  $$('[data-del]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this monitor?')) return;
    const {type, id} = (e.currentTarget as HTMLElement).dataset;
    await fetch(`/api/monitors/${type}/${id}`, {method:'DELETE'});
    renderList();
  }));
  $$('[data-open]').forEach(b => b.addEventListener('click', () => {
    const {type, id} = (b as HTMLElement).dataset;
    location.hash = `#/${type}/${id}`;
  }));
}

function rowFor(m: Monitor): string {
  const status = m.latest?.status ?? 'unknown';
  const cls = ({SUCCESS:'SUCCESS', FAILED:'FAILED', passed:'passed', failed:'failed', error:'error', running:'running'} as Record<string,string>)[status] ?? 'unknown';
  const latency = m.latest?.response_time_ms ?? m.latest?.duration_ms;
  const url = m.url ?? m.target_url ?? '';
  return `
    <tr class="${m.enabled ? '' : 'disabled'}" data-open data-type="${m.type}" data-id="${m.id}" style="cursor:pointer">
      <td><span class="dot ${cls}"></span></td>
      <td>
        <div class="name">${esc(m.name)}</div>
        <div class="url">${esc(url)}${m.type === 'qa' ? ` · ${m.test_count ?? 0} test(s)` : ''}</div>
      </td>
      <td><span class="pill">every ${m.interval_seconds}s</span></td>
      <td class="meta">${fmtAge(m.latest?.start_time)}</td>
      <td class="meta">${latency != null ? `${latency}ms` : '—'}</td>
      <td class="row-actions">
        <button data-run data-type="${m.type}" data-id="${m.id}">Run</button>
        <button data-toggle data-type="${m.type}" data-id="${m.id}" data-enabled="${m.enabled}">${m.enabled ? 'Pause' : 'Resume'}</button>
        <button class="danger" data-del data-type="${m.type}" data-id="${m.id}">Delete</button>
      </td>
    </tr>`;
}

// ------------- detail view -------------
async function renderDetail(type: MonType, id: number) {
  const data = await (await fetch(`/api/monitors/${type}/${id}`)).json();
  if (data.error) { main.innerHTML = `<div class="empty">${esc(data.error)}</div>`; return; }
  const m = data.monitor;
  const runs: RunLite[] = data.runs;
  const url = m.url ?? m.target_url ?? '';

  const latencyValues = runs
    .map(r => r.response_time_ms ?? r.duration_ms)
    .filter((v): v is number => typeof v === 'number')
    .reverse()
    .slice(-30);
  const sparkline = sparklineSvg(latencyValues, 480, 60);

  const successCount = runs.filter(r => ['SUCCESS','passed'].includes(r.status)).length;
  const successRate = runs.length === 0 ? '—' : `${Math.round((successCount / runs.length) * 100)}%`;
  const lastLatency = runs[0]?.response_time_ms ?? runs[0]?.duration_ms;

  main.innerHTML = `
    <a class="back-link" href="#/">← back</a>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <h1 style="margin:0;font-size:20px">${esc(m.name)}</h1>
        <div class="url" style="margin-top:4px">${esc(url)} · <span class="pill">${type.toUpperCase()}</span> · every ${m.interval_seconds}s</div>
      </div>
      <div class="actions-bar">
        <button id="detail-run" class="primary">Run now</button>
      </div>
    </div>
    <div class="detail-meta">
      <div class="meta-card"><div class="label">Runs (last 100)</div><div class="value">${runs.length}</div></div>
      <div class="meta-card"><div class="label">Success rate</div><div class="value">${successRate}</div></div>
      <div class="meta-card"><div class="label">Last latency</div><div class="value">${lastLatency != null ? `${lastLatency}ms` : '—'}</div></div>
      <div class="meta-card"><div class="label">Status</div><div class="value">${m.enabled ? '🟢 active' : '⚪ paused'}</div></div>
    </div>
    <div class="meta-card" style="margin-bottom:16px">
      <div class="label">Latency (last 30 runs)</div>
      ${sparkline}
    </div>
    <table>
      <thead><tr><th></th><th>When</th><th>Status</th><th>Latency</th><th>Detail</th></tr></thead>
      <tbody>
        ${runs.map(r => {
          const cls = ({SUCCESS:'SUCCESS', FAILED:'FAILED', passed:'passed', failed:'failed', error:'error'} as Record<string,string>)[r.status] ?? 'unknown';
          const latency = r.response_time_ms ?? r.duration_ms;
          return `<tr>
            <td><span class="dot ${cls}"></span></td>
            <td class="meta">${fmtAge(r.start_time)}</td>
            <td>${r.status}${r.status_code ? ' · ' + r.status_code : ''}</td>
            <td class="meta">${latency != null ? `${latency}ms` : '—'}</td>
            <td class="meta">${esc((r.error_message ?? '').slice(0,120))}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  $('#detail-run').addEventListener('click', async () => {
    await fetch(`/api/monitors/${type}/${id}/run`, {method:'POST'});
    setTimeout(() => renderDetail(type, id), 1000);
  });
}

function sparklineSvg(values: number[], w: number, h: number): string {
  if (values.length === 0) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}"></svg>`;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 8) - 4}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="#10b981" stroke-width="1.5" />
  </svg>`;
}

// ------------- add dialog -------------
const addDialog = $<HTMLDialogElement>('#add-dialog');
const typeSelect = $<HTMLSelectElement>('#type-select');
const addForm = $<HTMLFormElement>('#add-form');

function syncFields() {
  $('#url-fields').hidden = typeSelect.value !== 'url';
  $('#api-fields').hidden = typeSelect.value !== 'api';
  $('#qa-fields').hidden = typeSelect.value !== 'qa';
}
typeSelect.addEventListener('change', syncFields);
$('#add-btn').addEventListener('click', () => { syncFields(); addDialog.showModal(); });
$('#cancel-btn').addEventListener('click', () => addDialog.close());

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(addForm);
  const type = fd.get('type') as MonType;
  const name = fd.get('name') as string;
  const url = fd.get('url') as string;
  const interval_seconds = Number(fd.get('interval_seconds'));

  let body: any;
  let endpoint = '';
  if (type === 'url') {
    body = { name, url, interval_seconds, assertions: [{operator:'equals', status_code: Number(fd.get('url_status') || 200)}] };
    endpoint = '/api/monitors/url';
  } else if (type === 'api') {
    let assertions = [];
    try { assertions = JSON.parse((fd.get('api_assertions') as string) || '[]'); } catch { alert('Assertions JSON is invalid'); return; }
    body = { name, url, method: fd.get('api_method'), interval_seconds, assertions };
    endpoint = '/api/monitors/api';
  } else {
    body = { name, target_url: url, interval_seconds, tests: [{ name: name.replace(/\s+/g,'_'), script: fd.get('qa_script') }] };
    endpoint = '/api/monitors/qa';
  }
  const res = await fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { alert(`Failed: ${await res.text()}`); return; }
  addDialog.close();
  addForm.reset();
  syncFields();
  activeTab = type;
  renderList();
});

// ------------- import dialog -------------
const importDialog = $<HTMLDialogElement>('#import-dialog');
$('#import-btn').addEventListener('click', () => importDialog.showModal());
$('#import-cancel').addEventListener('click', () => importDialog.close());
$('#import-submit').addEventListener('click', async () => {
  const text = $<HTMLTextAreaElement>('#import-text').value.trim();
  let payload: any;
  try { payload = JSON.parse(text); } catch { alert('Not valid JSON'); return; }
  const res = await fetch('/api/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  const result = await res.json();
  if (!res.ok) { alert(`Failed: ${JSON.stringify(result)}`); return; }
  const skipped = result.skipped?.length ? `\n\nSkipped:\n${result.skipped.join('\n')}` : '';
  alert(`Created url=${result.url}, api=${result.api}, qa=${result.qa}${skipped}`);
  importDialog.close();
  renderList();
});

// ------------- router -------------
function route() {
  const h = location.hash;
  const m = h.match(/^#\/(url|api|qa)\/(\d+)$/);
  if (m) renderDetail(m[1] as MonType, Number(m[2]));
  else renderList();
}
window.addEventListener('hashchange', route);
route();
setInterval(() => { if (!location.hash.startsWith('#/url/') && !location.hash.startsWith('#/api/') && !location.hash.startsWith('#/qa/')) renderList(); }, 5000);
