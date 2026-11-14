// 飞牛服务插件共用构建入口；单独运行时只输出指定目录中的安装包。
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildFntv(destination, output = resolve(root, '.build/fntv')) {
  await build({ configFile: false, root: resolve(root, 'fntv'), base: './', publicDir: false,
    build: { outDir: output, emptyOutDir: true, target: 'es2022', sourcemap: false } })
  for (const name of ['app.json', 'icon.svg']) await copyFile(resolve(root, 'fntv', name), resolve(output, name))
  await mkdir(destination, { recursive: true })
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'package.mjs'), output, destination], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`飞牛插件打包失败：${code}`)))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFntv(resolve(process.argv[2] ?? resolve(root, '.build/fntv-package')))
}
