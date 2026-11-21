// 本工具只生成/检查新契约，不构建或改动旧应用、目录索引和已发布包。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.versions.node !== '22.22.0') throw new Error('契约门禁固定使用 Node.js 22.22.0，请先运行 fnm use 22.22.0')
const mode = process.argv[2]
if (!['generate', 'check'].includes(mode) || process.argv.length !== 3) throw new Error('参数只能为 generate 或 check')
const root = fileURLToPath(new URL('../', import.meta.url))
const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}${delimiter}${process.env.PATH ?? ''}` }
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('cargo', [
  'run', '--locked', '--manifest-path', join(root, 'Cargo.toml'), '-p', 'tgdrive-contract',
  '--features', 'types', '--bin', 'generate-types', '--', ...(mode === 'check' ? ['--check'] : []),
])
if (mode === 'check') {
  const require = createRequire(import.meta.url)
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', join(root, 'contract/types/tsconfig.json')])
  console.log('新契约 TypeScript 严格类型检查通过')
}
