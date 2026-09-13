import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** 真实生成旧版升级夹具，独立单测和浏览器回归共用同一路径。 */
export async function legacyCinemaPackage() {
  const temporary = await mkdtemp(`${tmpdir()}/cinema-legacy-package-`), source = `${temporary}/source`
  try {
    await mkdir(source)
    await writeFile(`${source}/app.json`, JSON.stringify({ id: 'cinema', name: '影视', version: '1.0.0', api_version: 2, min_host_version: '0.1.0', description: '旧版影视升级夹具', author: '测试', entry: 'index.html', permissions: ['files.read', 'media.read'], settings: [{ key: 'source_dir', label: '影视文件夹', type: 'directory', default: '/' }] }))
    await writeFile(`${source}/index.html`, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script defer src="./tgdrive-sdk.js"></script></head><body>旧版影视升级夹具</body></html>')
    await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../../package.mjs'), source, `${temporary}/packages`])
    return await readFile(`${temporary}/packages/cinema-1.0.0.tgapp`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
