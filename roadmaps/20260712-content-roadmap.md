---
title: 'Content — Roadmap'
slug: 'content-roadmap'
status: 'active'
tldr: 'Single ordered index for all content work: landing feature pages (website-qa, synthetic-monitoring, free-website-check), feature-release posts (environments+encryption, autopilot editable plans, oo-workers hardening), docs (Netlify page, CLI reference batch), and time-gated blog items. Four lanes with an execution path; week-1 heads: A1 page validations, B1 environments+encryption pair, C1 Netlify docs page.'
priority: 75
entries: []
---
# Content — Roadmap

Single ordered index for all content work: landing feature pages, feature-release posts, docs, and blog. Product feature work stays in its own plans; this roadmap owns sequencing for anything whose deliverable is published content (plus the free-website-check product tail, folded in whole per Samir 2026-07-12).

Landing-growth roadmap keeps its acquisition phases; content sequencing lives HERE. A plan may appear in both — plan status is authoritative, roadmaps are views.

## Execution path

Lanes are disjoint file surfaces; items within a lane are strictly ordered. Lanes run in parallel. Unpause a plan only when its lane item starts (stub-until-execution rule).

### Lane A — landing feature pages (landing repo, app/ routes)
1. **A1 (next):** T0 validations for BOTH `/website-qa` and `/synthetic-monitoring` — keyword demand + cannibalization check vs /qa-coverage and /workers. Cheap validator before the builds; may reshape or kill scope.
2. **A2:** `website-qa-monitoring-product-page-website-qa` T1–T4 — positioning anchor page, built first.
3. **A3:** `synthetic-monitoring-for-web-apps-feature-page-synthetic-mon` T1–T3 — cross-links A2, so serialized after it.
4. **A4:** `free-website-check-lead-capture-upgrade-suggested` T4 — redesign + search-intent copy rewrite. Design sign-off from Samir before building.

### Lane B — release/feature posts (landing repo, content/blog/ + feature sections)
Use ob-blog-writer; no private-stack disclosure (no E2B/sandbox/backend internals).
1. **B1 (next):** `content-environments-feature-release-landing` + `content-brag-about-encryption-at-rest` as a pair — env write-only secrets tie into the encryption story. Confirm encryption scope details (which data, algorithm, key mgmt) before writing.
2. **B2:** `content-autopilot-editable-plans-release-landing-blog` — gate OPEN: suite-details redesign shipped (waves 1–3, plan archived 2026-07-08). Angle: you own the plan, AI does the typing.
3. **B3:** `content-oo-workers-hardening-release-engineering-post-on-the` — gate OPEN: v1.29.0 tagged 2026-07-08. Engineering voice, end on the technical point, no CTA close. (Two minor oo-workers plans still paused — post covers what v1.29.0 shipped, don't claim more.)
4. **B4 (gated):** `content-dashboard-ux-roundup-post-incidents-notifications-at` — waits on needs-attention strip + list/detail quality pass shipping.

### Lane C — docs (landing repo, content/docs/ + lib/docs-nav.ts — shared surface, serialize)
1. **C1 (next):** Netlify extension docs page — `docs-content-backlog` T7, explicitly not blocked by the T0 redesign gate.
2. **C2:** CLI docs batch — gates ALL OPEN (v1.31.0, v1.33.0, v1.34.0, v1.35.0 tagged). Do the 4 stubs as ONE batched CLI-reference pass (1–2 PRs, not 4): `content-document-obs-schedule-command-chainable-bulk-on-land`, `content-document-obs-project-command-on-landing-docs`, `content-document-obs-api-collection-command-on-landing-docs`, `content-document-new-cli-monitor-types-ssl-tcp-udp-db-on-lan`.
3. **C3 (gated):** rest of `docs-content-backlog` (T1–T6) — T0 blocked on dashboard redesign + check-type churn settling.

### Lane D — free-website-check product tail (backend + frontend repos)
Sequenced after A4 gives the page its final shape; separate repos so it can also run parallel to Lanes B/C.
1. **D1:** T1 leads table + public POST endpoint (docs-feedback pattern).
2. **D2:** T2 founder notification email (existing EmailService).
3. **D3:** T5 leads dashboard view — decide admin vs main dashboard with Samir first.
4. **D4:** T6 in-dashboard notifications — NEW primitive, deliberate scoping + design sign-off before building.

### Time-gated / observational (no lane)
- `blog-refresh-cycle-1-verdict-pass-september-export` — hard gate: September 2026 GSC export (two exports post-refresh, per Observeone-research/seo-and-growth/blog-refresh/2026-07-cycle-1.md).
- `content-http-query-method-support-blog-post` — waits on the QUERY feature shipping.
- `content-lift-blog-comparison-page-conversion-to-signups` — observational; watch post-logo-rollout conversion.

## Conflict rules
- A2/A3 serialized (cross-linking pages). C1/C2 serialized (both touch docs nav + reference files).
- Lanes A/B/C all live in the landing repo but touch disjoint folders (app/ vs content/blog/ vs content/docs/) — parallel OK, separate worktrees.
- Suggested week-1 picks: A1 + B1 + C1 (all unblocked, small, de-risk the bigger builds).

