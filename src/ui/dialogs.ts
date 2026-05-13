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
    $('#url-fields').hidden = typeSelect.value !== 'url';
    $('#api-fields').hidden = typeSelect.value !== 'api';
    $('#qa-fields').hidden = typeSelect.value !== 'qa';
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
      body = {
        name,
        url,
        intervalSeconds,
        assertions: [{ operator: 'equals', statusCode: Number(fd.get('url_status') || 200) }],
      };
    } else if (type === 'api') {
      let assertions: unknown[] = [];
      try {
        assertions = JSON.parse((fd.get('api_assertions') as string) || '[]');
      } catch {
        alert('Assertions JSON is invalid');
        return;
      }
      body = { name, url, method: fd.get('api_method'), intervalSeconds, assertions };
    } else {
      body = {
        name,
        targetUrl: url,
        intervalSeconds,
        tests: [{ name: name.replace(/\s+/g, '_'), script: fd.get('qa_script') }],
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
