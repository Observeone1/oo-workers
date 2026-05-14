import { defineConfig, devices } from '@playwright/test';

// Local-only UI e2e config. Runs against a live oo-workers stack
// (defaults to http://localhost:3010, matching docker-compose UI_PORT=3010).
// Not wired into CI — kept manual for now via `bun run test:ui:e2e`.

export default defineConfig({
  testDir: './tests/ui',
  testMatch: /.*\.e2e\.spec\.ts/,
  outputDir: './tests/ui/screenshots/artifacts',
  reporter: [['list']],
  // SPA boot occasionally races the auth header on first goto and lands on
  // the login screen. One retry papers over this without masking real bugs.
  retries: 1,
  workers: 1,
  use: {
    baseURL: process.env.UI_BASE_URL ?? 'http://localhost:3010',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // When OO_AUTH_ENABLED=true on the stack, every request through the
    // Playwright APIRequestContext + Page-context fetches sends this
    // bearer header. OO_E2E_API_KEY is generated in run-integration.sh
    // (CI/pre-push) or by the operator before manual e2e runs.
    extraHTTPHeaders: process.env.OO_E2E_API_KEY
      ? { Authorization: `Bearer ${process.env.OO_E2E_API_KEY}` }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
