import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';

export interface TlsProbeOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** FAIL when the cert expires within this many days. */
  warnDays: number;
  /** SNI override for vhosts where it differs from host. */
  servername?: string | null;
}

export interface TlsProbeResult {
  ok: boolean;
  latencyMs: number;
  daysRemaining?: number;
  validTo?: Date;
  /** "CN=…; issuer=…; valid_to=…" for the detail view. */
  certSummary?: string;
  errorMessage?: string;
}

/**
 * TLS-handshake + certificate-expiry check.
 *
 * `rejectUnauthorized:false` on purpose: a self-signed / internal-CA /
 * hostname-mismatched endpoint should still get its expiry monitored
 * (same self-signed posture as the db-tls work). Chain/hostname validity
 * and CN-regex are a deliberate future follow-up, not asserted here.
 *
 * SNI is the optional `servername`, else `host` — but never an IP:
 * `tls.connect({ servername:<ip> })` throws synchronously (the db-tls
 * ship-blocker lesson). Never throws; timeout is the backstop.
 */
export function tlsProbe(opts: TlsProbeOptions): Promise<TlsProbeResult> {
  const { host, port, timeoutMs, warnDays } = opts;
  const sniRaw = opts.servername || host;
  const servername = isIP(sniRaw) ? undefined : sniRaw;

  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;

    const socket = tlsConnect({ host, port, servername, rejectUnauthorized: false });

    const finish = (r: TlsProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
      resolve(r);
    };

    socket.setTimeout(timeoutMs);

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const latencyMs = Date.now() - start;
      if (!cert || !cert.valid_to) {
        finish({ ok: false, latencyMs, errorMessage: `No peer certificate (${host}:${port})` });
        return;
      }
      const validTo = new Date(cert.valid_to);
      const cn = cert.subject?.CN ?? '?';
      const issuer = cert.issuer?.CN ?? '?';
      const certSummary = `CN=${cn}; issuer=${issuer}; valid_to=${cert.valid_to}`;
      if (Number.isNaN(validTo.getTime())) {
        finish({
          ok: false,
          latencyMs,
          certSummary,
          errorMessage: `Unparseable certificate validity (${host}:${port})`,
        });
        return;
      }
      const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      if (daysRemaining <= warnDays) {
        finish({
          ok: false,
          latencyMs,
          daysRemaining,
          validTo,
          certSummary,
          errorMessage:
            daysRemaining < 0
              ? `Certificate expired ${-daysRemaining}d ago (${host}:${port})`
              : `Certificate expires in ${daysRemaining}d (≤ warn ${warnDays}d) (${host}:${port})`,
        });
        return;
      }
      finish({ ok: true, latencyMs, daysRemaining, validTo, certSummary });
    });

    socket.once('timeout', () => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: `TLS handshake timed out after ${timeoutMs}ms (${host}:${port})`,
      });
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: mapTlsError(err, host, port),
      });
    });
  });
}

function mapTlsError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `DNS resolution failed: Host not found (${host})`;
    case 'ECONNREFUSED':
      return `Connection refused (${host}:${port})`;
    case 'ETIMEDOUT':
      return `Connection timed out (${host}:${port})`;
    case 'EHOSTUNREACH':
      return `Host unreachable (${host})`;
    case 'ENETUNREACH':
      return `Network unreachable (${host})`;
    default:
      return err.message ?? 'TLS handshake error';
  }
}
