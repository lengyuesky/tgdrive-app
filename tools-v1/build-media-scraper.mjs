import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBackendApp, nativeArguments } from './build-backend-app.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 刮削页面与原生后端成对分发，不生成 web 包。 */
export function buildMediaScraper(output, native = {}, options = {}) {
  return buildBackendApp({ id: 'media-scraper', packageName: 'tgdrive-media-scraper', assets: [{ source: 'media-scraper/icon.svg', destination: 'assets/icon.svg' }], nativeLicenses: ['musl/copyright'],
    pageNotice: async () => (await readFile(resolve(root, 'media-scraper/NOTICE.txt'), 'utf8')).split('\n下列为当前锁定')[0],
  }, output, native, options)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMediaScraper(process.argv[2], nativeArguments(process.argv.slice(2)))
}
