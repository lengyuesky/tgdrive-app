import { build } from 'vite'
import { copyFile, cp, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { command, buildNative } from './build-native.mjs'
import { assertNewOutput } from './output.mjs'
import { createRustSnapshot } from './source-snapshot.mjs'
import { cargoTarget, tgapp } from './pipeline.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cargo = resolve(process.env.HOME, '.cargo/bin/cargo')
export async function buildPage(source, destination) {
  await build({ logLevel: process.env.TGAPP_PIPELINE_LOG_DIR ? 'silent' : 'info', configFile: false, root: source, base: './', publicDir: false, build: { outDir: destination, emptyOutDir: true, target: 'es2022', minify: true, sourcemap: false } })
}
export async function buildExamples(output, native = {}) {
  const destination = await assertNewOutput(root, output)
  await mkdir(destination, { recursive: true })
  await command(cargo, ['build', '--locked', '--manifest-path', resolve(root, 'Cargo.toml'), '--target-dir', cargoTarget, '--package', 'tgdrive-app-tools', '--bin', 'tgapp'])
  await command('npm', ['--prefix', root, 'run', 'build', '--workspace', '@tgdrive/page-sdk'])
  const staging = await mkdtemp(join(tmpdir(), 'app-example-staging-'))
  let snapshot
  try {
    const pageStage = resolve(staging, 'page-app')
    await buildPage(resolve(root, 'examples/page-app/page'), resolve(pageStage, 'page'))
    await copyFile(resolve(root, 'examples/page-app/app.json'), resolve(pageStage, 'app.json'))
    await copyFile(resolve(root, 'examples/page-app/NOTICE'), resolve(pageStage, 'NOTICE'))
    await copyFile(resolve(root, 'LICENSE'), resolve(pageStage, 'LICENSE'))
    await mkdir(resolve(pageStage, 'licenses/page-sdk'), { recursive: true })
    await copyFile(resolve(root, 'page-sdk/NOTICE'), resolve(pageStage, 'licenses/page-sdk/NOTICE'))
    await copyFile(resolve(root, 'LICENSE'), resolve(pageStage, 'licenses/page-sdk/LICENSE'))
    await command(tgapp, ['pack', pageStage, destination, 'web'])
    const backendPage = resolve(staging, 'backend-page')
    await buildPage(resolve(root, 'examples/backend-app/page'), backendPage)
    if (!native['linux-amd64'] || !native['linux-arm64']) snapshot = await createRustSnapshot(root)
    for (const target of ['linux-amd64', 'linux-arm64']) {
      const compiled = native[target] ?? resolve(staging, target)
      if (!native[target]) await buildNative('tgdrive-example-backend', compiled, target, { sourceRoot: snapshot })
      const stage = resolve(staging, `package-${target}`)
      await mkdir(stage, { recursive: true })
      await cp(backendPage, resolve(stage, 'page'), { recursive: true })
      for (const directory of ['backend', 'licenses']) await cp(resolve(compiled, directory), resolve(stage, directory), { recursive: true })
      await copyFile(resolve(compiled, 'NOTICE'), resolve(stage, 'NOTICE'))
      await copyFile(resolve(compiled, 'LICENSE'), resolve(stage, 'LICENSE'))
      await copyFile(resolve(root, 'examples/backend-app/app.json'), resolve(stage, 'app.json'))
      await mkdir(resolve(stage, 'licenses/page-sdk'), { recursive: true })
      await copyFile(resolve(root, 'page-sdk/NOTICE'), resolve(stage, 'licenses/page-sdk/NOTICE'))
      await copyFile(resolve(root, 'LICENSE'), resolve(stage, 'licenses/page-sdk/LICENSE'))
      await command(tgapp, ['pack', stage, destination, target])
    }
    const packages = (await readdir(destination)).filter(name => name.endsWith('.tgapp')).sort()
    return packages.map(name => resolve(destination, name))
  } finally { await rm(staging, { recursive: true, force: true }); if (snapshot) await rm(snapshot, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node tools-v1/build-examples.mjs <新输出目录> [amd64 原生产物目录] [arm64 原生产物目录]')
  const native = process.argv[3] && process.argv[4] ? { 'linux-amd64': resolve(process.argv[3]), 'linux-arm64': resolve(process.argv[4]) } : {}
  await buildExamples(process.argv[2], native)
}
