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
import { renderList, setActiveTab, getActiveTab } from '../list';
import { alertDialog } from '../dialogs';
import { buildMonitorBodyFromForm } from './add-monitor-form-body';
import { prefillEditMonitorFields } from './add-monitor-edit-prefill';

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
  pathPlaceholder: string;
  valuePlaceholder: string;
}> = [
  {
    value: 'status_code',
    label: 'Status code',
    needsPath: false,
    pathPlaceholder: '',
    valuePlaceholder: '200',
  },
  {
    value: 'response_time',
    label: 'Response time (ms)',
    needsPath: false,
    pathPlaceholder: '',
    valuePlaceholder: '1000',
  },
  {
    value: 'json_path',
    label: 'JSON path',
    needsPath: true,
    pathPlaceholder: '$.field',
    valuePlaceholder: 'expected',
  },
  {
    value: 'text_contains',
    label: 'Body contains',
    needsPath: false,
    pathPlaceholder: '',
    valuePlaceholder: 'substring',
  },
  {
    value: 'header',
    label: 'Header',
    needsPath: true,
    pathPlaceholder: 'Content-Type',
    valuePlaceholder: 'expected',
  },
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

const TARGET_ROW_VISIBILITY: Array<[string, (t: MonType) => boolean]> = [
  ['url-row', (t) => t === 'tcp' || t === 'udp' || t === 'db' || t === 'tls' || t === 'heartbeat'],
  ['tcp-row', (t) => t !== 'tcp'],
  ['udp-row', (t) => t !== 'udp'],
  ['db-row', (t) => t !== 'db'],
  ['tls-row', (t) => t !== 'tls'],
];

function applyTargetRowVisibility(type: MonType): void {
  for (const [id, shouldHide] of TARGET_ROW_VISIBILITY) {
    const el = document.getElementById(id);
    if (el) el.hidden = shouldHide(type);
  }
}

// Module-level so both the create flow (syncFields) and the edit flow
// (showFieldsForType) render the same type-pill / section-title / name
// placeholder. Previously these lived inside initAddDialog and only the
// create flow updated them, so opening the edit dialog showed a stale pill.
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

function syncDialogChrome(type: MonType, dlg: HTMLElement): void {
  const pill = document.getElementById('dlg-type-pill');
  if (pill) pill.textContent = type.toUpperCase();
  const checkTitle = document.getElementById('check-title');
  if (checkTitle) checkTitle.textContent = CHECK_TITLE[type] ?? 'Check';
  const nameInput = dlg.querySelector<HTMLInputElement>('input[name="name"]');
  if (nameInput) nameInput.placeholder = NAME_PLACEHOLDER[type];
}

function showFieldsForType(type: MonType): void {
  const dlg = document.getElementById('add-dialog');
  if (!dlg) return;
  (['url-fields', 'api-fields', 'qa-fields', 'udp-fields'] as const).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !id.startsWith(type + '-');
  });
  dlg.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
    el.hidden = el.dataset.for !== type;
  });
  applyTargetRowVisibility(type);
  syncDialogChrome(type, dlg);
  syncRegionsRow();
}

function addAssertionRow(
  initial: { type?: string; operator?: string; path?: string; value?: string } = {},
): void {
  const container = $('#api-assertion-rows');
  const row = document.createElement('div');
  row.className = 'assertion-row';
  row.dataset.testid = 'add-monitor-api-assertion-row';
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
    <input data-field="path" data-testid="add-monitor-api-assertion-path" placeholder="" value="${esc(initial.path ?? '')}" />
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
    pathInput.placeholder = meta?.pathPlaceholder ?? '';
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

/** Matches a detail-page hash like `#/url/42`. Used to decide whether to
 * navigate back to the previously-viewed detail after submit. */
const DETAIL_HASH_RE = /^#\/(?:url|api|qa|tcp|udp|db|tls|heartbeat)\/\d+$/;

export function initAddDialog(): void {
  const addDialog = $<HTMLDialogElement>('#add-dialog');
  const addForm = $<HTMLFormElement>('#add-form');

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
    applyTargetRowVisibility(t);
    // Update type pill, check section title, and name placeholder.
    syncDialogChrome(t, addDialog);
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
    openCreateDialog();
  });

  /** Open the dialog for *create* mode. `initialType` defaults to the
   * currently-active list tab, falling back to URL when no typed tab is
   * showing. Clears any state left over from a prior edit so fields don't
   * leak between flows. */
  async function openCreateDialog(initialType?: MonType): Promise<void> {
    const tab = initialType ?? getActiveTab();
    const VALID: ReadonlySet<MonType> = new Set([
      'url',
      'api',
      'qa',
      'tcp',
      'udp',
      'db',
      'tls',
      'heartbeat',
    ]);
    const type: MonType = VALID.has(tab) ? tab : 'url';

    editModeId = null;
    activeAddType = type;
    updateDialogTitle('New monitor');
    updateSubmitLabel('Create monitor');

    // Clear any values left over from a prior edit. `addForm.reset()` resets
    // every native input/select/textarea inside the form, plus the multi-
    // selects for regions/channels. resetAssertionRows() seeds one default
    // status_code row so the API form opens with a sensible default.
    addForm.reset();
    resetAssertionRows();

    // Reset tile selection and re-enable any tile that edit mode had locked.
    const typeGrid2 = document.getElementById('type-grid');
    typeGrid2?.querySelectorAll('.type-tile').forEach((t) => {
      t.classList.remove('active');
      (t as HTMLButtonElement).disabled = false;
    });
    typeGrid2?.querySelector(`[data-type="${type}"]`)?.classList.add('active');

    syncFields(activeAddType);
    await Promise.all([refreshRegionsPicker(), refreshChannelsPicker()]);
    addDialog.showModal();
    requestAnimationFrame(() => {
      const body = addDialog.querySelector<HTMLElement>('.dialog-body');
      if (body) body.scrollTop = 0;
    });
  }

  // Per-tab empty-state CTA. Clicking "Add a <TYPE> monitor" opens the
  // dialog with the matching type pre-selected. Delegated handler so the
  // CTA can re-render without rebinding.
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tab-add]');
    if (!target) return;
    e.preventDefault();
    const t = target.dataset.tabAdd as MonType | undefined;
    void openCreateDialog(t);
  });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(addForm);
    const type = activeAddType;
    const built = buildMonitorBodyFromForm(type, fd, addDialog);
    if (!built.ok) {
      alertDialog({ title: 'Validation error', body: built.message });
      return;
    }
    const body = built.body;
    const res =
      editModeId === null
        ? await createMonitor(type, body)
        : await updateMonitor(type, editModeId, body);
    if (!res.ok) {
      const label = editModeId === null ? 'Create failed' : 'Update failed';
      alertDialog({ title: label, body: `Failed: ${await res.text()}` });
      return;
    }
    const created = (await res.json().catch(() => null)) as { id?: number } | null;

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
    const cameFromDetail = DETAIL_HASH_RE.test(location.hash);
    if (editModeId === null) {
      setActiveTab(type);
      if (cameFromDetail) {
        location.hash = '#/';
      } else {
        renderList();
      }
    } else {
      const editedId = editModeId;
      editModeId = null;
      if (cameFromDetail) {
        location.hash = `#/${type}/${editedId}`;
      } else {
        setActiveTab(type);
        renderList();
      }
    }
  });
}

function updateDialogTitle(title: string) {
  const h = document.querySelector<HTMLElement>('#add-dialog .dialog-head h2');
  if (h) h.textContent = title;
}

function updateSubmitLabel(label: string) {
  const btn = document.querySelector<HTMLElement>('[data-testid="add-monitor-submit"]');
  if (btn) btn.textContent = label;
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
  updateSubmitLabel('Save');

  // Lock tile to the current type (no type switching on edit).
  const typeGrid = document.getElementById('type-grid');
  typeGrid?.querySelectorAll<HTMLButtonElement>('.type-tile').forEach((t) => {
    t.classList.remove('active');
    t.disabled = t.dataset.type !== type;
  });
  typeGrid?.querySelector(`[data-type="${type}"]`)?.classList.add('active');

  showFieldsForType(type);

  prefillEditMonitorFields(addDialog, type, monitorData, extra, addAssertionRow);

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
