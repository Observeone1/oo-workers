import type { MonType } from './types';
import { $, esc } from './helpers';
import {
  createMonitor,
  getChannels,
  getRegions,
  importJson,
  setMonitorChannels,
  setMonitorRegions,
  type ChannelLite,
  type RegionLite,
} from './api';
import { renderList, setActiveTab } from './list';

// ---------------------------------------------------------------------------
// Generic confirm / alert backed by native <dialog>
// ---------------------------------------------------------------------------

let confirmDialogEl: HTMLDialogElement | null = null;
let alertDialogEl: HTMLDialogElement | null = null;

function getConfirmDialog(): HTMLDialogElement {
  if (!confirmDialogEl) {
    confirmDialogEl = document.createElement('dialog');
    confirmDialogEl.id = 'confirm-dialog';
    confirmDialogEl.className = 'confirm-dialog';
    confirmDialogEl.innerHTML = `
      <div class="confirm-dialog-inner">
        <h3 id="confirm-title"></h3>
        <p id="confirm-body"></p>
        <div class="dialog-actions">
          <button type="button" class="confirm-cancel">Cancel</button>
          <button type="button" class="confirm-ok primary"></button>
        </div>
      </div>
    `;
    document.body.appendChild(confirmDialogEl);

    // Wire up explicit close handlers — more reliable than form method="dialog".
    confirmDialogEl.querySelector('.confirm-cancel')!.addEventListener('click', () => {
      confirmDialogEl!.close('cancel');
    });
    confirmDialogEl.querySelector('.confirm-ok')!.addEventListener('click', () => {
      confirmDialogEl!.close('confirm');
    });
  }
  return confirmDialogEl;
}

function getAlertDialog(): HTMLDialogElement {
  if (!alertDialogEl) {
    alertDialogEl = document.createElement('dialog');
    alertDialogEl.id = 'alert-dialog';
    alertDialogEl.className = 'alert-dialog';
    alertDialogEl.innerHTML = `
      <div class="alert-dialog-inner">
        <h3 id="alert-title"></h3>
        <p id="alert-body"></p>
        <div class="dialog-actions">
          <button type="button" class="alert-ok primary">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(alertDialogEl);

    alertDialogEl.querySelector('.alert-ok')!.addEventListener('click', () => {
      alertDialogEl!.close('ok');
    });
  }
  return alertDialogEl;
}

/**
 * Show a themed confirmation dialog. Returns true if the user confirmed.
 */
export function confirmDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const dlg = getConfirmDialog();
  const titleEl = dlg.querySelector('#confirm-title')!;
  const bodyEl = dlg.querySelector('#confirm-body')!;
  const okBtn = dlg.querySelector('.confirm-ok') as HTMLButtonElement;

  titleEl.textContent = opts.title;
  bodyEl.textContent = opts.body;
  okBtn.textContent = opts.confirmLabel ?? 'Confirm';
  okBtn.className = `confirm-ok primary${opts.danger ? ' danger' : ''}`;

  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
  });
}

/**
 * Show a themed alert dialog. Resolves when dismissed.
 */
export function alertDialog(opts: { title: string; body: string }): Promise<void> {
  const dlg = getAlertDialog();
  dlg.querySelector('#alert-title')!.textContent = opts.title;
  dlg.querySelector('#alert-body')!.textContent = opts.body;

  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// Existing dialog init
// ---------------------------------------------------------------------------

// Cache regions for the lifetime of the dialog session. Refreshed each time
// the operator opens "Add monitor" so freshly-created regions show up.
let cachedRegions: RegionLite[] = [];
let cachedChannels: ChannelLite[] = [];

export function initDialogs() {
  initAddDialog();
  initImportDialog();
}

// Track active type from the tile grid
let activeAddType: MonType = 'url';

function initAddDialog() {
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
  };

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
    // The shared URL row is for url/api/qa; TCP/UDP/DB/TLS swap in their own rows.
    $('#url-row').hidden = t === 'tcp' || t === 'udp' || t === 'db' || t === 'tls';
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
      // QA-guard: hide the regions picker for type=qa (browser checks
      // run on master only, never on regional agents).
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

  $('#add-btn').addEventListener('click', async () => {
    activeAddType = 'url';
    // Reset tile selection
    const typeGrid2 = document.getElementById('type-grid');
    typeGrid2?.querySelectorAll('.type-tile').forEach((t) => t.classList.remove('active'));
    typeGrid2?.querySelector('[data-type="url"]')?.classList.add('active');
    syncFields(activeAddType);
    // Scroll body back to top
    const body = addDialog.querySelector<HTMLElement>('.dialog-body');
    if (body) body.scrollTop = 0;
    await Promise.all([refreshRegionsPicker(), refreshChannelsPicker()]);
    addDialog.showModal();
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
      let assertions: unknown[] = [];
      try {
        assertions = JSON.parse((fd.get('api_assertions') as string) || '[]');
      } catch {
        alertDialog({ title: 'Validation error', body: 'Assertions JSON is invalid' });
        return;
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
    const res = await createMonitor(type, body);
    if (!res.ok) {
      alertDialog({ title: 'Create failed', body: `Failed: ${await res.text()}` });
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
    setActiveTab(type);
    renderList();
  });
}

async function refreshRegionsPicker() {
  const row = document.getElementById('regions-row') as HTMLElement;
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

// QA/browser checks run on the master only — binding one to a region just
// yields ERROR exec rows. Hide the "Run from" picker for type=qa so it
// can't be set in the first place (also hidden when there are no regions).
function syncRegionsRow() {
  // Reads the v2 active type tile via module state. (Pre-v2 this read
  // a <select id="type-select"> which the redesign replaced with
  // .type-tile buttons; activeAddType is the canonical source now.)
  const row = document.getElementById('regions-row') as HTMLElement;
  row.hidden = cachedRegions.length === 0 || activeAddType === 'qa';
}

function collectSelectedRegionIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#regions-picker input[name="region_id"]:checked',
  );
  return Array.from(checked)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
}

async function refreshChannelsPicker() {
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

function initImportDialog() {
  const importDialog = $<HTMLDialogElement>('#import-dialog');

  $('#import-btn').addEventListener('click', () => importDialog.showModal());
  $('#import-cancel').addEventListener('click', () => importDialog.close());
  // New design also has a close button in the dialog-head
  importDialog.querySelectorAll('[data-close-import-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => importDialog.close());
  });
  $('#import-submit').addEventListener('click', async () => {
    const text = $<HTMLTextAreaElement>('#import-text').value.trim();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      alertDialog({ title: 'Import error', body: 'Not valid JSON' });
      return;
    }
    const { res, result } = await importJson(payload);
    if (!res.ok) {
      alertDialog({ title: 'Import failed', body: `Failed: ${JSON.stringify(result)}` });
      return;
    }
    const warnings = result.warnings?.length
      ? `\n\n⚠ ACTION NEEDED — imported but won’t fully work yet:\n${result.warnings
          .map((w) => `• ${w}`)
          .join('\n')}`
      : '';
    const skipped = result.skipped?.length ? `\n\nSkipped:\n${result.skipped.join('\n')}` : '';
    alertDialog({
      title: 'Import complete',
      body:
        `Created url=${result.url}, api=${result.api}, qa=${result.qa}, ` +
        `channels=${result.channels}${warnings}${skipped}`,
    });
    importDialog.close();
    renderList();
  });
}
