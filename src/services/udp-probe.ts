import { createSocket } from 'node:dgram';

export interface UdpProbeOptions {
  host: string;
  port: number;
  /** Bytes to send. `null` = empty datagram. */
  payload: Buffer | null;
  /** If true, the run only succeeds when a response is received within `timeoutMs`. */
  expectResponse: boolean;
  timeoutMs: number;
}

export interface UdpProbeResult {
  ok: boolean;
  latencyMs: number;
  responseBytes?: number;
  errorMessage?: string;
}

/**
 * Send a UDP datagram and optionally await a response.
 *
 * UDP is connectionless — there's no "did the server receive it" feedback
 * unless the server replies. So when `expectResponse=false` we treat
 * "the send() callback fired without error" as success; when
 * `expectResponse=true` we wait up to `timeoutMs` for any datagram from
 * the same address.
 */
export function udpProbe(opts: UdpProbeOptions): Promise<UdpProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createSocket('udp4');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: UdpProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: mapSocketError(err, opts.host, opts.port),
      });
    });

    if (opts.expectResponse) {
      socket.on('message', (msg) => {
        finish({ ok: true, latencyMs: Date.now() - start, responseBytes: msg.length });
      });
      timer = setTimeout(() => {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          errorMessage: `No response within ${opts.timeoutMs}ms (${opts.host}:${opts.port})`,
        });
      }, opts.timeoutMs);
    } else {
      // Generic guard so a stuck DNS lookup or kernel-buffer issue can't hang us.
      timer = setTimeout(() => {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          errorMessage: `send timed out after ${opts.timeoutMs}ms (${opts.host}:${opts.port})`,
        });
      }, opts.timeoutMs);
    }

    const payload = opts.payload ?? Buffer.alloc(0);
    socket.send(payload, opts.port, opts.host, (err) => {
      if (err) {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          errorMessage: mapSocketError(err as NodeJS.ErrnoException, opts.host, opts.port),
        });
        return;
      }
      if (!opts.expectResponse) {
        finish({ ok: true, latencyMs: Date.now() - start });
      }
    });
  });
}

function mapSocketError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `DNS resolution failed: Host not found (${host})`;
    case 'EHOSTUNREACH':
      return `Host unreachable (${host})`;
    case 'ENETUNREACH':
      return `Network unreachable (${host})`;
    case 'EACCES':
      return `Permission denied sending to ${host}:${port} (port likely privileged)`;
    default:
      return err.message ?? 'Unknown socket error';
  }
}

/** Parse a hex string like "deadbeef" or "DE AD BE EF" into a Buffer. */
export function parseHexPayload(hex: string | null | undefined): Buffer | null {
  if (!hex) return null;
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length === 0) return null;
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('payload_hex must be an even-length string of hex characters');
  }
  return Buffer.from(clean, 'hex');
}
