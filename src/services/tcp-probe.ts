import { Socket } from 'node:net';

export interface TcpProbeResult {
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Open a TCP socket to host:port and measure the time until 'connect'.
 * Resolves with `{ ok: false, errorMessage }` on timeout or socket error —
 * doesn't throw, so the processor doesn't have to wrap in try/catch.
 */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new Socket();
    let settled = false;

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
      finish({ ok: true, latencyMs: Date.now() - start });
    });
    socket.once('timeout', () => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: `Connection timed out after ${timeoutMs}ms (${host}:${port})`,
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
