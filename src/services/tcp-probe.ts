import { Socket } from 'node:net';

// SSH/SMTP/Redis/IMAP banners are tens of bytes. Cap what we capture and
// store so a server that replies with a huge page can't bloat the
// high-volume tcp_executions table. The match runs against this cap.
const BANNER_CAP = 256;

export interface TcpProbeOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Optional bytes to send immediately on connect. */
  payload?: Buffer | null;
  /** Substring the response must contain, else the check FAILs. */
  expectBanner?: string | null;
}

export interface TcpProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Truncated (<=256 B) printable snapshot of the server's response. */
  banner?: string;
  errorMessage?: string;
}

/**
 * Open a TCP socket to host:port and measure connect latency.
 *
 * TCP collapses UDP's separate `expectResponse` flag: if there's either a
 * payload to send or an `expectBanner` to match, we wait for the server's
 * response (the connect timeout is the backstop), capture the first
 * <=256 bytes, and — when `expectBanner` is set — FAIL unless that snapshot
 * contains it. With neither, we close on 'connect' exactly as before: pure
 * connect-latency, zero behavior change for existing monitors. The match is
 * against the first response packet only (fine for real banners).
 *
 * Never throws — resolves `{ ok:false, errorMessage }` on timeout/error so
 * the processor doesn't have to wrap in try/catch.
 */
export function tcpProbe(opts: TcpProbeOptions): Promise<TcpProbeResult> {
  const { host, port, timeoutMs, payload = null, expectBanner = null } = opts;
  const wantBanner = !!payload || !!expectBanner;
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new Socket();
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;

    const finish = (result: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      if (!wantBanner) {
        finish({ ok: true, latencyMs: Date.now() - start });
        return;
      }
      if (payload) socket.write(payload);
      // Otherwise wait for 'data'; 'timeout' is the backstop.
    });

    socket.on('data', (d: Buffer) => {
      const room = BANNER_CAP - received;
      if (room > 0) {
        chunks.push(d.subarray(0, room));
        received += Math.min(d.length, room);
      }
      const banner = Buffer.concat(chunks).toString('utf8');
      if (expectBanner && !banner.includes(expectBanner)) {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          banner,
          errorMessage: `Banner did not contain expected text (${host}:${port})`,
        });
        return;
      }
      finish({ ok: true, latencyMs: Date.now() - start, banner });
    });

    socket.once('timeout', () => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: wantBanner
          ? `No banner within ${timeoutMs}ms (${host}:${port})`
          : `Connection timed out after ${timeoutMs}ms (${host}:${port})`,
      });
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: mapSocketError(err, host, port),
      });
    });

    socket.connect(port, host);
  });
}

function mapSocketError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `DNS resolution failed: Host not found (${host})`;
    case 'ECONNREFUSED':
      return `Connection refused: Target machine actively refused it (${host}:${port})`;
    case 'ETIMEDOUT':
      return `Connection timed out (${host}:${port})`;
    case 'EHOSTUNREACH':
      return `Host unreachable (${host})`;
    case 'ENETUNREACH':
      return `Network unreachable (${host})`;
    default:
      return err.message ?? 'Unknown socket error';
  }
}
