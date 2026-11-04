import { defineConfig } from '@playwright/test';

const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'matrix-dev-live.spec.ts',
  outputDir: '.matrix-e2e/dev-stage-3h/test-results',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
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
