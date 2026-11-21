import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildPage } from './build-examples.mjs'
import { buildNative, command } from './build-native.mjs'
import { assertNewOutput } from './output.mjs'
import { createRustSnapshot } from './source-snapshot.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeTargets = ['linux-amd64', 'linux-arm64']
const cargo = resolve(process.env.HOME, '.cargo/bin/cargo')
const cargoTarget = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, 'target')

async function sharedPageLicenses(stage) {
  for (const name of ['page-sdk', 'ui']) {
    const destination = resolve(stage, 'licenses', name)
    await mkdir(destination, { recursive: true })
    await copyFile(resolve(root, 'LICENSE'), resolve(destination, 'LICENSE'))
    if (name === 'page-sdk') await copyFile(resolve(root, 'page-sdk/NOTICE'), resolve(destination, 'NOTICE'))
  }
}

/** 页面只编译一次，两架构共用冻结源码与页面；复用原生产物时仍逐个核验身份和真实 ELF。 */
export async function buildBackendApp(app, output, native = {}, options = {}) {
  const targets = options.targets ?? nativeTargets
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(target => !nativeTargets.includes(target))) throw new Error('后端构建必须选择 linux-amd64、linux-arm64 或两者')
  const destination = await assertNewOutput(root, output)
  await mkdir(destination, { recursive: true })
  const staging = await mkdtemp(join(tmpdir(), `${app.id}-package-stage-`))
  let snapshot
  try {
    await command(cargo, ['build', '--locked', '--manifest-path', resolve(root, 'Cargo.toml'), '--target-dir', cargoTarget, '--package', 'tgdrive-app-tools', '--bin', 'tgapp'])
    await command('npm', ['--prefix', root, 'run', 'build', '--workspace', '@tgdrive/page-sdk'])
    const manifestBytes = await readFile(resolve(root, app.id, 'app.json'))
    const manifest = JSON.parse(manifestBytes)
    if (manifest.id !== app.id || !manifest.backend || !manifest.page) throw new Error('打包入口与带页面后端清单不符')
    const page = resolve(staging, 'page')
    await buildPage(resolve(root, app.id, 'page'), page)
    const common = resolve(staging, 'common')
    await mkdir(common, { recursive: true })
    for (const asset of app.assets ?? []) {
      const target = resolve(common, asset.destination)
      await mkdir(dirname(target), { recursive: true })
      await cp(resolve(root, asset.source), target, { recursive: true })
    }
    await sharedPageLicenses(common)
    if (app.pageLicenses) await app.pageLicenses(common)
    const pageNotice = app.pageNotice ? await app.pageNotice() : '页面 SDK 与共享界面采用仓库当前 MIT 许可；原始许可见 licenses/page-sdk 与 licenses/ui。'
    if (targets.some(target => !native[target])) snapshot = await createRustSnapshot(root)
    const compiledTargets = Object.fromEntries(targets.map(target => [target, native[target] ?? resolve(destination, `native-${target}`)]))
    await Promise.all(targets.filter(target => !native[target]).map(target => buildNative(app.packageName, compiledTargets[target], target, { sourceRoot: snapshot })))
    const tgapp = resolve(cargoTarget, 'debug/tgapp')
    const requiredRust = (await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')).match(/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1]
    for (const target of targets) {
      const compiled = compiledTargets[target]
      const info = JSON.parse(await readFile(resolve(compiled, 'build-info.json'), 'utf8'))
      const rustTarget = target === 'linux-amd64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl'
      if (info.package !== app.packageName || info.version !== manifest.version || info.target !== rustTarget) throw new Error('原生构建身份或目标与应用清单不符')
      if (!requiredRust || !info.rust?.startsWith(`rustc ${requiredRust} `)) throw new Error('原生产物的 Rust 版本不是仓库固定工具链，不能复用')
      for (const license of new Set(['musl/copyright', ...(app.nativeLicenses ?? [])])) await readFile(resolve(compiled, 'licenses', license))
      await command(tgapp, ['elf', resolve(compiled, 'backend/app'), target])
      const stage = resolve(staging, `stage-${target}`)
      await cp(common, stage, { recursive: true })
      await cp(page, resolve(stage, 'page'), { recursive: true })
      await cp(resolve(compiled, 'backend'), resolve(stage, 'backend'), { recursive: true })
      await cp(resolve(compiled, 'licenses'), resolve(stage, 'licenses'), { recursive: true })
      for (const name of ['LICENSE', 'NOTICE']) await copyFile(resolve(compiled, name), resolve(stage, name))
      const notice = await readFile(resolve(stage, 'NOTICE'), 'utf8')
      await writeFile(resolve(stage, 'NOTICE'), `${notice}\n${pageNotice.trim()}\n`)
      await writeFile(resolve(stage, 'app.json'), manifestBytes)
      await command(tgapp, ['pack', stage, destination, target])
      await command(tgapp, ['verify', resolve(destination, `${app.id}-${manifest.version}-${target}.tgapp`)])
    }
    return (await readdir(destination)).filter(name => name.endsWith('.tgapp')).sort().map(name => resolve(destination, name))
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (snapshot) await rm(snapshot, { recursive: true, force: true })
  }
}

export function nativeArguments(args) {
  if (args.length !== 1 && args.length !== 3) throw new Error('须提供新输出目录，或同时提供 amd64 与 arm64 两个已验证原生产物目录')
  return args.length === 3 ? { 'linux-amd64': resolve(args[1]), 'linux-arm64': resolve(args[2]) } : {}
}
