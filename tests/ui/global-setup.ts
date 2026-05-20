/**
 * Playwright global setup — runs ONCE before any spec.
 *
 * Purges leftover e2e-created resources from the dev DB so the worker
 * doesn't keep rescheduling them during the test run (each enabled QA
 * monitor spawns a Chromium — accumulated orphans across crashed runs
 * explode WSL memory).
 *
 * Single source of truth: delegates to scripts/purge-e2e-leftovers.ts
 * (also invoked by start-oo-workers.sh after migrations). Direct DB
 * deletes — same path the script uses on its own.
 *
 * Wired via playwright.ui.config.ts `globalSetup`.
 */

import { purgeE2eLeftovers } from '../../scripts/purge-e2e-leftovers.ts';

export default async function globalSetup(): Promise<void> {
  const t0 = Date.now();
  try {
    // --all: clear every monitor/channel/region/status-page row
    // (auth survives — see scripts/purge-e2e-leftovers.ts header).
    // This guarantees the e2e suite starts from a clean DB even if
    // the worker has been up for hours accumulating cruft, and it
    // prevents the worker from spawning Chromium for orphan QA
    // monitors during the run (the WSL-crash root cause).
    const r = await purgeE2eLeftovers({ all: true });
    const ms = Date.now() - t0;
    if (r.total === 0) {
      console.log(`[e2e/global-setup] DB already clean (${ms}ms)`);
    } else {
      console.log(
        `[e2e/global-setup] cleared ${r.total} rows in ${ms}ms — ` +
          `url=${r.url_monitors} api=${r.api_checks} qa=${r.qa_projects} ` +
          `tcp=${r.tcp_monitors} udp=${r.udp_monitors} db=${r.db_monitors} ` +
          `tls=${r.tls_monitors} channels=${r.alert_channels} ` +
          `regions=${r.regions} pages=${r.status_pages}`,
      );
    }
  } catch (e) {
    // Don't fail the suite if cleanup hiccups — tests can still run.
    console.log(
      `[e2e/global-setup] purge failed (continuing): ${e instanceof Error ? e.message : e}`,
    );
  }
}
