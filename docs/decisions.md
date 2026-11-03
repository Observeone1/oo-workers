# Build-vs-buy decisions

oo-workers does a lot with a small dependency list. This file records the
places where a commodity component could have been pulled in instead, why it
wasn't, and what the choice costs. It exists so the next reader can challenge
the decision instead of rediscovering it, and so the cost is written down
somewhere rather than carried silently.

The governing constraint: this is a **self-hosted, single-binary-ish** stack
an operator runs with `docker compose up` and expects to keep running. A
dependency that needs a second database, a license that a corporate policy
bans, or a network call to a vendor is not free.

## Hand-rolled Sig-V4 request signing

`src/services/object-storage-signing.ts` (~150 lines) implements the AWS
Signature V4 algorithm rather than using `@aws-sdk/client-s3`.

**Why:** the AWS SDK v3 is ~10 MB of JS plus a credential-provider chain, and
it would drag in the full S3 surface when oo-workers needs four operations
(`getObject`, `putObject`, `putObjectStream`, `listObjectsV2`). The signing is
the only genuinely fiddly part and it is small enough to read in one sitting.

**What it costs:**

- Credential-scope and canonical-request bugs are ours to own. A wrong
  signature produces a 403 that looks like a wrong key, which is a miserable
  thing to debug in someone else's deployment.
- The list-pagination parser (`listObjectsWithSize`,
  `src/services/object-storage.ts:352`) reads the XML response with a regex
  rather than an XML parser. Fine against AWS and RustFS; the most likely
  break point against a third-party S3 implementation that orders or escapes
  `<Key>`/`<Size>` differently.
- Spec drift is ours. AWS has extended signing to more service regions over
  time and we do not track that.

**If this becomes a problem:** the seam is `signedFetchRaw`
(`object-storage-signing.ts:136`, `__setSignedFetchRawImpl`) — one function pointer.
The unit specs substitute it via `src/test-support/object-storage-mock-helpers.ts`;
the integration and UI tiers deliberately sign for real against the bundled RustFS,
so those exercise the signer itself end to end rather than a stand-in.

## Hand-rolled Postgres / MySQL / Redis liveness probes

`src/services/db-probe.ts` speaks the opening bytes of each protocol directly
instead of linking `pg`, `mysql2` and `ioredis`.

**Why:** a DB check answers "is this server up?", not "query it". Authenticating
would mean storing credentials, which is a different and much larger product
surface (secret management, per-monitor credential rotation, redaction in
error text). Speaking the first round-trip is enough to answer the question
the monitor asks, and needs no stored secret.

**What it costs:** acceptance is a **heuristic**. A non-database service that
happens to reply with bytes resembling the protocol's opening can false-succeed
— documented in `db-checks.md`. It also means we do not track upstream
protocol changes (Postgres auth-flow revisions, MySQL deprecations) because
we never authenticate. Redis is the most robust of the three: any reply
(`+`, `-`, `:`) proves liveness.

## Hand-rolled backup format

The dump is gzipped NDJSON with a manifest line, or a tar.gz envelope when
artifacts are included. `pg_dump` was not used.

**Why:** `pg_dump` is version-coupled to the server it targets and its output
format is a moving target across major versions. The dump here is explicitly
versioned (`BACKUP_FORMAT = 1`) and guarded by a `schemaHead` check, so a
restore refuses rather than half-applying a dump taken on a different schema.
That check is only possible because we own the format.

**What it costs:** correctness of the FK-safe table order is ours to maintain
(`TABLES` in `backup-shared.ts:80` — "do not reorder without re-checking
schema.ts"), and a mistake there fails the restore rather than degrading it.

## `jsonpath` for API assertions, with a paren guard

`src/services/api-assertion.ts` uses the `jsonpath` package and rejects any
path containing `(` or `)` before it reaches the library.

**Why:** `jsonpath` evaluates script/filter expressions (`$[(...)]`,
`$[?(...)]`) through `static-eval`, which is arbitrary code execution
(CVE-2026-1615). `assertion.path` is a freeform, user-editable field, so the
package cannot be used raw. The two vulnerable syntaxes both require
parentheses, so rejecting parens closes the eval path while leaving ordinary
dot/bracket/wildcard/slice/union JSONPath working.

**What it costs:** the guard is a regex, which means the security boundary is
one line of code that a well-meaning "let me also allow `$[0]` filter
expressions" change could reopen. That is why `api-assertion.unit.spec.ts`
asserts both directions: parens rejected anywhere in the path, and the
non-parenthesized syntax that users rely on still working. If a future
`jsonpath` release drops `static-eval`, the guard can be deleted — but until
then it is load-bearing, not belt-and-braces.

## RustFS as the bundled object store

**Why:** the three alternatives were all AGPL-3.0, which a corporate policy
banning copyleft cannot accept even when shipped unmodified. RustFS is
Apache-2.0, so the whole stack stays permissive. `README.md` has the full
picking history.

**What it costs:** it is a young project with a far smaller user base and
release history than MinIO had, and the bundled stack is pinned to its release
cadence. The S3 surface is not only RustFS's either — the hand-rolled list
parser above is the fragile part, and the CI suite only exercises RustFS. Operators
who want a different posture point `OO_OBJECT_STORAGE_*` at AWS S3, R2, B2 or any
S3-compatible endpoint, and should expect to be the first to find that parser's
limits.

## Hand-rolled UI

The dashboard is vanilla TypeScript compiled to static files, with hash
routing and server-rendered string fragments. No React, no router library, no
state manager.

**Why:** the UI ships as static files inside the same container as the API, so
adding a framework adds build-time weight and a client-side runtime to a product
whose selling point is "one `docker compose up`, no CDN, no build step for the
operator".

**What it costs, honestly:**

- No component model. Shared presentation is string-fragment functions
  (`src/ui/helpers.ts`), and any string that reaches `innerHTML` has to go
  through `esc()` by hand. A missed `esc()` is a stored XSS; there is no
  framework to make the unsafe path the inconvenient one. `helpers.unit.spec.ts`
  covers `esc()` directly for this reason.
- DOM updates are manual. `tickRelativeAges()` walks `.rel-age` spans every
  second rather than letting a reactive layer re-render.
- Testing is Playwright end-to-end against a live stack, or not at all. There
  is no component-level test tier, which is why several UI paths are
  integration-only.

A React/TanStack migration was evaluated and deferred; this section is the
"what we gave up" half of that decision.

## Per-type monitor repositories — `BaseMonitorRepo<T>` declined

The seven monitor repos under `src/db/repositories/` repeat each other, and the
obvious fix — one generic base class parameterised by monitor type — was
evaluated and **rejected as the wrong shape**. What was extracted instead is
`projectLatest` (`_with-latest.ts`), and the remaining duplication is recorded
here rather than left to look like an oversight.

**Why the full base class is the wrong shape.** Each repo binds a different
Drizzle table pair, and the _projected row shape_ genuinely differs per type:
`url_monitor_executions` / `api_executions` expose `responseTimeMs`, the four
latency tables (`tcp` / `udp` / `db` / `tls`) expose `latencyMs`, and
`qa_test_executions` exposes neither — it has `durationMs`, and its timestamp is
`startedAt` rather than `startTime` (which is why `findExecutionsByProjectId`
renames it on the way out). `statusCode` is a third variant again: `url` reads it
straight off, `api` reads `responseStatus` and aliases it, and the latency
monitors have no such column at all.

So the method with the most duplication — `findAllWithLatest` — is the one that
cannot be shared without either a callback escape hatch (which is exactly what
`projectLatest` is) or a generic signature carrying two latency column names and
two timestamp column names, at which point the call site reads
`repo.findAllWithLatest<LatencyCol, TimeCol>()`. And a base class parameterised on
the table (`BaseMonitorRepo<T extends PgTable>`) buys no safety for the string
column names anyway: `db.select().from(T)` will happily accept a column object
from the wrong table. It also forces the type parameter through every consumer —
`monitor-route-detail-handlers.ts` and the route modules annotate concrete row
types today and would each have to carry `<TMonitors>` for no gain.

The duplication that _can_ be removed (below) does not need generics at all: a
plain factory taking the table objects and column keys infers the concrete row
type per call site and needs no type parameter anywhere.

**What is left, honestly.** Two methods are still duplicated verbatim:

- `findById(id)` — identical in all seven repos apart from the table identifier.
- the execution-history query — named `findExecutionsByMonitorId` (url / tls /
  tcp / udp / db), `findExecutionsByCheckId` (api) and
  `findExecutionsByProjectId` (qa). Six of the seven are identical apart from the
  table, the FK column name, and the local variable name (`m` vs `c`). QA is the
  outlier: it selects twelve explicit columns and renames `startedAt` →
  `startTime`.

Both could collapse into a factory taking `(monitorTable, executionsTable,
fkColumn, timeColumn)` — roughly 20 lines plus seven one-line registrations
against ~110 duplicated lines. That is a genuine remaining dedupe and is **not**
blocked; it was left undone because it is a behaviour-preserving refactor of six
files with no bug motivating it, and the audit it came from had a smaller budget.
Doing it as part of a change that actually touches those repos is the cheaper
moment.

`findAllWithLatest` is only partly duplicated: the `selectDistinctOn` +
`leftJoin` scaffolding repeats, but the column list plus the projection callback
— 20-25 lines per type — are specific to each one. `projectLatest` already owns
the part that was genuinely identical.

One inconsistency this section does not fix: `monitor-route-detail-handlers.ts`
already factors the four latency detail handlers (tcp / udp / db / tls) through a
`LATENCY_REPOS` record, while url, api and qa still hand-write theirs. Widening
that to all seven is the same trade-off as the repo factory above and is likewise
left for a change that touches those routes.
