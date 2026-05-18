# Database checks

A `db` monitor answers one question: **is a live database speaking its
protocol on `host:port`?** — for **PostgreSQL**, **MySQL**, or **Redis**.

## What it does (and deliberately doesn't)

It opens a TCP socket and exchanges the minimum bytes to confirm the
server is a real, responding instance of that database:

- **Redis** — sends `PING`, accepts `+PONG` or any error reply.
- **MySQL** — reads the server's initial handshake packet (the server
  speaks first, before auth).
- **PostgreSQL** — sends a minimal `StartupMessage`, accepts the
  authentication challenge or an error response.

It does **not** log in or run a query. No credentials are stored
anywhere. This is _liveness_, the same posture as the TCP/UDP checks
("is it up?"), not _"can my app authenticate and `SELECT`?"_.

### Authentication-required databases work fine

This is the normal case and it correctly reports **UP**. Every supported
database emits its first protocol response _before_ authentication:

- Redis with `requirepass` → replies `-NOAUTH …` (still proves a live redis).
- Postgres requiring md5/scram → replies with the auth **challenge**
  (or an error if the throwaway user/db isn't allowed) — both prove a
  live postgres.
- MySQL → sends its handshake greeting on connect, before any login.

A wrong application password is **not** a database outage, so it
intentionally does not page you. If you need "can my service actually
authenticate and query", that's the deferred authenticated mode below.

## Known limitations

- **TLS-only Redis** (`rediss://`, stunnel, a Redis that accepts _only_
  TLS): the probe speaks plaintext, the server waits for a TLS
  handshake, no protocol reply comes back → the check reports
  **FAILED** even though Redis is up. This is a transport limitation,
  not an auth one. Postgres with `ssl = require` is unaffected (it
  answers a plaintext startup with an error, which still proves it's
  up). Tracked for a follow-up fix.
- **Heuristic acceptance**: a non-database service that coincidentally
  replies with bytes resembling the protocol's opening could
  false-succeed. Same risk class as the TCP/UDP probes; acceptable for
  liveness.

## Future: authenticated mode (not yet shipped)

A later release may add an optional connection string + query
(e.g. `SELECT 1`) for operators who want to verify authenticated
query-ability, not just liveness. It's additive and non-breaking — the
liveness default above stays the default.
