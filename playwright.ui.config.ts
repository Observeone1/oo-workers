import { defineConfig, devices } from '@playwright/test';

// Local-only UI e2e config. Runs against a live oo-workers stack
// (defaults to http://localhost:3010, matching docker-compose UI_PORT=3010).
// Not wired into CI — kept manual for now via `bun run test:ui:e2e`.

export default defineConfig({
  testDir: './tests/ui',
  testMatch: /.*\.e2e\.spec\.ts/,
  outputDir: './tests/ui/screenshots/artifacts',
  reporter: [['list']],
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.UI_BASE_URL ?? 'http://localhost:3010',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
