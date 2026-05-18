import { createConnection, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Credential-free database liveness. Opens a TCP socket and confirms the
 * server *speaks the protocol* — not that you can run authenticated
 * queries. Same posture as the tcp/udp probes ("is it up?"), so no
 * credentials are stored anywhere.
 *
 *   redis    — send `PING`; a `+PONG` or any `-` reply (incl. `-NOAUTH`)
 *              proves a live redis.
 *   mysql    — the server sends its handshake packet unprompted; a valid
 *              protocol byte (0x0a/0x09) or an ERR packet (0xff) proves
 *              a live mysql.
 *   postgres — send a minimal StartupMessage; an Authentication (`R`) or
 *              ErrorResponse (`E`) proves a live postgres accepting
 *              connections (an auth/db error still means it's up).
 *
 * A future optional dsn/query column could add an authenticated mode
 * without changing this default.
 */

export type DbProtocol = 'postgres' | 'mysql' | 'redis';

export interface DbProbeOptions {
  host: string;
  port: number;
  protocol: DbProtocol;
  timeoutMs: number;
  /** Wrap the socket in TLS before the liveness exchange (rediss://,
   *  stunnel-wrapped pg/mysql). Liveness only — cert not validated. */
  tls?: boolean;
}

export interface DbProbeResult {
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

// Minimal Postgres StartupMessage: Int32 length, Int32 protocol (3.0),
// then "user\0<name>\0" key/value pairs, terminated by a final \0.
function pgStartup(): Buffer {
  const params = Buffer.from('user\0liveness\0\0', 'latin1');
  const buf = Buffer.alloc(8 + params.length);
  buf.writeInt32BE(buf.length, 0);
  buf.writeInt32BE(196608, 4); // protocol 3.0
  params.copy(buf, 8);
  return buf;
}

function speaksProtocol(protocol: DbProtocol, buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (protocol === 'redis') {
    return buf[0] === 0x2b /* + */ || buf[0] === 0x2d /* - */;
  }
  if (protocol === 'mysql') {
    // 4-byte packet header, then payload[0]: 0x0a/0x09 = handshake
    // protocol version, 0xff = ERR packet (still a live mysql).
    return buf.length >= 5 && (buf[4] === 0x0a || buf[4] === 0x09 || buf[4] === 0xff);
  }
  // postgres: 'R' (Authentication) or 'E' (ErrorResponse)
  return buf[0] === 0x52 || buf[0] === 0x45;
}

function mapErr(err: NodeJS.ErrnoException, o: DbProbeOptions): string {
  const at = `${o.host}:${o.port}`;
  switch (err.code) {
    case 'ECONNREFUSED':
      return `connection refused (${at}) — nothing listening`;
    case 'ETIMEDOUT':
      return `connect timed out (${at})`;
    case 'ENOTFOUND':
      return `DNS resolution failed: host not found (${o.host})`;
    case 'EHOSTUNREACH':
      return `host unreachable (${o.host})`;
    case 'ENETUNREACH':
      return `network unreachable (${o.host})`;
    default:
      return err.message ?? 'unknown socket error';
  }
}

export function dbProbe(opts: DbProbeOptions): Promise<DbProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let socket: Socket | null = null;

    const finish = (result: DbProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      resolve(result);
    };
    const fail = (msg: string) =>
      finish({ ok: false, latencyMs: Date.now() - start, errorMessage: msg });

    const timer = setTimeout(
      () =>
        fail(`timed out after ${opts.timeoutMs}ms (${opts.protocol} ${opts.host}:${opts.port})`),
      opts.timeoutMs,
    );

    // tls.connect returns a TLSSocket (a net.Socket subclass — typing +
    // error/close/data/timeout lifecycle unchanged) but signals readiness
    // via 'secureConnect' (post-handshake), not 'connect'. One const keeps
    // the swap minimal and prevents double-registering.
    const connectEvent = opts.tls ? 'secureConnect' : 'connect';
    socket = opts.tls
      ? tlsConnect({
          host: opts.host,
          port: opts.port,
          // SNI only for hostnames — tls.connect THROWS if servername is an
          // IP, and DB monitors are usually IP-addressed.
          servername: isIP(opts.host) ? undefined : opts.host,
          // Liveness, not cert validation (consistent with the project's
          // documented self-signed-TLS posture). A handshake failure still
          // emits 'error' → clean FAILED via the handler below.
          rejectUnauthorized: false,
        })
      : createConnection({ host: opts.host, port: opts.port });
    socket.on('error', (e: NodeJS.ErrnoException) => fail(mapErr(e, opts)));
    socket.on('close', () => {
      // A server that accepts then drops the connection without ever
      // speaking the protocol is not a healthy DB endpoint.
      if (!settled) fail(`closed before a ${opts.protocol} response (${opts.host}:${opts.port})`);
    });
    socket.once(connectEvent, () => {
      if (opts.protocol === 'redis') socket?.write('PING\r\n');
      else if (opts.protocol === 'postgres') socket?.write(pgStartup());
      // mysql: server speaks first — send nothing.
    });
    // First chunk is enough to decide — every protocol's opening bytes
    // (redis +/-, mysql handshake header, postgres R/E) land in packet one.
    socket.once('data', (buf: Buffer) => {
      if (settled) return;
      if (speaksProtocol(opts.protocol, buf)) {
        finish({ ok: true, latencyMs: Date.now() - start });
      } else {
        fail(`response did not look like ${opts.protocol} (${opts.host}:${opts.port})`);
      }
    });
  });
}
