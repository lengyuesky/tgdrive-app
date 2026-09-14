import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 仅加载本仓库阅读器与合成图片，不启动服务、不访问私有宿主。 */
export default defineConfig({
  testDir: '.',
  testMatch: 'comics.spec.ts',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_APPS_OUTPUT_DIR ?? join(tmpdir(), 'tgdrive-comics-browser-results'),
  use: {
    viewport: { width: 1000, height: 700 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      args: ['--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
  },
})
