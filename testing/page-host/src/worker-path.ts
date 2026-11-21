import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
/** 与 cargo 的环境规则一致；显式工作进程和 TGDRIVE_TEST_WORKER 不被目标目录覆盖。 */
export function resolveWorkerPath(override?: string): string {
  return override ?? process.env.TGDRIVE_TEST_WORKER ?? resolve(process.env.CARGO_TARGET_DIR ?? resolve(repository, 'target'), 'debug', process.platform === 'win32' ? 'tgdrive-test-worker.exe' : 'tgdrive-test-worker')
}
