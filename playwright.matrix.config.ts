import { defineConfig } from '@playwright/test';
import { loadIsolatedMatrixConfig } from './tests/e2e/matrix-runtime-config.mjs';

loadIsolatedMatrixConfig();
const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'matrix-dev-live.spec.ts',
  testIgnore: ['matrix-live.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 45_000 },
  globalTimeout: 1_200_000,
  outputDir: '.matrix-e2e/isolated-stage-3i/test-results',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    launchOptions: {
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    },
  },
  webServer: {
    command: 'node scripts/serve-matrix-e2e.mjs',
    url: 'http://127.0.0.1:5174/tests/e2e/matrix-harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
  },
});
