# Alerts

When a monitor's status **transitions**, oo-workers dispatches to every
alert channel bound to it. Trigger model is transition-only: `SUCCESS →
FAILED` fires an **outage**, `FAILED → SUCCESS` fires a **recovery**.
Sustained failure stays quiet (no re-paging every interval); first-ever
runs are silent (nothing to compare against).

## Channels

Create under `#/channels`; bind per-monitor in the **+ Add monitor**
dialog or via `PUT /api/monitors/:type/:id/channels`.

| Type    | `url` field carries       | Notes                                        |
| ------- | ------------------------- | -------------------------------------------- |
| webhook | an `https://` URL         | raw JSON `{event,monitor,status,…}`          |
| discord | a Discord webhook URL     | rich embed                                   |
| slack   | a Slack webhook URL       | Block Kit                                    |
| email   | the **recipient address** | SMTP server is operator env, not per-channel |

**Send test alert** (per channel, or `POST /api/channels/:id/test`)
delivers a synthetic alert so you can confirm wiring before binding it to
anything.

### Email (SMTP)

Email needs the SMTP server configured once via operator env (see
[`.env.example`](../.env.example)): `OO_SMTP_HOST` (required to enable
email at all), `OO_SMTP_PORT` (default 587), `OO_SMTP_SECURE`,
`OO_SMTP_USER`/`OO_SMTP_PASS` (optional), `OO_SMTP_FROM`. Each email
channel only stores its recipient.

## QA / browser monitors

A QA project runs N tests per run, so its alert is a **per-run
aggregate**, not a per-row flip: the run is _down_ if any test
failed/errored, else _up_. The previous run is found by anchoring on the
most recent execution before this run and bucketing that run's rows
within ±30 s (QA tests in a run fire concurrently). Outage/recovery then
dispatch like any other type. (Shipped v1.10.0.)

## Dev: Mailpit

`start-oo-workers.sh` runs a [Mailpit](https://mailpit.axllent.org/)
container — SMTP `:1025`, web UI + API `:8025`. The dev `.env` points
`OO_SMTP_*` at it, so email alerts land in Mailpit instead of a real
inbox; read them at <http://localhost:8025>. With `OO_MAILPIT_API` set,
the dashboard's per-channel **Send test alert** additionally confirms the
mail actually landed ("✓ landed in Mailpit — …") instead of only "SMTP
accepted it". Strictly dev convenience: with `OO_MAILPIT_API` unset (the
default, always in production) the endpoint behaves identically to
before. Mailpit is intentionally **not** in the shipped
`docker-compose*.yml`.

## Testing

- **CI gate** — `scripts/qa-alerting-test.ts` (`bun run test:qa-alerting`,
  in `run-integration.sh` / pre-push). Drives the transition detector
  directly across the full table (first-run / up→down / down→up /
  noop), anti-vacuous.
- **Manual real-path e2e** — `tests/ui/qa-alerting.e2e.spec.ts`
  (`bun run test:ui:e2e:qa-alerting`). Runs a real QA project through
  the worker (run-now → BullMQ → Playwright → aggregation → dispatch)
  and asserts the outage/recovery **emails actually land in Mailpit**,
  plus fires Discord live for visual confirmation. Playwright is
  manual-only by repo policy (not in CI); visibly skips (yellow) if
  Mailpit/auth is unavailable. Requires the dev stack + Mailpit up,
  `OO_MAILPIT_API`, and **`OO_E2E_DISCORD_WEBHOOK`** — Discord is a
  required leg (no read-back API, so it fires live and you verify the
  two embeds by eye); a missing webhook is a hard failure, not a skip.
