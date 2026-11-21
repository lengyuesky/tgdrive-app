import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildPage } from './build-examples.mjs'
import { command } from './build-native.mjs'
import { assertNewOutput } from './output.mjs'
import { cargoTarget, tgapp } from './pipeline.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cargo = resolve(process.env.HOME, '.cargo/bin/cargo')
const firstPartyNotice = '本应用及其携带的页面 SDK、契约生成物与共享界面采用本仓库已声明的 MIT 许可，原文见包内 LICENSE。\n第三方软件保留各自的原始许可与版权说明，按实际依赖随包携带。\n'
const applications = {
  reader: {
    licenses: [
      ['@zip.js/zip.js/LICENSE', 'zip-js.txt'],
      ['dompurify/LICENSE', 'dompurify-apache.txt'],
      ['dompurify/LICENSE-MPL', 'dompurify-mpl.txt'],
      ['pdfjs-dist/LICENSE', 'pdfjs.txt'],
      ['pdfjs-dist/standard_fonts/LICENSE_FOXIT', 'font-foxit.txt'],
      ['pdfjs-dist/standard_fonts/LICENSE_LIBERATION', 'font-liberation.txt'],
      ['pdfjs-dist/cmaps/LICENSE', 'cmaps.txt'],
    ],
  },
  shorts: { licenses: [] },
}

/** 页面输出只能是仓库外的新目录；中间目录由本次构建独享，绝不覆盖既有包。 */
export async function buildPages(ids, output) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(applications, id))) throw new Error('页面应用只能选择 reader、shorts 或 all')
  const destination = await assertNewOutput(root, output)
  await mkdir(destination)
  await command(cargo, ['build', '--locked', '--manifest-path', resolve(root, 'Cargo.toml'), '--target-dir', cargoTarget, '--package', 'tgdrive-app-tools', '--bin', 'tgapp'])
  await command('npm', ['--prefix', root, 'run', 'build', '--workspace', '@tgdrive/page-sdk'])
  const staging = await mkdtemp(join(tmpdir(), 'tgapp-page-staging-'))
  try {
    const packages = []
    for (const id of ids) {
      const source = resolve(root, id), stage = resolve(staging, id)
      const manifest = JSON.parse(await readFile(resolve(source, 'app.json'), 'utf8'))
      if (manifest.id !== id || manifest.backend || manifest.page?.entry !== 'page/index.html') throw new Error(`${id} 尚不是可构建的纯页面应用`)
      await buildPage(resolve(source, 'page'), resolve(stage, 'page'))
      await copyFile(resolve(source, 'app.json'), resolve(stage, 'app.json'))
      await mkdir(resolve(stage, 'assets')); await copyFile(resolve(source, 'icon.svg'), resolve(stage, 'assets/icon.svg'))
      const licenses = resolve(stage, 'licenses'); await mkdir(licenses)
      // 复制主分支已有的许可原文，不在应用代码中另写许可声明。
      await copyFile(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE'))
      await writeFile(resolve(stage, 'NOTICE'), firstPartyNotice + (id === 'reader' ? await readFile(resolve(source, 'NOTICE.txt'), 'utf8') : '短视频页面没有第三方运行时依赖。\n'))
      await mkdir(resolve(licenses, 'page-sdk'))
      await copyFile(resolve(root, 'page-sdk/NOTICE'), resolve(licenses, 'page-sdk/NOTICE'))
      await copyFile(resolve(root, 'LICENSE'), resolve(licenses, 'page-sdk/LICENSE'))
      for (const [input, name] of applications[id].licenses) await copyFile(resolve(root, 'node_modules', input), resolve(licenses, name))
      if (id === 'reader') {
        await copyFile(resolve(source, 'formats/licenses/core-js.txt'), resolve(licenses, 'core-js.txt'))
        const resources = resolve(stage, 'page/assets/pdf-resources'); await mkdir(resources, { recursive: true })
        for (const directory of ['cmaps', 'standard_fonts']) await cp(resolve(root, 'node_modules/pdfjs-dist', directory), resolve(resources, directory), { recursive: true })
      }
      await command(tgapp, ['pack', stage, destination, 'web'])
      const path = resolve(destination, `${id}-${manifest.version}.tgapp`)
      await command(tgapp, ['verify', path]); packages.push(path)
    }
    return packages
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3] || process.argv.length !== 4) throw new Error('用法：node tools-v1/build-pages.mjs <reader|shorts|all> <仓库外的新输出目录>')
  await buildPages(process.argv[2] === 'all' ? Object.keys(applications) : [process.argv[2]], process.argv[3])
}
