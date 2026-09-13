import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'mediabunny': resolve(root, 'node_modules/mediabunny/dist/modules/src/index.js'),
      'dompurify': resolve(root, 'node_modules/dompurify/dist/purify.es.mjs'),
      '@zip.js/zip.js': resolve(root, 'node_modules/@zip.js/zip.js'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'reader/**/*.test.ts',
      'books/**/*.test.ts',
      'comics/**/*.test.ts',
      'cinema/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ],
    restoreMocks: true,
  },
})
