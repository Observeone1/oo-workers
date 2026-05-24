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
