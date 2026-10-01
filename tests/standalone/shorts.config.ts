import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: '.', testMatch: 'shorts.spec.ts', workers: 1, timeout: 30_000,
  expect: { timeout: 10_000 }, reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_APPS_OUTPUT_DIR ?? join(tmpdir(), 'tgdrive-shorts-browser-results'),
  use: { viewport: { width: 390, height: 844 }, hasTouch: true, trace: 'retain-on-failure' },
})
