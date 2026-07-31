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

### Our failures are not the target's downtime

**Policy: alert channels fire only on a verdict about the monitored
target.** A failure of oo-workers' own execution machinery — a killed
worker, a dead region agent, Playwright failing to launch — is recorded
and logged for whoever operates the fleet, but never paged to the
monitor's owner. They cannot act on it, and a page they cannot act on
trains them to ignore the ones they can.

### Runs that never finish

A run only reaches an outcome if something computes its aggregate. If the
worker or a region agent dies mid-run, nothing does, and the row rots:
`qa_runs.outcome` stays NULL forever, so the previous-run lookup skips it,
and its executions keep claiming to be `running`.

Two paths finalize those rows:

- **Crash path.** If the processor throws before aggregating, it finalizes
  the run on the way out rather than leaving it for the sweep 15 minutes
  later. Best-effort — if the finalize fails too it is logged, and the
  original error still propagates.
- **Abandoned-run sweep.** The scheduler ticks `tickAbandonedQaRuns`
  alongside the heartbeat sweep. Any run still without an outcome
  `QA_RUN_ABANDONED_MS` (default 15 min) after it started is recorded as
  `ABANDONED` through the same one-shot `claimRunAlert` guard, and its
  stranded executions are stamped `abandoned` so the detail page stops
  showing them "running".

Neither dispatches. `ABANDONED` is deliberately **not** in
`QA_RUN_VERDICTS` (`SUCCESS`/`FAILED`), and the previous-run lookup filters
on that set rather than on `outcome IS NOT NULL`. So an abandoned run is
invisible to the transition detector in both directions:

| Sequence                      | Result                              |
| ----------------------------- | ----------------------------------- |
| SUCCESS → ABANDONED           | silent (logged only)                |
| SUCCESS → ABANDONED → FAILED  | outage — compares past the dead run |
| FAILED → ABANDONED → SUCCESS  | recovery — same, other direction    |
| SUCCESS → ABANDONED → SUCCESS | silent                              |

That filter is load-bearing. Were it merely `outcome IS NOT NULL`, the run
after an abandoned one would find a predecessor that normalizes to
`'other'`, bail early, and **QA alerting would go permanently silent from
the first abandoned run onward** — strictly worse than the rotting NULL row
it replaced.

The stranded executions use `abandoned` rather than `error` for the same
reason: `error` counts as _down_ for status-page bars and uptime maths, so
a dead worker of ours would show up as the customer's outage on their
public status page. `abandoned` sits outside both the up and down sets,
exactly as the `running` these rows previously kept forever did — status
pages and uptime are unaffected.

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
  sweep end to end (recorded `ABANDONED` and not paged, stranded execution
  stamped outside the down vocabulary, idempotent second pass, in-flight run
  untouched, and the three transition sequences in the table above) plus the
  processor's crash paths (alert survives a failing `touchLastRunAt`; a run
  that throws before aggregating is recorded not paged; a finalize that
  itself fails doesn't mask the original error, and a scratch-dir cleanup
  failure doesn't eat a real verdict). Anti-vacuity: most sweep cases assert
  _silence_, which would also pass against a dead webhook binding — so
  several of them go on to drive a real failing run and assert a hook **does**
  arrive on the same channel. The whole file shares one `beforeAll` fixture
  and binding, so those cases cover their silent siblings.
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
