import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargo, cargoTarget, createOutput, parseOptions, root, runLogged, writeJson } from './pipeline.mjs'

/** CI 与发布共用同一组本地门禁，工作流不再另抄检查逻辑。 */
export async function checkAll(output) {
  const required = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).engines.node
  if (process.version !== `v${required}`) throw new Error(`门禁要求 Node.js ${required}`)
  const requiredRust = (await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')).match(/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1]
  const { stdout: rustVersion } = await promisify(execFile)(resolve(cargo, '..', 'rustc'), ['--version'], { cwd: root })
  if (!requiredRust || !rustVersion.startsWith(`rustc ${requiredRust} `)) throw new Error(`门禁要求 Rust ${requiredRust}`)
  const destination = await createOutput(output)
  const steps = [
    ['rust-fmt', cargo, ['fmt', '--all', '--check']],
    ['rust-clippy', cargo, ['clippy', '--workspace', '--locked', '--all-targets', '--all-features', '--', '-D', 'warnings']],
    ['rust-test', cargo, ['test', '--workspace', '--locked', '--all-features']],
    ['npm-ci', 'npm', ['ci']],
    ['contract-check', 'npm', ['run', 'contract:check']],
    ['typecheck', 'npm', ['run', 'typecheck']],
    ['npm-test', 'npm', ['test']],
  ]
  const logs = {}
  for (const [label, program, args] of steps) logs[label] = await runLogged(program, args, destination, {
    label, env: { ...process.env, CARGO_TARGET_DIR: cargoTarget, CARGO_TERM_COLOR: 'never', NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true' },
  })
  const rustLog = await readFile(logs['rust-test'], 'utf8'), npmLog = (await readFile(logs['npm-test'], 'utf8')).replace(/\x1b\[[0-9;]*m/g, '')
  const rustTests = [...rustLog.matchAll(/test result: ok\. (\d+) passed/g)].reduce((sum, match) => sum + Number(match[1]), 0)
  const vitestTests = [...npmLog.matchAll(/Tests\s+(\d+) passed/g)].reduce((sum, match) => sum + Number(match[1]), 0)
  const pipelineTests = Number(npmLog.match(/# pass (\d+)/)?.[1] ?? 0)
  const result = { node: required, rust: requiredRust, rustTests, vitestTests, pipelineTests, logs }
  await writeJson(resolve(destination, 'checks.json'), result)
  process.stdout.write(`全量门禁通过：Rust ${rustTests} 项、Vitest ${vitestTests} 项、管线 ${pipelineTests} 项\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2), { '--output': { name: 'output' } })
  await checkAll(options.output)
}
