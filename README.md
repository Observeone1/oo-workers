# oo-workers

> Self-hostable distributed monitoring workers — the engine behind ObserveOne, packaged for `docker compose up`.

**Status:** pre-alpha · private repo. Forked from internal `observeone-workers` verbatim as a starting point; being adapted for self-host (Supabase → Postgres, drop multi-region assumptions, add docker-compose).

## Why this exists

This is the OSS slice of ObserveOne. The engine that runs HTTP, API, and Playwright browser checks — packaged so anyone can self-host it like Uptime Kuma, but with real browser-based checks and deep assertions that Kuma doesn't offer.

## Roadmap

- **Phase 0 (now):** verbatim import from `observeone-workers`.
- **Phase 1:** swap Supabase for Postgres, drop multi-region queue naming, ship `docker-compose.yml` (worker + redis + postgres).
- **Phase 2:** thin admin UI on top (separate package or layer).
- **Phase 3:** TCP / UDP / DB-protocol monitors (the Uptime-Kuma weak spot).

## Stack (current)

- Node.js + TypeScript
- BullMQ + Redis (job queue)
- Playwright (browser checks)
- Supabase ← **being replaced with Postgres**
- Winston (logging)

## Repos this came from

- Internal: `projects/observeone-workers` — the live production version.
- This: a public-shaped fork, adapted for self-host.

## License

TBD before public release.
