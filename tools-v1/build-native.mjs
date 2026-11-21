import { spawn } from 'node:child_process'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { assertNewOutput } from './output.mjs'
import { createRustSnapshot } from './source-snapshot.mjs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_TARGETS } from '../contract/types/contract.ts'
import { runLogged } from './pipeline.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function command(program, args, options = {}) {
  if (process.env.TGAPP_PIPELINE_LOG_DIR && !options.stdio) return runLogged(program, args, process.env.TGAPP_PIPELINE_LOG_DIR, options)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${program} 执行失败，退出码 ${code}`)))
  })
}
export async function buildNative(packageName, output, target, options = {}) {
  if (!PACKAGE_TARGETS.includes(target) || target === 'web') throw new Error('原生构建目标无效')
  const architecture = target === 'linux-amd64' ? 'amd64' : 'arm64'
  const platform = `linux/${architecture}`
  const image = `app-native-builder:${architecture}`
  const destination = await assertNewOutput(root, output)
  await mkdir(destination, { recursive: true })
  const snapshot = options.sourceRoot ?? await createRustSnapshot(root)
  const offline = options.offline ?? process.env.TGAPP_OFFLINE_BUILD === '1'
  try {
    if (offline) await command('docker', ['image', 'inspect', image])
    else await command('docker', ['build', '--platform', platform, '--tag', image, resolve(root, 'tools-v1/native')])
    await command('docker', ['run', '--rm', '--platform', platform,
      ...(offline ? ['--pull', 'never', '--network', 'none', '--env', 'CARGO_NET_OFFLINE=true'] : []),
      '--mount', `type=bind,source=${await realpath(snapshot)},target=/src,readonly`,
      '--mount', `type=bind,source=${await realpath(destination)},target=/out`,
      '--mount', `type=volume,source=app-cargo-registry-${architecture},target=/usr/local/cargo/registry`,
      '--mount', `type=volume,source=app-cargo-git-${architecture},target=/usr/local/cargo/git`,
      image, packageName])
  } finally { if (!options.sourceRoot) await rm(snapshot, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('用法：node tools-v1/build-native.mjs <后端 crate> <新输出目录> <linux-amd64|linux-arm64>')
  await buildNative(process.argv[2], process.argv[3], process.argv[4])
}
