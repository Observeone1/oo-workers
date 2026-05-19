# TLS certificate checks (expiry monitoring)

A TLS monitor performs a real TLS handshake to `host:port`, reads the
server's leaf certificate, and **FAILs when it expires within `warnDays`
days** (default **30**). Use it to catch the classic 3am outage: a cert
nobody renewed.

It answers _"will TLS still work next month?"_ — not _"is the chain
trusted right now?"_. See **Limits** below.

## Fields

| Field            | Default | Notes                                                                                                                                  |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**         | —       | Required. The hostname (or IP) to connect to.                                                                                          |
| **Port**         | `443`   | TLS port. `443` for HTTPS, `8883` MQTTS, `5671` AMQPS, `993` IMAPS…                                                                    |
| **SNI override** | _host_  | Optional. Send a different SNI than `host` (vhosts behind one IP). Ignored when `host` is a bare IP — `tls.connect` rejects an IP SNI. |
| **Warn days**    | `30`    | FAIL when the cert has this many days or fewer remaining. `0` = only alert once actually expired.                                      |
| **Interval**     | `60`    | Seconds between checks.                                                                                                                |

## What it records

Every run stores `days_remaining`, the cert's `valid_to`, and a
`cert_summary` (`CN=…; issuer=…; valid_to=…`) on the execution, so the
detail view shows exactly how close to the edge each check was.

- `days_remaining > warnDays` → **SUCCESS**.
- `days_remaining <= warnDays` (incl. already-expired, negative) →
  **FAILED**, with `Certificate expires in Nd …` / `Certificate expired
Nd ago …`. The cert is still parsed and recorded so you can see what's
  expiring.
- Handshake failure (refused / DNS / timeout) → **FAILED** cleanly; the
  timeout is a hard backstop, the probe never hangs.

Alerts follow the same status-transition model as every other monitor
type — you get paged once on the SUCCESS→FAILED flip, and once on
recovery, not every interval.

## Limits (deliberate)

`rejectUnauthorized` is **off**. A self-signed, internal-CA, or
hostname-mismatched endpoint still gets its expiry monitored — the same
self-signed-friendly posture as the database-TLS option. Chain validity,
hostname match, and CN-regex assertions are a deliberate **future
follow-up**, not checked here. This monitor is about _expiry_, the failure
mode that actually causes silent outages.

## Testing

Guarded by `scripts/tls-cert-test.ts` (`bun run test:tls`), a stage in
`scripts/run-integration.sh` (pre-push + CI). It openssl-generates a
far-future and an inside-window self-signed cert, stands a throwaway
`tls.createServer`, and asserts SUCCESS vs FAILED — anti-vacuous: a
stuck-SUCCESS probe fails the in-window case.
