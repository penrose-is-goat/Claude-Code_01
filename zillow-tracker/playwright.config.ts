import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the manual UI audit. Assumes a production server is already
 * listening on :3111 (`npx next build && npx next start -p 3111`).
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.playwright-artifacts/results.json' }]],
  outputDir: '.playwright-artifacts/test-output',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3111',
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
