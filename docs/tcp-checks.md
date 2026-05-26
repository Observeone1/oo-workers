# TCP checks (with optional banner-grab)

## Using the CLI

```bash
# Bare connect — just measures latency
obs create tcp --name pg-reachable --host db.internal --port 5432

# Send a payload + assert on the response banner (SMTP HELO example)
obs create tcp --name smtp-banner --host mail.example.com --port 25 \
  --payload-hex '48454c4f206f6f2d776f726b6572730d0a' \
  --expect-banner '250-mail.example.com'
```

The dashboard's `+ Add monitor → TCP` tile covers the same operations.

---

A TCP monitor opens a socket to `host:port` and records connect latency.
That answers _"is the port open?"_ — but a port can be open while the
service behind it is the wrong one or unhealthy. Two optional fields turn
it into a _"is the right service actually answering?"_ check:

- **Payload (hex)** — bytes sent immediately on connect, e.g.
  `50494e470d0a` for `PING\r\n`.
- **Expect banner contains** — a substring the server's response must
  contain, else the check is **FAILED**.

Both are optional. Leave them empty and the monitor behaves exactly as
before (pure connect check) — existing monitors are unaffected.

## Examples

| Service | Payload (hex)               | Expect banner | Proves                                  |
| ------- | --------------------------- | ------------- | --------------------------------------- |
| Redis   | `50494e470d0a` (`PING\r\n`) | `PONG`        | Redis is responding, not just listening |
| SSH     | _(none)_                    | `SSH-2.0`     | It's really an SSH daemon               |
| SMTP    | _(none)_                    | `220`         | The MTA greeted                         |
| IMAP    | _(none)_                    | `* OK`        | IMAP is up                              |

SSH/SMTP/IMAP send their banner unprompted, so no payload is needed — just
set the expected substring.

## Behaviour & limits

- The match is a **substring** (case-sensitive), against the **first
  response packet**, capped at **256 bytes** (kept small so the
  high-volume executions table can't be bloated by a chatty server). The
  captured banner is stored on the execution for debugging, truncated to
  the same cap.
- If a payload is sent but no banner arrives within the timeout, the check
  FAILs (`No banner within …ms`). Connection-oriented: sending without a
  reply is treated as a fault.
- **TLS-only ports won't work.** Probing `:443` (or any port that expects
  a TLS handshake first) returns no plaintext banner — the server is
  waiting for the client hello. Use a TLS-certificate monitor for those
  (separate monitor type).
