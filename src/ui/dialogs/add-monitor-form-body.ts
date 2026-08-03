import type { MonType } from '../types';
import { formText } from '../helpers';

export type MonitorFormBodyResult = { ok: true; body: unknown } | { ok: false; message: string };

function collectApiAssertionsFromDialog(
  dialogRoot: HTMLElement,
): Array<{ type: string; operator: string; path?: string; value?: string }> {
  const rows = dialogRoot.querySelectorAll<HTMLElement>('#api-assertion-rows .assertion-row');
  const assertions: Array<{ type: string; operator: string; path?: string; value?: string }> = [];
  for (const row of rows) {
    const t = row.querySelector<HTMLSelectElement>('[data-field="type"]')?.value ?? '';
    const op = row.querySelector<HTMLSelectElement>('[data-field="operator"]')?.value ?? '';
    const path = row.querySelector<HTMLInputElement>('[data-field="path"]')?.value.trim() ?? '';
    const value = row.querySelector<HTMLInputElement>('[data-field="value"]')?.value.trim() ?? '';
    if (!t || !op) continue;
    const entry: { type: string; operator: string; path?: string; value?: string } = {
      type: t,
      operator: op,
    };
    if (path) entry.path = path;
    if (value) entry.value = value;
    assertions.push(entry);
  }
  return assertions;
}

function requireHostPort(
  host: string,
  port: number,
  message = 'Host + port (1–65535) required',
): MonitorFormBodyResult | null {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message };
  }
  return null;
}

export function buildMonitorBodyFromForm(
  type: MonType,
  fd: FormData,
  dialogRoot: HTMLElement,
): MonitorFormBodyResult {
  const name = fd.get('name') as string;
  const url = fd.get('url') as string;
  const intervalSeconds = Number(fd.get('interval_seconds'));

  if (type === 'url') {
    if (!url) return { ok: false, message: 'URL is required' };
    return {
      ok: true,
      body: {
        name,
        url,
        intervalSeconds,
        timeoutMs: (Number(fd.get('url_timeout')) || 10) * 1000,
        assertions: [{ operator: 'equals', statusCode: Number(fd.get('url_status') || 200) }],
      },
    };
  }

  if (type === 'api') {
    if (!url) return { ok: false, message: 'URL is required' };
    return {
      ok: true,
      body: {
        name,
        url,
        method: fd.get('api_method'),
        intervalSeconds,
        assertions: collectApiAssertionsFromDialog(dialogRoot),
      },
    };
  }

  if (type === 'qa') {
    if (!url) return { ok: false, message: 'Target URL is required' };
    return {
      ok: true,
      body: {
        name,
        targetUrl: url,
        intervalSeconds,
        tests: [{ name: name.replaceAll(/\s+/g, '_'), script: fd.get('qa_script') }],
      },
    };
  }

  if (type === 'tcp') {
    const host = formText(fd.get('tcp_host')).trim();
    const port = Number(fd.get('tcp_port'));
    const hostErr = requireHostPort(host, port);
    if (hostErr) return hostErr;
    const tcpPayloadHex = formText(fd.get('tcp_payload_hex')).trim();
    const tcpExpectBanner = formText(fd.get('tcp_expect_banner')).trim();
    return {
      ok: true,
      body: {
        name,
        host,
        port,
        payloadHex: tcpPayloadHex || null,
        expectBanner: tcpExpectBanner || null,
        intervalSeconds: Number(fd.get('tcp_interval_seconds')) || 60,
        timeoutMs: (Number(fd.get('tcp_timeout')) || 5) * 1000,
      },
    };
  }

  if (type === 'db') {
    const host = formText(fd.get('db_host')).trim();
    const port = Number(fd.get('db_port'));
    const protocol = formText(fd.get('db_protocol'));
    const hostErr = requireHostPort(host, port);
    if (hostErr) return hostErr;
    if (protocol !== 'postgres' && protocol !== 'mysql' && protocol !== 'redis') {
      return { ok: false, message: 'Pick a database protocol' };
    }
    return {
      ok: true,
      body: {
        name,
        protocol,
        host,
        port,
        tls: fd.get('db_tls') === 'on',
        intervalSeconds: Number(fd.get('db_interval_seconds')) || 60,
      },
    };
  }

  if (type === 'tls') {
    const host = formText(fd.get('tls_host')).trim();
    const port = Number(fd.get('tls_port') || 443);
    const hostErr = requireHostPort(host, port);
    if (hostErr) return hostErr;
    const warnDays = Number(fd.get('tls_warn_days') || 30);
    if (!Number.isInteger(warnDays) || warnDays < 0) {
      return { ok: false, message: 'Warn days must be a non-negative integer' };
    }
    const servername = formText(fd.get('tls_servername')).trim();
    const expectCnRegex = formText(fd.get('tls_expect_cn_regex')).trim();
    return {
      ok: true,
      body: {
        name,
        host,
        port,
        servername: servername || null,
        warnDays,
        intervalSeconds: Number(fd.get('tls_interval_seconds')) || 60,
        verifyChain: fd.get('tls_verify_chain') === 'on',
        verifyHostname: fd.get('tls_verify_hostname') === 'on',
        expectCnRegex: expectCnRegex || null,
      },
    };
  }

  if (type === 'heartbeat') {
    const period = Number(fd.get('hb_period_seconds'));
    if (!Number.isFinite(period) || period < 30) {
      return { ok: false, message: 'Expected period must be a number ≥ 30 seconds' };
    }
    const grace = Number(fd.get('hb_grace_seconds') || 60);
    if (!Number.isFinite(grace) || grace < 0) {
      return { ok: false, message: 'Grace must be a non-negative number' };
    }
    return {
      ok: true,
      body: {
        name,
        periodSeconds: period,
        graceSeconds: grace,
        description: formText(fd.get('hb_description')).trim() || null,
      },
    };
  }

  const host = formText(fd.get('udp_host')).trim();
  const port = Number(fd.get('udp_port'));
  const hostErr = requireHostPort(host, port);
  if (hostErr) return hostErr;
  const payloadHex = formText(fd.get('udp_payload_hex')).trim();
  return {
    ok: true,
    body: {
      name,
      host,
      port,
      payloadHex: payloadHex || null,
      expectResponse: fd.get('udp_expect_response') === 'on',
      intervalSeconds: Number(fd.get('udp_interval_seconds')) || 60,
    },
  };
}
