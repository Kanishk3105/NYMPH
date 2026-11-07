import { defineConfig } from '@playwright/test';

const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'app-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      executablePath: chromePath,
      headless: true,
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
