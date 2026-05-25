/**
 * The multi-type Add Monitor dialog. Tile-grid picker → per-type field
 * panels → optional regions + channels pickers → submit.
 *
 * The regions/channels picker helpers (refreshRegionsPicker, syncRegionsRow,
 * etc.) live in this file because they read the active monitor type via
 * `activeAddType` and only exist to populate this dialog. Other surfaces
 * that need regions/channels (the Regions and Channels pages) hit the
 * API directly.
 */
import type { MonType } from '../types';
import { $, esc } from '../helpers';
import {
  createMonitor,
  updateMonitor,
  getChannels,
  getRegions,
  setMonitorChannels,
  setMonitorRegions,
  type ChannelLite,
  type RegionLite,
} from '../api';
import { renderList, setActiveTab } from '../list';
import { alertDialog } from '../dialogs';

// Cache regions/channels for the lifetime of the dialog session. Refreshed
// each time the operator opens "Add monitor" so freshly-created ones show up.
let cachedRegions: RegionLite[] = [];
let cachedChannels: ChannelLite[] = [];

// Track active type from the tile grid
let activeAddType: MonType = 'url';

// API-assertion metadata — referenced by addAssertionRow (module-level so
// openEditDialog can call addAssertionRow without being inside initAddDialog).
const ASSERTION_TYPES: ReadonlyArray<{
  value: string;
  label: string;
  needsPath: boolean;
  valuePlaceholder: string;
}> = [
  { value: 'status_code', label: 'Status code', needsPath: false, valuePlaceholder: '200' },
  {
    value: 'response_time',
    label: 'Response time (ms)',
    needsPath: false,
    valuePlaceholder: '1000',
  },
  { value: 'json_path', label: 'JSON path', needsPath: true, valuePlaceholder: 'expected' },
  {
    value: 'text_contains',
    label: 'Body contains',
    needsPath: false,
    valuePlaceholder: 'substring',
  },
  { value: 'header', label: 'Header', needsPath: true, valuePlaceholder: 'expected' },
];
const ASSERTION_OPERATORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'less_than', label: 'less than' },
  { value: 'greater_than', label: 'greater than' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'not contains' },
  { value: 'exists', label: 'exists' },
];

function showFieldsForType(type: MonType): void {
  const dlg = document.getElementById('add-dialog') as HTMLElement | null;
  if (!dlg) return;
  (['url-fields', 'api-fields', 'qa-fields', 'udp-fields'] as const).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !id.startsWith(type + '-');
  });
  dlg.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
    el.hidden = el.dataset.for !== type;
  });
  const urlRow = document.getElementById('url-row');
  if (urlRow) urlRow.hidden = ['tcp', 'udp', 'db', 'tls', 'heartbeat'].includes(type);
  const tcpRow = document.getElementById('tcp-row');
  if (tcpRow) tcpRow.hidden = type !== 'tcp';
  const udpRow = document.getElementById('udp-row');
  if (udpRow) udpRow.hidden = type !== 'udp';
  const dbRow = document.getElementById('db-row');
  if (dbRow) dbRow.hidden = type !== 'db';
  const tlsRow = document.getElementById('tls-row');
  if (tlsRow) tlsRow.hidden = type !== 'tls';
  syncRegionsRow();
}

function addAssertionRow(
  initial: { type?: string; operator?: string; path?: string; value?: string } = {},
): void {
  const container = $('#api-assertion-rows');
  const row = document.createElement('div');
  row.className = 'assertion-row';
  row.setAttribute('data-testid', 'add-monitor-api-assertion-row');
  row.innerHTML = `
    <select data-field="type" data-testid="add-monitor-api-assertion-type">
      ${ASSERTION_TYPES.map(
        (t) =>
          `<option value="${esc(t.value)}"${initial.type === t.value ? ' selected' : ''}>${esc(t.label)}</option>`,
      ).join('')}
    </select>
    <select data-field="operator" data-testid="add-monitor-api-assertion-operator">
      ${ASSERTION_OPERATORS.map(
        (o) =>
          `<option value="${esc(o.value)}"${initial.operator === o.value ? ' selected' : ''}>${esc(o.label)}</option>`,
      ).join('')}
    </select>
    <input data-field="path" data-testid="add-monitor-api-assertion-path" placeholder="$.field or Header-Name" value="${esc(initial.path ?? '')}" />
    <input data-field="value" data-testid="add-monitor-api-assertion-value" placeholder="200" value="${esc(initial.value ?? '')}" />
    <button type="button" class="bare assertion-remove" data-testid="add-monitor-api-assertion-remove" aria-label="Remove assertion">×</button>
  `;
  container.appendChild(row);

  const typeSel = row.querySelector<HTMLSelectElement>('[data-field="type"]')!;
  const pathInput = row.querySelector<HTMLInputElement>('[data-field="path"]')!;
  const valueInput = row.querySelector<HTMLInputElement>('[data-field="value"]')!;
  const syncRow = () => {
    const meta = ASSERTION_TYPES.find((t) => t.value === typeSel.value);
    pathInput.hidden = !(meta?.needsPath ?? false);
    valueInput.placeholder = meta?.valuePlaceholder ?? '';
  };
  typeSel.addEventListener('change', syncRow);
  syncRow();

  row.querySelector('.assertion-remove')!.addEventListener('click', () => {
    row.remove();
  });
}

// When non-null the dialog is in edit mode: type tiles are locked and submit
// calls PUT /api/monitors/:type/:id instead of POST.
let editModeId: number | null = null;

export function initAddDialog(): void {
  const addDialog = $<HTMLDialogElement>('#add-dialog');
  const addForm = $<HTMLFormElement>('#add-form');

  const CHECK_TITLE: Record<MonType, string> = {
    url: 'Check',
    api: 'Assertions',
    qa: 'Script',
    tcp: 'Check',
    udp: 'Check',
    db: 'Check',
    tls: 'Certificate',
    // Heartbeats are inverted-direction (the service pings us). "Check"
    // would be misleading — operator inputs the expected period, not
    // what to check.
    heartbeat: 'Schedule',
  };

  const NAME_PLACEHOLDER: Record<MonType, string> = {
    url: 'My website',
    api: 'Payment API',
    tcp: 'Postgres 5432',
    udp: 'DNS resolver',
    db: 'Production DB',
    tls: 'api.example.com',
    qa: 'Checkout flow',
    heartbeat: 'Nightly backup',
  };

  function resetAssertionRows(): void {
    const container = $('#api-assertion-rows');
    container.innerHTML = '';
    addAssertionRow({ type: 'status_code', operator: 'equals', value: '200' });
  }

  $('#api-add-assertion').addEventListener('click', () => {
    addAssertionRow({ type: 'status_code', operator: 'equals' });
  });

  const syncFields = (t: MonType = 'url') => {
    // Show/hide type-specific check panes
    $('#url-fields').hidden = t !== 'url';
    $('#api-fields').hidden = t !== 'api';
    $('#qa-fields').hidden = t !== 'qa';
    $('#udp-fields').hidden = t !== 'udp';
    // Hide check panes via data-for; hide basics rows by type
    addDialog.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
      el.hidden = el.dataset.for !== t;
    });
    // The shared URL row is for url/api/qa; TCP/UDP/DB/TLS swap in their
    // own rows; heartbeat has no target at all (service pings us).
    $('#url-row').hidden =
      t === 'tcp' || t === 'udp' || t === 'db' || t === 'tls' || t === 'heartbeat';
    $('#tcp-row').hidden = t !== 'tcp';
    $('#udp-row').hidden = t !== 'udp';
    $('#db-row').hidden = t !== 'db';
    const tlsRow = document.getElementById('tls-row');
    if (tlsRow) tlsRow.hidden = t !== 'tls';
    // Update type pill and check section title
    const pill = document.getElementById('dlg-type-pill');
    if (pill) pill.textContent = t.toUpperCase();
    const checkTitle = document.getElementById('check-title');
    if (checkTitle) checkTitle.textContent = CHECK_TITLE[t] ?? 'Check';
    const nameInput = addDialog.querySelector<HTMLInputElement>('input[name="name"]');
    if (nameInput) nameInput.placeholder = NAME_PLACEHOLDER[t];
    // Update rail active step
    syncRailToSection('type');
    syncRegionsRow();
  };

  function syncRailToSection(step: string) {
    addDialog.querySelectorAll<HTMLElement>('#add-rail .rail-step[data-step]').forEach((r) => {
      r.classList.toggle('active', r.dataset.step === step);
    });
  }

  // Wire rail scroll-spy
  addDialog.querySelector('.dialog-body')?.addEventListener('scroll', function (this: HTMLElement) {
    const top = this.scrollTop;
    const sections = addDialog.querySelectorAll<HTMLElement>('.form-section[data-section]');
    let cur = sections[0]?.dataset.section ?? 'type';
    for (const s of sections) {
      if (s.offsetTop - this.offsetTop - 20 <= top) cur = s.dataset.section ?? cur;
    }
    syncRailToSection(cur);
  });

  // Wire rail click → scroll
  addDialog.querySelectorAll<HTMLElement>('#add-rail .rail-step[data-step]').forEach((r) => {
    r.addEventListener('click', () => {
      const sec = addDialog.querySelector<HTMLElement>(
        `.form-section[data-section="${r.dataset.step}"]`,
      );
      const body = addDialog.querySelector<HTMLElement>('.dialog-body');
      if (sec && body) body.scrollTo({ top: sec.offsetTop - body.offsetTop, behavior: 'smooth' });
      syncRailToSection(r.dataset.step ?? 'type');
    });
  });

  // Wire up the type-tile buttons
  const typeGrid = document.getElementById('type-grid');
  typeGrid?.querySelectorAll<HTMLButtonElement>('.type-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      typeGrid.querySelectorAll('.type-tile').forEach((t) => t.classList.remove('active'));
      tile.classList.add('active');
      activeAddType = (tile.dataset.type ?? 'url') as MonType;
      syncFields(activeAddType);
      syncRegionsRow();
    });
  });

  // Wire close buttons with data-close-dialog
  addDialog.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => addDialog.close());
  });

  // ⌘/Ctrl+Enter submits the form
  addDialog.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addForm.requestSubmit();
    }
  });

  // Number inputs in the dialog ship with sane defaults (e.g. interval=60).
  // Without this, clicking the field puts the cursor at the end, so typing
  // "30" produces "6030" instead of replacing the default.
  addDialog.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((el) => {
    el.addEventListener('focus', () => el.select());
  });

  $('#add-btn').addEventListener('click', async () => {
    editModeId = null;
    activeAddType = 'url';
    updateDialogTitle('New monitor');
    // Reset tile selection and enable tiles
    const typeGrid2 = document.getElementById('type-grid');
    typeGrid2?.querySelectorAll('.type-tile').forEach((t) => {
      t.classList.remove('active');
      (t as HTMLButtonElement).disabled = false;
    });
    typeGrid2?.querySelector('[data-type="url"]')?.classList.add('active');
    syncFields(activeAddType);
    resetAssertionRows();
    await Promise.all([refreshRegionsPicker(), refreshChannelsPicker()]);
    addDialog.showModal();
    requestAnimationFrame(() => {
      const body = addDialog.querySelector<HTMLElement>('.dialog-body');
      if (body) body.scrollTop = 0;
    });
  });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(addForm);
    const type = activeAddType;
    const name = fd.get('name') as string;
    const url = fd.get('url') as string;
    const intervalSeconds = Number(fd.get('interval_seconds'));

    let body: unknown;
    if (type === 'url') {
      if (!url) {
        alertDialog({ title: 'Validation error', body: 'URL is required' });
        return;
      }
      body = {
        name,
        url,
        intervalSeconds,
        assertions: [{ operator: 'equals', statusCode: Number(fd.get('url_status') || 200) }],
      };
    } else if (type === 'api') {
      if (!url) {
        alertDialog({ title: 'Validation error', body: 'URL is required' });
        return;
      }
      const rows = addDialog.querySelectorAll<HTMLElement>('#api-assertion-rows .assertion-row');
      const assertions: Array<{ type: string; operator: string; path?: string; value?: string }> =
        [];
      for (const row of rows) {
        const t = row.querySelector<HTMLSelectElement>('[data-field="type"]')?.value ?? '';
        const op = row.querySelector<HTMLSelectElement>('[data-field="operator"]')?.value ?? '';
        const path = row.querySelector<HTMLInputElement>('[data-field="path"]')?.value.trim() ?? '';
        const value =
          row.querySelector<HTMLInputElement>('[data-field="value"]')?.value.trim() ?? '';
        if (!t || !op) continue;
        const entry: { type: string; operator: string; path?: string; value?: string } = {
          type: t,
          operator: op,
        };
        if (path) entry.path = path;
        if (value) entry.value = value;
        assertions.push(entry);
      }
      body = { name, url, method: fd.get('api_method'), intervalSeconds, assertions };
    } else if (type === 'qa') {
      if (!url) {
        alertDialog({ title: 'Validation error', body: 'Target URL is required' });
        return;
      }
      body = {
        name,
        targetUrl: url,
        intervalSeconds,
        tests: [{ name: name.replace(/\s+/g, '_'), script: fd.get('qa_script') }],
      };
    } else if (type === 'tcp') {
      const host = String(fd.get('tcp_host') ?? '').trim();
      const port = Number(fd.get('tcp_port'));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        alertDialog({ title: 'Validation error', body: 'Host + port (1–65535) required' });
        return;
      }
      const tcpPayloadHex = String(fd.get('tcp_payload_hex') ?? '').trim();
      const tcpExpectBanner = String(fd.get('tcp_expect_banner') ?? '').trim();
      body = {
        name,
        host,
        port,
        payloadHex: tcpPayloadHex || null,
        expectBanner: tcpExpectBanner || null,
        intervalSeconds: Number(fd.get('tcp_interval_seconds')) || 60,
      };
    } else if (type === 'db') {
      const host = String(fd.get('db_host') ?? '').trim();
      const port = Number(fd.get('db_port'));
      const protocol = String(fd.get('db_protocol') ?? '');
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        alertDialog({ title: 'Validation error', body: 'Host + port (1–65535) required' });
        return;
      }
      if (protocol !== 'postgres' && protocol !== 'mysql' && protocol !== 'redis') {
        alertDialog({ title: 'Validation error', body: 'Pick a database protocol' });
        return;
      }
      body = {
        name,
        protocol,
        host,
        port,
        tls: fd.get('db_tls') === 'on',
        intervalSeconds: Number(fd.get('db_interval_seconds')) || 60,
      };
    } else if (type === 'tls') {
      const host = String(fd.get('tls_host') ?? '').trim();
      const port = Number(fd.get('tls_port') || 443);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        alertDialog({ title: 'Validation error', body: 'Host + port (1–65535) required' });
        return;
      }
      const warnDays = Number(fd.get('tls_warn_days') || 30);
      if (!Number.isInteger(warnDays) || warnDays < 0) {
        alertDialog({
          title: 'Validation error',
          body: 'Warn days must be a non-negative integer',
        });
        return;
      }
      const servername = String(fd.get('tls_servername') ?? '').trim();
      const expectCnRegex = String(fd.get('tls_expect_cn_regex') ?? '').trim();
      body = {
        name,
        host,
        port,
        servername: servername || null,
        warnDays,
        intervalSeconds: Number(fd.get('tls_interval_seconds')) || 60,
        verifyChain: fd.get('tls_verify_chain') === 'on',
        verifyHostname: fd.get('tls_verify_hostname') === 'on',
        expectCnRegex: expectCnRegex || null,
      };
    } else if (type === 'heartbeat') {
      const period = Number(fd.get('hb_period_seconds'));
      if (!Number.isFinite(period) || period < 30) {
        alertDialog({
          title: 'Validation error',
          body: 'Expected period must be a number ≥ 30 seconds',
        });
        return;
      }
      const grace = Number(fd.get('hb_grace_seconds') || 60);
      if (!Number.isFinite(grace) || grace < 0) {
        alertDialog({
          title: 'Validation error',
          body: 'Grace must be a non-negative number',
        });
        return;
      }
      body = {
        name,
        periodSeconds: period,
        graceSeconds: grace,
        description: String(fd.get('hb_description') ?? '').trim() || null,
      };
    } else {
      // udp
      const host = String(fd.get('udp_host') ?? '').trim();
      const port = Number(fd.get('udp_port'));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        alertDialog({ title: 'Validation error', body: 'Host + port (1–65535) required' });
        return;
      }
      const payloadHex = String(fd.get('udp_payload_hex') ?? '').trim();
      body = {
        name,
        host,
        port,
        payloadHex: payloadHex || null,
        expectResponse: fd.get('udp_expect_response') === 'on',
        intervalSeconds: Number(fd.get('udp_interval_seconds')) || 60,
      };
    }
    const res =
      editModeId !== null
        ? await updateMonitor(type, editModeId, body)
        : await createMonitor(type, body);
    if (!res.ok) {
      const label = editModeId !== null ? 'Update failed' : 'Create failed';
      alertDialog({ title: label, body: `Failed: ${await res.text()}` });
      return;
    }
    const created = (await res.json().catch(() => null)) as { id?: number } | null;

    // If the operator checked any regions/channels, bind them now. Best-effort:
    // the monitor itself exists either way; the operator can re-bind from the
    // Regions / Channels page if these PUTs fail.
    if (created?.id) {
      const regionIds = collectSelectedRegionIds();
      if (regionIds.length > 0) {
        try {
          await setMonitorRegions(type, created.id, regionIds);
        } catch (err) {
          alertDialog({
            title: 'Region binding failed',
            body: `Monitor created but region binding failed: ${
              err instanceof Error ? err.message : String(err)
            }. Fix it from the Regions page.`,
          });
        }
      }
      const channelIds = collectSelectedChannelIds();
      if (channelIds.length > 0) {
        try {
          await setMonitorChannels(type, created.id, channelIds);
        } catch (err) {
          alertDialog({
            title: 'Channel binding failed',
            body: `Monitor created but alert-channel binding failed: ${
              err instanceof Error ? err.message : String(err)
            }. Fix it from the Channels page.`,
          });
        }
      }
    }

    addDialog.close();
    addForm.reset();
    syncFields();
    if (editModeId !== null) {
      const editedId = editModeId;
      editModeId = null;
      // If the dialog was opened from a detail page, navigate back there so
      // the operator sees the updated monitor instead of a list-then-detail flash.
      if (/^#\/(url|api|qa|tcp|udp|db|tls|heartbeat)\/\d+$/.test(location.hash)) {
        location.hash = `#/${type}/${editedId}`;
      } else {
        setActiveTab(type);
        renderList();
      }
    } else {
      setActiveTab(type);
      renderList();
    }
  });
}

function updateDialogTitle(title: string) {
  const h = document.querySelector<HTMLElement>('#add-dialog .dialog-head h2');
  if (h) h.textContent = title;
}

/**
 * Open the dialog pre-populated with an existing monitor's data.
 * `monitorData` should be the `monitor` object from GET /api/monitors/:type/:id.
 * `extra` carries type-specific extras: assertions[] for API, tests[] for QA.
 */
export async function openEditDialog(
  type: MonType,
  id: number,
  monitorData: Record<string, unknown>,
  extra?: { assertions?: Array<Record<string, unknown>>; tests?: Array<Record<string, unknown>> },
): Promise<void> {
  const addDialog = $<HTMLDialogElement>('#add-dialog');

  editModeId = id;
  activeAddType = type;
  updateDialogTitle('Edit monitor');

  // Lock tile to the current type (no type switching on edit).
  const typeGrid = document.getElementById('type-grid');
  typeGrid?.querySelectorAll<HTMLButtonElement>('.type-tile').forEach((t) => {
    t.classList.remove('active');
    t.disabled = t.dataset.type !== type;
  });
  typeGrid?.querySelector(`[data-type="${type}"]`)?.classList.add('active');

  showFieldsForType(type);

  // Pre-fill shared fields.
  const nameInput = addDialog.querySelector<HTMLInputElement>('input[name="name"]');
  if (nameInput) nameInput.value = String(monitorData.name ?? '');

  // Pre-fill type-specific fields.
  if (type === 'url' || type === 'api' || type === 'qa') {
    const urlInput = addDialog.querySelector<HTMLInputElement>('input[name="url"]');
    if (urlInput) urlInput.value = String(monitorData.url ?? monitorData.targetUrl ?? '');
  }
  if (type === 'url' || type === 'api') {
    const intInput = addDialog.querySelector<HTMLInputElement>('input[name="interval_seconds"]');
    if (intInput) intInput.value = String(monitorData.intervalSeconds ?? 60);
  }
  if (type === 'api') {
    const methodSel = addDialog.querySelector<HTMLSelectElement>('select[name="api_method"]');
    if (methodSel) methodSel.value = String(monitorData.method ?? 'GET');
    const container = document.getElementById('api-assertion-rows')!;
    container.innerHTML = '';
    const assertions = extra?.assertions ?? [];
    if (assertions.length > 0) {
      assertions.forEach((a) =>
        addAssertionRow({
          type: String(a.type ?? ''),
          operator: String(a.operator ?? ''),
          path: a.path ? String(a.path) : '',
          value: a.value ? String(a.value) : '',
        }),
      );
    } else {
      addAssertionRow({ type: 'status_code', operator: 'equals', value: '200' });
    }
  }
  if (type === 'qa') {
    const intInput = addDialog.querySelector<HTMLInputElement>('input[name="interval_seconds"]');
    if (intInput) intInput.value = String(monitorData.intervalSeconds ?? 300);
    const scriptArea = addDialog.querySelector<HTMLTextAreaElement>('textarea[name="qa_script"]');
    if (scriptArea && extra?.tests?.[0]) {
      scriptArea.value = String(extra.tests[0].script ?? '');
    }
  }
  if (type === 'tcp') {
    const h = addDialog.querySelector<HTMLInputElement>('input[name="tcp_host"]');
    const p = addDialog.querySelector<HTMLInputElement>('input[name="tcp_port"]');
    const ph = addDialog.querySelector<HTMLInputElement>('input[name="tcp_payload_hex"]');
    const eb = addDialog.querySelector<HTMLInputElement>('input[name="tcp_expect_banner"]');
    const iv = addDialog.querySelector<HTMLInputElement>('input[name="tcp_interval_seconds"]');
    if (h) h.value = String(monitorData.host ?? '');
    if (p) p.value = String(monitorData.port ?? '');
    if (ph) ph.value = String(monitorData.payloadHex ?? '');
    if (eb) eb.value = String(monitorData.expectBanner ?? '');
    if (iv) iv.value = String(monitorData.intervalSeconds ?? 60);
  }
  if (type === 'udp') {
    const h = addDialog.querySelector<HTMLInputElement>('input[name="udp_host"]');
    const p = addDialog.querySelector<HTMLInputElement>('input[name="udp_port"]');
    const ph = addDialog.querySelector<HTMLInputElement>('input[name="udp_payload_hex"]');
    const er = addDialog.querySelector<HTMLInputElement>('input[name="udp_expect_response"]');
    const iv = addDialog.querySelector<HTMLInputElement>('input[name="udp_interval_seconds"]');
    if (h) h.value = String(monitorData.host ?? '');
    if (p) p.value = String(monitorData.port ?? '');
    if (ph) ph.value = String(monitorData.payloadHex ?? '');
    if (er) er.checked = monitorData.expectResponse === true;
    if (iv) iv.value = String(monitorData.intervalSeconds ?? 60);
  }
  if (type === 'db') {
    const pr = addDialog.querySelector<HTMLSelectElement>('select[name="db_protocol"]');
    const h = addDialog.querySelector<HTMLInputElement>('input[name="db_host"]');
    const p = addDialog.querySelector<HTMLInputElement>('input[name="db_port"]');
    const tl = addDialog.querySelector<HTMLInputElement>('input[name="db_tls"]');
    const iv = addDialog.querySelector<HTMLInputElement>('input[name="db_interval_seconds"]');
    if (pr) pr.value = String(monitorData.protocol ?? 'postgres');
    if (h) h.value = String(monitorData.host ?? '');
    if (p) p.value = String(monitorData.port ?? '');
    if (tl) tl.checked = monitorData.tls === true;
    if (iv) iv.value = String(monitorData.intervalSeconds ?? 60);
  }
  if (type === 'tls') {
    const h = addDialog.querySelector<HTMLInputElement>('input[name="tls_host"]');
    const p = addDialog.querySelector<HTMLInputElement>('input[name="tls_port"]');
    const sn = addDialog.querySelector<HTMLInputElement>('input[name="tls_servername"]');
    const wd = addDialog.querySelector<HTMLInputElement>('input[name="tls_warn_days"]');
    const iv = addDialog.querySelector<HTMLInputElement>('input[name="tls_interval_seconds"]');
    const vc = addDialog.querySelector<HTMLInputElement>('input[name="tls_verify_chain"]');
    const vh = addDialog.querySelector<HTMLInputElement>('input[name="tls_verify_hostname"]');
    const cr = addDialog.querySelector<HTMLInputElement>('input[name="tls_expect_cn_regex"]');
    if (h) h.value = String(monitorData.host ?? '');
    if (p) p.value = String(monitorData.port ?? 443);
    if (sn) sn.value = String(monitorData.servername ?? '');
    if (wd) wd.value = String(monitorData.warnDays ?? 30);
    if (iv) iv.value = String(monitorData.intervalSeconds ?? 60);
    if (vc) vc.checked = monitorData.verifyChain === true;
    if (vh) vh.checked = monitorData.verifyHostname === true;
    if (cr) cr.value = String(monitorData.expectCnRegex ?? '');
  }
  if (type === 'heartbeat') {
    const per = addDialog.querySelector<HTMLInputElement>('input[name="hb_period_seconds"]');
    const grc = addDialog.querySelector<HTMLInputElement>('input[name="hb_grace_seconds"]');
    const dsc = addDialog.querySelector<HTMLTextAreaElement>('textarea[name="hb_description"]');
    if (per) per.value = String(monitorData.periodSeconds ?? 60);
    if (grc) grc.value = String(monitorData.graceSeconds ?? 60);
    if (dsc) dsc.value = String(monitorData.description ?? '');
  }

  await Promise.all([refreshRegionsPicker(), refreshChannelsPicker()]);
  addDialog.showModal();
  requestAnimationFrame(() => {
    const body = addDialog.querySelector<HTMLElement>('.dialog-body');
    if (body) body.scrollTop = 0;
  });
}

async function refreshRegionsPicker(): Promise<void> {
  const container = document.getElementById('regions-picker') as HTMLElement;
  try {
    cachedRegions = await getRegions();
  } catch {
    cachedRegions = [];
  }
  if (cachedRegions.length === 0) {
    container.innerHTML = '';
    syncRegionsRow();
    return;
  }
  container.innerHTML = cachedRegions
    .map(
      (r) => `
      <label class="pick">
        <input type="checkbox" name="region_id" value="${r.id}" />
        <span class="dot ${r.online ? 'up' : ''}"></span>
        <code>${esc(r.slug)}</code>
        <span class="desc">${esc(r.label)}</span>
      </label>
    `,
    )
    .join('');
  syncRegionsRow();
}

// Heartbeats hide regions — they run nowhere (the SERVICE pings us).
// QA used to hide the picker too, but agents can now run browser checks
// (PRs #74/#75 + the playwright-baked agent image).
function syncRegionsRow(): void {
  const row = document.getElementById('regions-row') as HTMLElement;
  row.hidden = cachedRegions.length === 0 || activeAddType === 'heartbeat';
}

function collectSelectedRegionIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#regions-picker input[name="region_id"]:checked',
  );
  return Array.from(checked)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
}

async function refreshChannelsPicker(): Promise<void> {
  const row = document.getElementById('channels-row') as HTMLElement;
  const container = document.getElementById('channels-picker') as HTMLElement;
  try {
    cachedChannels = await getChannels();
  } catch {
    cachedChannels = [];
  }
  if (cachedChannels.length === 0) {
    row.hidden = true;
    container.innerHTML = '';
    return;
  }
  row.hidden = false;
  container.innerHTML = cachedChannels
    .map(
      (c) => `
      <label class="pick">
        <input type="checkbox" name="channel_id" value="${c.id}" />
        <span class="pill type-${c.type}">${esc(c.type)}</span>
        <span class="desc">${esc(c.name)}</span>
      </label>
    `,
    )
    .join('');
}

function collectSelectedChannelIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#channels-picker input[name="channel_id"]:checked',
  );
  return Array.from(checked)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
}
