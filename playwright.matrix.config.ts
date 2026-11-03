import { defineConfig } from '@playwright/test';

const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'matrix-live.spec.ts',
  timeout: 300_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    launchOptions: {
      executablePath: chromePath,
      headless: true,
    },
  },
  webServer: {
    command: 'node scripts/serve-matrix-e2e.mjs',
    url: 'http://127.0.0.1:5174/tests/e2e/matrix-harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
