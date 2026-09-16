import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 独立阅读馆浏览器自动化套件：无宿主无网络、真实Vite构建与多视口覆盖。 */
export default defineConfig({
  testDir: '.',
  testMatch: 'readers.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_READERS_OUTPUT_DIR ?? join(tmpdir(), 'tgdrive-readers-browser-results'),
  use: {
    viewport: { width: 1000, height: 700 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      args: ['--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
  },
})
