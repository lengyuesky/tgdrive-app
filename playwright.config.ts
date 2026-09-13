import type { PlaywrightTestConfig } from '@playwright/test'

export default {
  testDir: './tests/browser',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_APPS_OUTPUT_DIR ?? '/tmp/tgdrive-apps-e2e-results',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      args: ['--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node ./tests/browser/fixture.mjs',
    url: 'http://127.0.0.1:4187/__apps_fixture',
    reuseExistingServer: process.env.TGDRIVE_APPS_E2E_REUSE === '1',
    timeout: 180_000,
  },
} satisfies PlaywrightTestConfig
