import { defineConfig } from '@playwright/test';
import './playwright.matrix.config';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'matrix-disposable-live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 45_000 },
  globalTimeout: 1_200_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.NYMPH_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  webServer: {
    command: 'node scripts/serve-matrix-e2e.mjs',
    url: 'http://127.0.0.1:5174/tests/e2e/matrix-harness.html',
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
