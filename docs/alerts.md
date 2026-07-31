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
failed/errored, else _up_. Runs are grouped by a `qa_runs` row, and the
previous run is the most recent completed `qa_runs` row for the same
`(project, region)` — a region compares only against its own history, a
master run (`region_id NULL`) only against master runs. Outage/recovery
then dispatch like any other type. (Shipped v1.10.0; `qa_runs` grouping
replaced the original ±30 s execution bucketing.)

The aggregate is computed by whoever finishes the run — the processor
for a master run, `agent-dispatch` once every expected test has reported
for a region run — and claimed exactly once via `claimRunAlert`.

### Runs that never finish

A run only alerts if something computes its aggregate. If the worker or
a region agent dies mid-run, nothing does: `qa_runs.outcome` stays NULL,
`claimRunAlert` is never called, and the failing browser check is
**completely silent** — the run is even invisible to the next run's
previous-outcome lookup, which skips NULL-outcome rows.

Two backstops close that hole:

- **Crash path.** If the processor throws before aggregating, it claims
  the run as `FAILED` on the way out and dispatches immediately, so an
  aborted run pages you now rather than on the next sweep.
- **Abandoned-run sweep.** The scheduler ticks `tickAbandonedQaRuns`
  alongside the heartbeat sweep. Any run still without an outcome
  `QA_RUN_ABANDONED_MS` (default 15 min) after it started is marked
  `FAILED` through the same one-shot `claimRunAlert` guard, its stranded
  executions are closed out as `error` (so the detail page stops showing
  them "running"), and the normal transition alert fires with an
  `errorMessage` naming the cause ("run abandoned — 2 of 3 test(s) never
  reported within 18m…") so an operator can tell a dead run from a
  genuine test failure.

Alert semantics are unchanged: this only supplies the missing verdict.
An abandoned run after a green one fires an outage; after an
already-failing one it stays quiet; and because the run now carries a
verdict, the next green run fires the recovery it previously couldn't.

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

- **CI gate** — `tests/integration/qa-alerting.it.spec.ts`, run by
  `bun run test:integration`. Drives the transition detector directly across the
  full table (first-run / up→down / down→up / noop), asserts per-region
  scoping and `claimRunAlert` idempotency, and covers the abandoned-run
  sweep end to end (swept → outage with cause, idempotent second pass,
  in-flight run untouched, quiet after an already-failing run, recovery
  on the next green run). Anti-vacuous — every case asserts on a real
  webhook delivery.
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
