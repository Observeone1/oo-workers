# Status-page incidents

Public status pages (`/status/<slug>`) show monitor uptime. **Incidents**
add the human-written layer on top — the operator narrating an outage as
it unfolds, like statuspage.io / GitHub status:

```
🟡 Investigating elevated 5xx on /api/checkout
   10:32 UTC — Spike in upstream timeouts; team paged.
   10:45 UTC — Root cause: Stripe webhook backlog. Retrying.
   11:02 UTC — Resolved. Error rate back to baseline.
```

An incident is a **thread of updates**, not a single post. Manage them
in the dashboard under **Incidents** (`#/incidents`): pick a status
page, post an incident (title + severity + first update), then append
updates as the situation evolves. They are operator-authored only — no
alert/notification is sent (alerts are a separate, monitor-driven
system; see [alerts.md](alerts.md)).

## Severity

`investigating` → `identified` → `monitoring` → `resolved`. The latest
update's severity is the incident's current severity (amber → orange →
yellow-green → green). Posting an update with severity **resolved**
closes the incident; it stays on the public page (condensed, newest
first) for ~24h then drops off, still in the dashboard under the
**Resolved** filter.

## Public render

Server-rendered into `/status/<slug>` above the monitor list — works
with **no JavaScript** (native `<details>` for the full timeline).
Active incidents sort by most-recent activity; recently-resolved by
resolution time. A strict `Content-Security-Policy` (`script-src
'none'`) is sent on that route as defence-in-depth.

## Update markdown

Update bodies support a deliberately tiny, safe subset (no links, no
raw HTML — the page is public and unauthenticated):

| Syntax         | Renders       |
| -------------- | ------------- |
| `**bold**`     | **bold**      |
| `` `code` ``   | inline code   |
| blank line     | new paragraph |
| single newline | line break    |

Everything else is escaped to literal text. The render path
(`src/services/incident-render.ts`) escapes first, then introduces only
those four literal tags — an injected `<script>` becomes inert text.
This is gated in CI by `scripts/incident-render-test.ts` (`bun run
test:incident-render`) with an XSS-evasion corpus; the full operator →
public flow is covered by the manual `tests/ui/incidents.e2e.spec.ts`.
