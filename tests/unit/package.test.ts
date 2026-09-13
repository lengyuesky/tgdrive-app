import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { collectPackages, extractFileFromZip, mergeCatalogs, parseCatalog, serializeCatalog } from '../../catalog.mjs'
import { legacyCinemaPackage } from '../browser/cinema-legacy-package'

const run = promisify(execFile)
const apps = resolve(import.meta.dirname, '../..')
const temporary: string[] = []
async function fixture() {
  const source = await mkdtemp(`${tmpdir()}/tgdrive-package-test-`)
  temporary.push(source)
  await writeFile(`${source}/app.json`, JSON.stringify({ id: 'custom-viewer', name: '自定义阅读器', version: '1.2.3', api_version: 2, min_host_version: '0.1.0', author: '测试', description: '合成打包夹具', entry: 'index.html', permissions: [], settings: [] }))
  await writeFile(`${source}/index.html`, '<!doctype html><html lang="zh-CN"><head><script defer src="./tgdrive-sdk.js"></script></head><body>独立插件</body></html>')
  return source
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

it('build:apps 保留指定静态源码目录和输出目录，与直接打包生成相同包', async () => {
  const source = await fixture()
  // 输出放在源码目录的同级，防止第二次打包把第一次的产物一起收进包。
  const output = await mkdtemp(`${tmpdir()}/tgdrive-package-output-`)
  temporary.push(output)
  await run(process.execPath, [`${apps}/build.mjs`, source, `${output}/legacy`])
  await run(process.execPath, [`${apps}/package.mjs`, source, `${output}/direct`])
  const name = 'custom-viewer-1.2.3.tgapp'
  expect(await readdir(`${output}/legacy`)).toEqual([name])
  expect(await readFile(`${output}/legacy/${name}`)).toEqual(await readFile(`${output}/direct/${name}`))
})

it('指定源码而未给输出参数时仍尊重目录环境配置', async () => {
  const source = await fixture()
  const output = await mkdtemp(`${tmpdir()}/tgdrive-package-output-`)
  temporary.push(output)
  await run(process.execPath, [`${apps}/build.mjs`, source], { env: { ...process.env, TGDRIVE_APP_BUILD_OUTPUT: output } })
  expect(await readdir(output)).toEqual(['custom-viewer-1.2.3.tgapp'])
})

it.each(['1.0', '1e0', '-0.0', '1.25', '9007199254740991'])('原始数字 %s 在包内清单、目录及历史合并中使用相同表示', async (literal) => {
  const source = await fixture()
  const output = await mkdtemp(`${tmpdir()}/tgdrive-number-output-`)
  temporary.push(output)
  const manifest = JSON.parse(await readFile(`${source}/app.json`, 'utf8'))
  manifest.settings = [{ key: 'scale', label: '比例', type: 'number', default: '__RAW_NUMBER__' }]
  // 必须直接写原始数字文本，不能提前用 JS 数字把待测差异抹掉。
  const raw = JSON.stringify(manifest).replace('"__RAW_NUMBER__"', literal).replace('"api_version":2', '"api_version":2.0')
  await writeFile(`${source}/app.json`, raw)
  await run(process.execPath, [`${apps}/package.mjs`, source, output])
  const packages = await collectPackages(output)
  const catalog = mergeCatalogs({ currentEntries: packages, releaseTag: 'v1.0.0' })
  const wire = parseCatalog(serializeCatalog(catalog))
  const appJson = extractFileFromZip(packages[0].buffer, 'app.json')!.toString('utf8')
  expect(appJson).toBe(JSON.stringify(wire.entries[0].manifest, null, 2) + '\n')
  const next = mergeCatalogs({ currentEntries: packages, previousCatalog: wire, releaseTag: 'v1.0.1' })
  expect(next.entries).toEqual(wire.entries)
  expect(await readFile(`${source}/app.json`, 'utf8')).toBe(raw)
})

it.each(['9007199254740993', '-9007199254740993', '1e400'])('打包前拒绝不能安全往返的原始数字 %s', async (literal) => {
  const source = await fixture()
  const output = await mkdtemp(`${tmpdir()}/tgdrive-number-output-`)
  temporary.push(output)
  const manifest = JSON.parse(await readFile(`${source}/app.json`, 'utf8'))
  manifest.settings = [{ key: 'scale', label: '比例', type: 'number', default: '__RAW_NUMBER__' }]
  await writeFile(`${source}/app.json`, JSON.stringify(manifest).replace('"__RAW_NUMBER__"', literal))
  await expect(run(process.execPath, [`${apps}/package.mjs`, source, output])).rejects.toThrow('安全整数')
  expect(await readdir(output)).toEqual([])
})

it('影院旧版升级夹具使用独立打包器并保留旧设置和当前 SDK', async () => {
  const buffer = await legacyCinemaPackage()
  expect(JSON.parse(extractFileFromZip(buffer, 'app.json')!.toString('utf8'))).toMatchObject({
    id: 'cinema', version: '1.0.0', api_version: 2,
    settings: [{ key: 'source_dir', type: 'directory', default: '/' }],
  })
  expect(extractFileFromZip(buffer, 'index.html')!.toString('utf8')).toContain('旧版影视升级夹具')
  expect(extractFileFromZip(buffer, 'tgdrive-sdk.js')).toEqual(await readFile(`${apps}/sdk/tgdrive-sdk.js`))
})
