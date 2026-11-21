import { defineConfig } from 'vitest/config'

// 四款新应用与共享界面进入门禁，SDK 与测试替身由 npm test 的独立工作区检查覆盖。
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['ui/**/*.test.ts', 'reader/**/*.test.ts', 'shorts/**/*.test.ts', 'cinema/page/**/*.test.ts', 'media-scraper/page/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 4,
    restoreMocks: true,
  },
})
