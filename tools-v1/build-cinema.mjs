import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBackendApp, nativeArguments } from './build-backend-app.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function pageLicenses(stage) {
  const dependency = resolve(root, 'node_modules/mediabunny')
  const info = JSON.parse(await readFile(resolve(dependency, 'package.json'), 'utf8'))
  if (info.version !== '1.56.1' || info.license !== 'MPL-2.0') throw new Error('Mediabunny 版本或许可与锁定依赖不符')
  const destination = resolve(stage, 'licenses', `mediabunny-${info.version}`)
  await mkdir(destination, { recursive: true })
  for (const name of ['LICENSE', 'package.json']) await copyFile(resolve(dependency, name), resolve(destination, name))
  // MPL 对应源代码随包携带，不要求用户临时联网才能得到容器代码的源代码。
  await cp(resolve(dependency, 'src'), resolve(destination, 'source'), { recursive: true })
  await copyFile(resolve(root, 'cinema/NOTICE.txt'), resolve(destination, 'NOTICE'))
  for (const name of ['dom-mediacapture-transform', 'dom-webcodecs']) {
    const source = resolve(root, 'node_modules/@types', name)
    const info = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
    const destination = resolve(stage, 'licenses', `${name}-${info.version}`)
    await mkdir(destination, { recursive: true })
    await copyFile(resolve(source, 'LICENSE'), resolve(destination, 'LICENSE'))
  }
}

/** 影视专属部分只保留静态资源、MPL 对应源代码和许可；双架构管线与刮削共用。 */
export function buildCinema(output, native = {}, options = {}) {
  return buildBackendApp({ id: 'cinema', packageName: 'tgdrive-cinema', assets: [{ source: 'cinema/assets', destination: 'assets' }], pageLicenses,
    pageNotice: () => '影视页面包含 Mediabunny 1.56.1（MPL-2.0），原始许可、包清单和对应源代码见 licenses/mediabunny-1.56.1。页面 SDK 与共享界面采用仓库当前 MIT 许可。',
  }, output, native, options)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCinema(process.argv[2], nativeArguments(process.argv.slice(2)))
}
