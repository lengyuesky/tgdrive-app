// 影视刮削页面独立构建；不依赖宿主源码或外部运行时脚本。
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { validateManifest } from '../catalog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function buildScraper(destination, output = resolve(root, '.build/media-scraper')) {
  const manifest=JSON.parse(await readFile(resolve(root,'media-scraper/app.json'),'utf8'))
  validateManifest(manifest)
  await build({ configFile: false, root: resolve(root, 'media-scraper'), base: './', publicDir: false,
    build: { outDir: output, emptyOutDir: true, target: 'es2022', sourcemap: false } })
  for (const name of ['app.json', 'icon.svg']) await copyFile(resolve(root, 'media-scraper', name), resolve(output, name))
  for(const path of manifest.integration?.screenshots ?? []){
    await mkdir(dirname(resolve(output,path)),{recursive:true})
    await copyFile(resolve(root,'media-scraper',path),resolve(output,path))
  }
  await mkdir(destination, { recursive: true })
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'package.mjs'), output, destination], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`影视刮削插件打包失败：${code}`)))
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildScraper(resolve(process.argv[2] ?? resolve(root, '.build/scraper-package')))
}
