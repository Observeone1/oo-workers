import type { MonType } from './types';
import { $, esc } from './helpers';
import {
  backupUrl,
  createMonitor,
  getChannels,
  getRegions,
  importJson,
  restoreBackup,
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
  initBackupDialog();
}

function initAddDialog() {
  const addDialog = $<HTMLDialogElement>('#add-dialog');
  const typeSelect = $<HTMLSelectElement>('#type-select');
  const addForm = $<HTMLFormElement>('#add-form');

  const syncFields = () => {
    const t = typeSelect.value;
    $('#url-fields').hidden = t !== 'url';
    $('#api-fields').hidden = t !== 'api';
    $('#qa-fields').hidden = t !== 'qa';
    $('#udp-fields').hidden = t !== 'udp';
    // The shared URL row is for url/api/qa; TCP/UDP/DB swap in their own rows.
    $('#url-row').hidden = t === 'tcp' || t === 'udp' || t === 'db';
    $('#tcp-row').hidden = t !== 'tcp';
    $('#udp-row').hidden = t !== 'udp';
    $('#db-row').hidden = t !== 'db';
    syncRegionsRow();
  };
  typeSelect.addEventListener('change', syncFields);
  $('#add-btn').addEventListener('click', async () => {
    syncFields();
    await Promise.all([refreshRegionsPicker(), refreshChannelsPicker()]);
    addDialog.showModal();
  });
  $('#cancel-btn').addEventListener('click', () => addDialog.close());

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(addForm);
    const type = fd.get('type') as MonType;
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
      body = {
        name,
        host,
        port,
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
  const container = document.getElementById('regions-checkboxes') as HTMLElement;
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
      <label class="region-pick">
        <input type="checkbox" name="region_id" value="${r.id}" />
        <span class="region-pick-status ${r.online ? 'online' : 'offline'}" title="${
          r.online ? 'online' : 'offline'
        }"></span>
        <code>${esc(r.slug)}</code>
        <span class="region-pick-label">${esc(r.label)}</span>
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
  const row = document.getElementById('regions-row') as HTMLElement;
  const type = (document.getElementById('type-select') as HTMLSelectElement | null)?.value;
  row.hidden = cachedRegions.length === 0 || type === 'qa';
}

function collectSelectedRegionIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#regions-checkboxes input[name="region_id"]:checked',
  );
  return Array.from(checked)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
}

async function refreshChannelsPicker() {
  const row = document.getElementById('channels-row') as HTMLElement;
  const container = document.getElementById('channels-checkboxes') as HTMLElement;
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
      <label class="channel-pick">
        <input type="checkbox" name="channel_id" value="${c.id}" />
        <span class="channel-pick-type type-${c.type}">${esc(c.type)}</span>
        <span class="channel-pick-name">${esc(c.name)}</span>
      </label>
    `,
    )
    .join('');
}

function collectSelectedChannelIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#channels-checkboxes input[name="channel_id"]:checked',
  );
  return Array.from(checked)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
}

function initImportDialog() {
  const importDialog = $<HTMLDialogElement>('#import-dialog');

  $('#import-btn').addEventListener('click', () => importDialog.showModal());
  $('#import-cancel').addEventListener('click', () => importDialog.close());
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
    const skipped = result.skipped?.length ? `\n\nSkipped:\n${result.skipped.join('\n')}` : '';
    alertDialog({
      title: 'Import complete',
      body: `Created url=${result.url}, api=${result.api}, qa=${result.qa}${skipped}`,
    });
    importDialog.close();
    renderList();
  });
}

function initBackupDialog() {
  const dlg = $<HTMLDialogElement>('#backup-dialog');

  $('#backup-btn').addEventListener('click', () => dlg.showModal());
  $('#backup-cancel').addEventListener('click', () => dlg.close());

  $('#backup-download').addEventListener('click', () => {
    const scope =
      document.querySelector<HTMLInputElement>('input[name="backup_scope"]:checked')?.value ??
      'window';
    // Plain authed navigation — the browser streams the gzip to disk and
    // names it from the server's Content-Disposition. No `download` attr:
    // an empty one would override the header with a junk filename.
    const a = document.createElement('a');
    a.href = backupUrl(scope, 90);
    a.click();
  });

  $('#backup-restore').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#backup-file');
    const file = input.files?.[0];
    if (!file) {
      alertDialog({ title: 'Restore', body: 'Choose a .oodump.gz file first.' });
      return;
    }
    const ok = await confirmDialog({
      title: 'Replace all data?',
      body: `Restoring "${file.name}" wipes every monitor, channel, and execution in this instance and replaces them with the backup. This cannot be undone.`,
      confirmLabel: 'Wipe and restore',
      danger: true,
    });
    if (!ok) return;

    const { res, result } = await restoreBackup(file, true);
    if (!res.ok) {
      alertDialog({ title: 'Restore failed', body: result.error ?? 'Unknown error' });
      return;
    }
    const total = Object.values(result.counts ?? {}).reduce((a, b) => a + b, 0);
    alertDialog({ title: 'Restore complete', body: `${total} rows restored.` });
    dlg.close();
    renderList();
  });
}
