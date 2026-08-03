import type { MonType } from '../types';
import { formText } from '../helpers';

type AssertionRow = { type: string; operator: string; path?: string; value?: string };

export function prefillEditMonitorFields(
  addDialog: HTMLElement,
  type: MonType,
  monitorData: Record<string, unknown>,
  extra:
    | { assertions?: Array<Record<string, unknown>>; tests?: Array<Record<string, unknown>> }
    | undefined,
  addAssertionRow: (row: AssertionRow) => void,
): void {
  const nameInput = addDialog.querySelector<HTMLInputElement>('input[name="name"]');
  if (nameInput) nameInput.value = formText(monitorData.name);

  if (type === 'url' || type === 'api' || type === 'qa') {
    const urlInput = addDialog.querySelector<HTMLInputElement>('input[name="url"]');
    if (urlInput) urlInput.value = formText(monitorData.url ?? monitorData.targetUrl);
  }
  if (type === 'url' || type === 'api') {
    const intInput = addDialog.querySelector<HTMLInputElement>('input[name="interval_seconds"]');
    if (intInput) intInput.value = formText(monitorData.intervalSeconds, '60');
  }
  if (type === 'api') {
    prefillApiFields(addDialog, monitorData, extra, addAssertionRow);
    return;
  }
  if (type === 'qa') {
    prefillQaFields(addDialog, monitorData, extra);
    return;
  }
  if (type === 'tcp') {
    prefillTcpFields(addDialog, monitorData);
    return;
  }
  if (type === 'udp') {
    prefillUdpFields(addDialog, monitorData);
    return;
  }
  if (type === 'db') {
    prefillDbFields(addDialog, monitorData);
    return;
  }
  if (type === 'tls') {
    prefillTlsFields(addDialog, monitorData);
    return;
  }
  if (type === 'heartbeat') {
    prefillHeartbeatFields(addDialog, monitorData);
  }
}

function prefillApiFields(
  addDialog: HTMLElement,
  monitorData: Record<string, unknown>,
  extra: { assertions?: Array<Record<string, unknown>> } | undefined,
  addAssertionRow: (row: AssertionRow) => void,
): void {
  const methodSel = addDialog.querySelector<HTMLSelectElement>('select[name="api_method"]');
  if (methodSel) methodSel.value = formText(monitorData.method, 'GET');
  const container = document.getElementById('api-assertion-rows')!;
  container.innerHTML = '';
  const assertions = extra?.assertions ?? [];
  if (assertions.length > 0) {
    assertions.forEach((a) =>
      addAssertionRow({
        type: formText(a.type),
        operator: formText(a.operator),
        path: formText(a.path),
        value: formText(a.value),
      }),
    );
  } else {
    addAssertionRow({ type: 'status_code', operator: 'equals', value: '200' });
  }
}

function prefillQaFields(
  addDialog: HTMLElement,
  monitorData: Record<string, unknown>,
  extra: { tests?: Array<Record<string, unknown>> } | undefined,
): void {
  const intInput = addDialog.querySelector<HTMLInputElement>('input[name="interval_seconds"]');
  if (intInput) intInput.value = formText(monitorData.intervalSeconds, '300');
  const scriptArea = addDialog.querySelector<HTMLTextAreaElement>('textarea[name="qa_script"]');
  if (scriptArea && extra?.tests?.[0]) {
    scriptArea.value = formText(extra.tests[0].script);
  }
}

function prefillTcpFields(addDialog: HTMLElement, monitorData: Record<string, unknown>): void {
  setInput(addDialog, 'tcp_host', formText(monitorData.host));
  setInput(addDialog, 'tcp_port', formText(monitorData.port));
  setInput(addDialog, 'tcp_payload_hex', formText(monitorData.payloadHex));
  setInput(addDialog, 'tcp_expect_banner', formText(monitorData.expectBanner));
  setInput(addDialog, 'tcp_interval_seconds', formText(monitorData.intervalSeconds, '60'));
}

function prefillUdpFields(addDialog: HTMLElement, monitorData: Record<string, unknown>): void {
  setInput(addDialog, 'udp_host', formText(monitorData.host));
  setInput(addDialog, 'udp_port', formText(monitorData.port));
  setInput(addDialog, 'udp_payload_hex', formText(monitorData.payloadHex));
  const er = addDialog.querySelector<HTMLInputElement>('input[name="udp_expect_response"]');
  if (er) er.checked = monitorData.expectResponse === true;
  setInput(addDialog, 'udp_interval_seconds', formText(monitorData.intervalSeconds, '60'));
}

function prefillDbFields(addDialog: HTMLElement, monitorData: Record<string, unknown>): void {
  const pr = addDialog.querySelector<HTMLSelectElement>('select[name="db_protocol"]');
  if (pr) pr.value = formText(monitorData.protocol, 'postgres');
  setInput(addDialog, 'db_host', formText(monitorData.host));
  setInput(addDialog, 'db_port', formText(monitorData.port));
  const tl = addDialog.querySelector<HTMLInputElement>('input[name="db_tls"]');
  if (tl) tl.checked = monitorData.tls === true;
  setInput(addDialog, 'db_interval_seconds', formText(monitorData.intervalSeconds, '60'));
}

function prefillTlsFields(addDialog: HTMLElement, monitorData: Record<string, unknown>): void {
  setInput(addDialog, 'tls_host', formText(monitorData.host));
  setInput(addDialog, 'tls_port', formText(monitorData.port, '443'));
  setInput(addDialog, 'tls_servername', formText(monitorData.servername));
  setInput(addDialog, 'tls_warn_days', formText(monitorData.warnDays, '30'));
  setInput(addDialog, 'tls_interval_seconds', formText(monitorData.intervalSeconds, '60'));
  const vc = addDialog.querySelector<HTMLInputElement>('input[name="tls_verify_chain"]');
  if (vc) vc.checked = monitorData.verifyChain === true;
  const vh = addDialog.querySelector<HTMLInputElement>('input[name="tls_verify_hostname"]');
  if (vh) vh.checked = monitorData.verifyHostname === true;
  setInput(addDialog, 'tls_expect_cn_regex', formText(monitorData.expectCnRegex));
}

function prefillHeartbeatFields(
  addDialog: HTMLElement,
  monitorData: Record<string, unknown>,
): void {
  setInput(addDialog, 'hb_period_seconds', formText(monitorData.periodSeconds, '60'));
  setInput(addDialog, 'hb_grace_seconds', formText(monitorData.graceSeconds, '60'));
  const dsc = addDialog.querySelector<HTMLTextAreaElement>('textarea[name="hb_description"]');
  if (dsc) dsc.value = formText(monitorData.description);
}

function setInput(root: HTMLElement, name: string, value: string): void {
  const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (el) el.value = value;
}
