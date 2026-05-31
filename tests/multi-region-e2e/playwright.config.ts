// Self-contained Playwright config for the multi-region harness. Extends the
// root UI config (reusing its .env loader, baseURL, and OO_E2E_API_KEY bearer
// auth) and just re-points testDir at this folder so the spec here is picked up.
import { defineConfig } from '@playwright/test';
import base from '../../playwright.ui.config.ts';

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: './artifacts',
  globalSetup: undefined, // skip the root's monitor-purge; run.sh owns lifecycle
});
