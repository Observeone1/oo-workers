import {
  connect as tlsConnect,
  checkServerIdentity,
  type TLSSocket,
  type PeerCertificate,
} from 'node:tls';
import { isIP } from 'node:net';

export interface TlsProbeOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** FAIL when the cert expires within this many days. */
  warnDays: number;
  /** SNI override for vhosts where it differs from host. */
  servername?: string | null;
  // 0018 opt-in assertions — all default OFF (the connection still uses
  // rejectUnauthorized:false so expiry is monitored even on a failing
  // cert; these inspect the result rather than refusing the handshake).
  /** FAIL unless the cert chains to a system-trusted CA. */
  verifyChain?: boolean;
  /** FAIL unless the cert is valid for the SNI host (CN/SAN match). */
  verifyHostname?: boolean;
  /** FAIL unless the leaf CN or any DNS SAN matches this regex. */
  expectCnRegex?: string | null;
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
 * (same self-signed posture as the db-tls work). Chain trust, hostname
 * match, and a CN/SAN regex are now ASSERTABLE but strictly opt-in
 * (0018) — with all three off the behaviour is byte-identical to before:
 * connect, read the cert, check expiry only.
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
      // Opt-in assertions (0018). All off → this is a no-op and the
      // result is identical to the pre-0018 expiry-only behaviour.
      const assertErr = evalTlsAssertions(opts, socket, cert, servername ?? host);
      if (assertErr) {
        finish({
          ok: false,
          latencyMs,
          daysRemaining,
          validTo,
          certSummary,
          errorMessage: `${assertErr} (${host}:${port})`,
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

/** DNS:a.com, DNS:*.b.com, IP Address:1.2.3.4 → ["a.com", "*.b.com"] */
function parseDnsSans(san: string | undefined): string[] {
  if (!san) return [];
  return san
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4));
}

/**
 * Evaluate the opt-in 0018 assertions against the established session.
 * Returns the first failure message, or null if all (enabled) checks
 * pass. `verify_chain` is trust-anchor only: a pure hostname mismatch
 * (ALTNAME) still counts as a trusted chain — hostname is the separate
 * `verify_hostname` knob.
 */
function evalTlsAssertions(
  opts: TlsProbeOptions,
  socket: TLSSocket,
  cert: PeerCertificate,
  hostForId: string,
): string | null {
  if (opts.verifyChain) {
    const ae = socket.authorizationError as unknown;
    const aeCode = ae && typeof ae === 'object' ? (ae as NodeJS.ErrnoException).code : undefined;
    const aeMsg = ae instanceof Error ? ae.message : ae ? String(ae) : 'unauthorized';
    const chainTrusted = socket.authorized || aeCode === 'ERR_TLS_CERT_ALTNAME_INVALID';
    if (!chainTrusted) return `Certificate chain not trusted: ${aeMsg}`;
  }

  if (opts.verifyHostname) {
    const idErr = checkServerIdentity(hostForId, cert);
    if (idErr) return `Certificate not valid for ${hostForId}: ${idErr.message}`;
  }

  if (opts.expectCnRegex) {
    let re: RegExp;
    try {
      re = new RegExp(opts.expectCnRegex);
    } catch (e) {
      // Endpoint validates at save; this is only a backstop.
      return `Invalid expect_cn_regex: ${e instanceof Error ? e.message : String(e)}`;
    }
    const cn = cert.subject?.CN;
    const sans = parseDnsSans(cert.subjectaltname);
    const targets = [cn, ...sans].filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (!targets.some((t) => re.test(t))) {
      return `No CN/SAN matches /${opts.expectCnRegex}/ (CN=${cn ?? '?'}; SAN=${
        sans.join(',') || 'none'
      })`;
    }
  }

  return null;
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
