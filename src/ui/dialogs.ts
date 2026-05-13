import type { MonType } from './types';
import { $ } from './helpers';
import { createMonitor, importJson } from './api';
import { renderList, setActiveTab } from './list';

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
  $('#add-btn').addEventListener('click', () => {
    syncFields();
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
    addDialog.close();
    addForm.reset();
    syncFields();
    setActiveTab(type);
    renderList();
  });
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
