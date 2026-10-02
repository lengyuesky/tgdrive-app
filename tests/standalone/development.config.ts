import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '.', testMatch: 'development.spec.ts', workers: 1, timeout: 30_000, outputDir: '/tmp/tgdrive-development-tests', use: { headless: true } })
