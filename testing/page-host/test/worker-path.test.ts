import { afterEach, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWorkerPath } from '../src/index.js'

const binary = process.platform === 'win32' ? 'tgdrive-test-worker.exe' : 'tgdrive-test-worker'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
afterEach(() => vi.unstubAllEnvs())
it('未配置目标目录时仍从本仓库 target 解析工作进程', () => {
  vi.stubEnv('CARGO_TARGET_DIR', undefined); vi.stubEnv('TGDRIVE_TEST_WORKER', undefined)
  expect(resolveWorkerPath()).toBe(resolve(repository, 'target/debug', binary))
})
it('CARGO_TARGET_DIR 的绝对路径与相对路径均按 cargo cwd 规则解析', () => {
  vi.stubEnv('TGDRIVE_TEST_WORKER', undefined)
  vi.stubEnv('CARGO_TARGET_DIR', resolve(repository, '外部测试产物'))
  expect(resolveWorkerPath()).toBe(resolve(repository, '外部测试产物/debug', binary))
  vi.stubEnv('CARGO_TARGET_DIR', 'shared-target')
  expect(resolveWorkerPath()).toBe(resolve(process.cwd(), 'shared-target/debug', binary))
})
it('TGDRIVE_TEST_WORKER 优先于 CARGO_TARGET_DIR，显式 workerPath 再优先', () => {
  vi.stubEnv('CARGO_TARGET_DIR', 'shared-target'); vi.stubEnv('TGDRIVE_TEST_WORKER', '/custom/worker')
  expect(resolveWorkerPath()).toBe('/custom/worker')
  expect(resolveWorkerPath('/explicit/worker')).toBe('/explicit/worker')
})
