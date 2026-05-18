import { createSocket, type SocketType } from 'node:dgram';
import { lookup } from 'node:dns';

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
 * `expectResponse=true` we wait up to `timeoutMs` for a datagram **from
 * the probe target**.
 *
 * The host is resolved up front so we can (1) pick the right socket
 * family for IPv6 targets instead of hardcoding `udp4`, and (2) reject
 * datagrams whose source isn't the target — an unrelated UDP service or
 * a spoofed packet hitting our ephemeral source port would otherwise be
 * counted as a false success.
 */
export function udpProbe(opts: UdpProbeOptions): Promise<UdpProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let socket: ReturnType<typeof createSocket> | null = null;

    const finish = (result: UdpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve(result);
    };

    // One budget covering DNS + send + (optional) response wait.
    const timer = setTimeout(() => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        errorMessage: opts.expectResponse
          ? `No response within ${opts.timeoutMs}ms (${opts.host}:${opts.port})`
          : `send timed out after ${opts.timeoutMs}ms (${opts.host}:${opts.port})`,
      });
    }, opts.timeoutMs);

    // Strip brackets so an IPv6 literal pasted as `[2001:db8::1]` resolves.
    const hostname = opts.host.replace(/^\[|\]$/g, '');
    lookup(hostname, { all: true }, (err, addresses) => {
      if (settled) return;
      if (err || addresses.length === 0) {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          errorMessage: mapSocketError(
            (err as NodeJS.ErrnoException) ?? ({ code: 'ENOTFOUND' } as NodeJS.ErrnoException),
            opts.host,
            opts.port,
          ),
        });
        return;
      }

      const target = addresses[0];
      const validSources = new Set(addresses.map((a) => a.address));
      const type: SocketType = target.family === 6 ? 'udp6' : 'udp4';
      socket = createSocket(type);

      socket.on('error', (e: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          errorMessage: mapSocketError(e, opts.host, opts.port),
        });
      });

      if (opts.expectResponse) {
        socket.on('message', (msg, rinfo) => {
          // Count only a datagram from the exact target host:port. UDP
          // services reply from the port they received on (DNS:53,
          // NTP:123, …); anything else is unrelated traffic or a spoof
          // landing on our ephemeral source port — keep waiting.
          if (rinfo.port !== opts.port || !validSources.has(rinfo.address)) return;
          finish({ ok: true, latencyMs: Date.now() - start, responseBytes: msg.length });
        });
      }

      const payload = opts.payload ?? Buffer.alloc(0);
      // Send to the resolved IP (not the hostname) so the socket family
      // matches and the expected source address is known.
      socket.send(payload, opts.port, target.address, (sendErr) => {
        if (settled) return;
        if (sendErr) {
          finish({
            ok: false,
            latencyMs: Date.now() - start,
            errorMessage: mapSocketError(sendErr as NodeJS.ErrnoException, opts.host, opts.port),
          });
          return;
        }
        if (!opts.expectResponse) {
          finish({ ok: true, latencyMs: Date.now() - start });
        }
      });
    });
  });
}

function mapSocketError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `DNS resolution failed: Host not found (${host})`;
    case 'EAI_AGAIN':
      return `DNS resolution failed: temporary failure (${host})`;
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
