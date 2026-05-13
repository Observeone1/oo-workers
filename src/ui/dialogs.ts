import type { MonType } from './types';
import { $, esc } from './helpers';
import { createMonitor, getRegions, importJson, setMonitorRegions, type RegionLite } from './api';
import { renderList, setActiveTab } from './list';

// Cache regions for the lifetime of the dialog session. Refreshed each time
// the operator opens "Add monitor" so freshly-created regions show up.
let cachedRegions: RegionLite[] = [];

export function initDialogs() {
  initAddDialog();
  initImportDialog();
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
    // The shared URL row is for url/api/qa; TCP/UDP swap in their own host+port rows.
    $('#url-row').hidden = t === 'tcp' || t === 'udp';
    $('#tcp-row').hidden = t !== 'tcp';
    $('#udp-row').hidden = t !== 'udp';
  };
  typeSelect.addEventListener('change', syncFields);
  $('#add-btn').addEventListener('click', async () => {
    syncFields();
    await refreshRegionsPicker();
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
        alert('URL is required');
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
        alert('URL is required');
        return;
      }
      let assertions: unknown[] = [];
      try {
        assertions = JSON.parse((fd.get('api_assertions') as string) || '[]');
      } catch {
        alert('Assertions JSON is invalid');
        return;
      }
      body = { name, url, method: fd.get('api_method'), intervalSeconds, assertions };
    } else if (type === 'qa') {
      if (!url) {
        alert('Target URL is required');
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
        alert('Host + port (1–65535) required');
        return;
      }
      body = {
        name,
        host,
        port,
        intervalSeconds: Number(fd.get('tcp_interval_seconds')) || 60,
      };
    } else {
      // udp
      const host = String(fd.get('udp_host') ?? '').trim();
      const port = Number(fd.get('udp_port'));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        alert('Host + port (1–65535) required');
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
      alert(`Failed: ${await res.text()}`);
      return;
    }
    const created = (await res.json().catch(() => null)) as { id?: number } | null;

    // If the operator checked any regions, bind them now. Fire-and-forget on
    // failure isn't ideal but the monitor exists; the operator can fix the
    // binding via the Regions page if this PUT fails.
    if (created?.id) {
      const regionIds = collectSelectedRegionIds();
      if (regionIds.length > 0) {
        try {
          await setMonitorRegions(type, created.id, regionIds);
        } catch (err) {
          alert(
            `Monitor created but region binding failed: ${
              err instanceof Error ? err.message : String(err)
            }. Fix it from the Regions page.`,
          );
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
  const container = document.getElementById('regions-checkboxes') as HTMLElement;
  try {
    cachedRegions = await getRegions();
  } catch {
    cachedRegions = [];
  }
  if (cachedRegions.length === 0) {
    row.hidden = true;
    container.innerHTML = '';
    return;
  }
  row.hidden = false;
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
}

function collectSelectedRegionIds(): number[] {
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#regions-checkboxes input[name="region_id"]:checked',
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
      alert('Not valid JSON');
      return;
    }
    const { res, result } = await importJson(payload);
    if (!res.ok) {
      alert(`Failed: ${JSON.stringify(result)}`);
      return;
    }
    const skipped = result.skipped?.length ? `\n\nSkipped:\n${result.skipped.join('\n')}` : '';
    alert(`Created url=${result.url}, api=${result.api}, qa=${result.qa}${skipped}`);
    importDialog.close();
    renderList();
  });
}
