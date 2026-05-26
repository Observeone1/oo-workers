# TLS certificate checks (expiry monitoring)

## Using the CLI

```bash
# Expiry-only — alerts when the cert is within 30 days of expiring
obs create tls --name edge-cert --host api.example.com --port 443 --warn-days 30

# Strict chain + hostname verification (rejects self-signed, mismatched SAN)
obs create tls --name strict-cert --host api.example.com --port 443 \
  --warn-days 30 --verify-chain --verify-hostname

# Pin the expected CN/SAN with a regex (catches accidental cert swaps)
obs create tls --name pinned-cert --host api.example.com --port 443 \
  --expect-cn-regex '^api\.example\.com$'
```

The dashboard's `+ Add monitor → TLS` tile covers the same operations.

---

A TLS monitor performs a real TLS handshake to `host:port`, reads the
server's leaf certificate, and **FAILs when it expires within `warnDays`
days** (default **30**). Use it to catch the classic 3am outage: a cert
nobody renewed.

By default it answers _"will TLS still work next month?"_. It can
**also** assert chain trust, hostname, and a CN/SAN regex — all opt-in,
all off unless you turn them on (see **Optional assertions**).

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

## Optional assertions (all off by default)

The handshake always uses `rejectUnauthorized:false` so a self-signed /
internal-CA / hostname-mismatched endpoint still gets its **expiry**
monitored (the self-signed-friendly posture, same as database-TLS).
Beyond expiry you can opt into three **independent** checks — in the
"Advanced TLS assertions" section of the add-monitor dialog, or via the
`verifyChain` / `verifyHostname` / `expectCnRegex` fields on
`POST /api/monitors/tls`:

| Assertion               | FAILs when…                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verify chain**        | the cert does **not** chain to a system-trusted CA. A pure hostname mismatch does NOT trip this — that is the next knob; this is strictly the trust anchor. |
| **Verify hostname**     | the cert is **not** valid for the SNI host (CN/SAN, via `tls.checkServerIdentity`).                                                                         |
| **Expect CN/SAN regex** | neither the leaf CN **nor any DNS SAN** matches the regex.                                                                                                  |

The regex is validated **when you save the monitor** (length-capped,
catastrophic-backtracking shapes and invalid patterns are rejected with
a 400) so a bad pattern can't silently fail every probe forever. With
all three off, behaviour is byte-identical to expiry-only.

## Testing

Guarded by `scripts/tls-cert-test.ts` (`bun run test:tls`), a stage in
`scripts/run-integration.sh` (pre-push + CI). It openssl-generates
self-signed certs (controllable CN/SAN) and stands a throwaway
`tls.createServer`. Anti-vacuous matrix: expiry SUCCESS/FAILED;
`verify_chain` **off→SUCCESS** (the no-regression guard) vs
**on→FAIL** on the same self-signed cert; hostname match vs mismatch;
CN-regex match, no-match, and **match via a DNS SAN** (SAN coverage).
The one inherently-online positive — `verify_chain` on against a
_publicly-trusted_ host → SUCCESS — can't be minted offline, so it is
verified by a real-host check, not this pure gate (stated, not faked).
