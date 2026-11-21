import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { command } from './build-native.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cargo = resolve(process.env.HOME, '.cargo/bin/cargo')
// npm 工作区测试的 cwd 不同；先按本次 cargo 调用的 cwd 固定相对目标目录，再传给所有子进程。
if (process.env.CARGO_TARGET_DIR !== undefined) process.env.CARGO_TARGET_DIR = resolve(process.env.CARGO_TARGET_DIR)
try { await access(cargo, constants.X_OK) } catch { throw new Error('缺少 cargo；请先安装 Rust 并把 $HOME/.cargo/bin 加入 PATH。测试工作进程只在本总门禁入口构建一次。') }
await command(process.execPath, [resolve(root, 'tools-v1/generate-page-schema.mjs'), 'check'])
await command(cargo, ['build', '--locked', '--manifest-path', resolve(root, 'Cargo.toml'), '--package', 'tgdrive-test-host', '--bin', 'tgdrive-test-worker'])
await command('npm', ['--prefix', root, 'run', 'build', '--workspace', '@tgdrive/page-sdk'])
await command(resolve(root, 'node_modules/.bin/tsc'), ['-p', resolve(root, 'page-sdk/tsconfig.test.json')])
for (const workspace of ['@tgdrive/page-sdk', '@tgdrive/test-host', '@tgdrive/example-page']) {
  await command('npm', ['--prefix', root, 'run', 'typecheck', '--workspace', workspace])
  await command('npm', ['--prefix', root, 'run', 'test', '--workspace', workspace])
}
await command(resolve(root, 'node_modules/.bin/tsc'), ['-p', resolve(root, 'examples/backend-app/page/tsconfig.json')])
