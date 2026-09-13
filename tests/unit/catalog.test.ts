import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackages, compareStableVersions, extractFileFromZip, formatSha256Sums,
  mergeCatalogs, parseCatalog, readCatalog, serializeCatalog, sha256Hex,
  validateCatalog, validateEntry, validateManifest, validateRepository,
  DEFAULT_REPOSITORY, MAX_CATALOG_BYTES, MAX_ENTRIES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
  type AppManifest, type Catalog, type CatalogEntry,
} from '../../catalog.mjs'

const root = resolve(import.meta.dirname, '../..')
const run = promisify(execFile)
const temporary: string[] = []

function sampleManifest(id = 'test-plugin', version = '1.0.0'): AppManifest {
  return { id, name: '测试插件', version, api_version: 2, min_host_version: '0.1.0', description: '测试用插件', author: 'tgdrive', entry: 'index.html', permissions: ['files.read'], settings: [] }
}

function sampleEntry(id = 'test-plugin', version = '1.0.0', tag = 'v1.0.0', sha = 'a'.repeat(64)): CatalogEntry {
  return { manifest: sampleManifest(id, version), sha256: sha, size: 1024, url: `https://github.com/${DEFAULT_REPOSITORY}/releases/download/${tag}/${id}-${version}.tgapp`, release_tag: tag }
}

function sampleCatalog(entries = [sampleEntry()], tag = 'v1.0.0'): Catalog {
  return { schema_version: 1, repository: DEFAULT_REPOSITORY, release_tag: tag, entries }
}

async function fixture(manifest: unknown = sampleManifest(), padding = 0) {
  const directory = await mkdtemp(`${tmpdir()}/tgdrive-catalog-test-`)
  temporary.push(directory)
  const source = `${directory}/source`, packages = `${directory}/packages`
  await mkdir(source)
  await writeFile(`${source}/app.json`, JSON.stringify(manifest) + ' '.repeat(padding))
  await writeFile(`${source}/index.html`, '<!doctype html><html><body>目录工具合成夹具</body></html>')
  await run(process.execPath, [`${root}/package.mjs`, source, packages])
  return { directory, source, packages }
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('catalog 完整清单 schema', () => {
  it('接受完整清单及有效但不兼容未来宿主的记录，不丢弃历史', () => {
    const future = sampleEntry('books', '2.0.0')
    future.manifest.api_version = 0xffffffff
    future.manifest.min_host_version = '90.0.0-rc.1+build.01'
    expect(validateCatalog(sampleCatalog([sampleEntry('books', '1.0.0'), future]))).toBe(true)
    expect(mergeCatalogs({ currentEntries: [], previousCatalog: sampleCatalog([future]), releaseTag: 'v1.0.1' }).entries).toEqual([future])
  })

  it.each(Object.keys(sampleManifest()))('拒绝缺少必填字段 %s', key => {
    const manifest: Record<string, unknown> = { ...sampleManifest() }
    delete manifest[key]
    expect(() => validateEntry({ ...sampleEntry(), manifest })).toThrow('缺少必填字段')
  })

  it.each(['id', 'name', 'version', 'min_host_version', 'description', 'author', 'entry'])('拒绝非字符串 %s', key => {
    expect(() => validateManifest({ ...sampleManifest(), [key]: 123 })).toThrow()
  })

  it.each(['banana', '01.0.0', '1.00.0', '1.0.01', 'v1.0.0', '1.0', '1.0.0-beta.1', '1.0.0+build', '1.0.0\n', '18446744073709551616.0.0'])('即使 URL 对齐也拒绝非法稳定版本 %s', version => {
    expect(() => validateEntry(sampleEntry('test-plugin', version))).toThrow()
  })

  it.each(['banana', '01.0.0', '1.0.0-01', '1.0.0+', '1.0.0-alpha..1', '1.0.0\n'])('拒绝畸形 min_host_version %s', min_host_version => {
    expect(() => validateManifest({ ...sampleManifest(), min_host_version })).toThrow()
  })

  it.each([0, -1, 1.5, '2', null, NaN, Infinity, 0x100000000])('api_version 必须为正整数 u32：%s', api_version => {
    expect(() => validateManifest({ ...sampleManifest(), api_version })).toThrow('api_version')
  })

  it.each<[string, number]>([['name', 120], ['description', 1600], ['author', 160]])('%s 按 UTF-8 字节计限并拒绝控制字符', (key, limit) => {
    expect(() => validateManifest({ ...sampleManifest(), [key]: 'x'.repeat(limit) })).not.toThrow()
    for (const text of [' ', 'x'.repeat(limit + 1), '中'.repeat(Math.floor(limit / 3) + 1), 'a\nb', 'a\u0085b', '\ud800']) {
      expect(() => validateManifest({ ...sampleManifest(), [key]: text })).toThrow()
    }
  })

  it.each(['../index.html', '/index.html', '.hidden/index.html', 'a//index.html', 'a\\index.html', 'https://evil/index.html', 'index.js', `${'a'.repeat(236)}.html`])('拒绝非法入口路径 %s', entry => {
    expect(() => validateManifest({ ...sampleManifest(), entry })).toThrow('entry')
  })

  it('入口允许合法子目录且不拒绝宿主允许的下划线资源', () => {
    expect(() => validateManifest({ ...sampleManifest(), entry: '_pages/index.html' })).not.toThrow()
  })

  it.each([null, 'files.read', ['files.read', 'files.read'], ['files.write'], [1], ['files.read', 'media.read', 'favorites.write', 'future.read']])('拒绝非法权限声明 %j', permissions => {
    expect(() => validateManifest({ ...sampleManifest(), permissions })).toThrow('permissions')
  })

  it('拒绝 manifest/setting 未知字段以及非对象清单', () => {
    for (const manifest of [null, [], 'manifest', { ...sampleManifest(), hidden: true }, { ...sampleManifest(), settings: [{ key: 'x', label: '设置', type: 'boolean', default: true, hidden: true }] }]) {
      expect(() => validateManifest(manifest)).toThrow()
    }
  })

  it('设置各类型有效默认值保持原样，description 可省略', () => {
    const manifest: AppManifest = { ...sampleManifest(), settings: [
      { key: 'enabled', label: '启用', type: 'boolean', default: false },
      { key: 'scale', label: '比例', description: '', type: 'number', default: 1.25 },
      { key: 'title', label: '标题', type: 'string', default: '中文' },
      { key: 'directory', label: '目录', type: 'directory', default: './中文//书籍' },
    ] }
    expect(() => validateManifest(manifest)).not.toThrow()
    expect(manifest.settings[3].default).toBe('./中文//书籍')
  })

  it.each<Record<string, unknown>>([
    { key: '' }, { key: 'x'.repeat(65) }, { key: 'x-y' }, { key: '__proto__' }, { key: 'constructor' }, { key: 'prototype' },
    { label: '' }, { label: '中'.repeat(54) }, { description: 'x'.repeat(1201) }, { description: null },
    { type: 'select' }, { default: null }, { type: 'boolean', default: 'false' }, { type: 'number', default: NaN },
    { type: 'number', default: Infinity }, { type: 'number', default: '1' },
    { type: 'number', default: 9007199254740992 }, { type: 'number', default: -9007199254740992 },
    { default: 'x'.repeat(2049) },
    { type: 'directory', default: '/a/../b' }, { type: 'directory', default: '/a\u0000b' },
    { type: 'directory', default: `/${'中'.repeat(86)}` },
  ])('拒绝非法设置声明 %j', patch => {
    expect(() => validateManifest({ ...sampleManifest(), settings: [{ key: 'value', label: '设置', type: 'string', default: '', ...patch }] })).toThrow('setting')
  })

  it('拒绝重复、缺字段和超过 24 项的设置', () => {
    const field = { key: 'x', label: '设置', type: 'boolean', default: true }
    for (const settings of [[field, field], [{ ...field, default: undefined }], [{ key: 'x', label: '设置', type: 'boolean' }], Array.from({ length: 25 }, (_, i) => ({ ...field, key: `x${i}` })), null]) {
      expect(() => validateManifest({ ...sampleManifest(), settings })).toThrow()
    }
  })
})

describe('catalog 结构、URL、唯一性与大小', () => {
  it('接受完整合法目录和有效空目录', () => {
    expect(validateCatalog(sampleCatalog([sampleEntry('books', '1.1.4'), sampleEntry('cinema', '1.1.2')]))).toBe(true)
    expect(validateCatalog(sampleCatalog([]))).toBe(true)
  })

  it('拒绝未知字段、错误 schema、数组替代对象和缺必填字段', () => {
    for (const catalog of [[], null, { ...sampleCatalog(), hidden: true }, { ...sampleCatalog(), schema_version: 2 }, { ...sampleCatalog(), entries: null }]) expect(() => validateCatalog(catalog)).toThrow()
    for (const key of Object.keys(sampleCatalog())) {
      const catalog: Record<string, unknown> = { ...sampleCatalog() }
      delete catalog[key]
      expect(() => validateCatalog(catalog)).toThrow('缺少必填字段')
    }
    expect(() => validateEntry({ ...sampleEntry(), hidden: true })).toThrow('未知字段')
  })

  it.each(['invalid repository', 'owner/', '/repo', './repo', '../repo', 'owner/.', 'owner/..', 'owner/repo ', ' owner/repo', 'owner/repo\n', 'a/b/c', 'a/'.padEnd(101, 'b')])('拒绝非法仓库 %s', repository => {
    expect(() => validateRepository(repository)).toThrow('仓库标识无效')
    expect(() => validateCatalog({ ...sampleCatalog(), repository })).toThrow()
  })

  it('保留合法仓库字符边界且显式校验预期仓库', () => {
    for (const repository of ['owner_name/repo.name', 'Owner-Name/repo_name', 'a/'.padEnd(100, 'b')]) expect(() => validateRepository(repository)).not.toThrow()
    expect(() => validateCatalog(sampleCatalog(), { repository: 'other/repo' })).toThrow('不匹配')
  })

  it.each(['latest', 'v1.0', '1.0.0', 'v1.0.0-beta.1', 'v1.0.0+build', 'v01.0.0', 'v1.00.0', 'v1.0.01', 'v1.0.0\n'])('目录与条目均拒绝非法 release_tag %s', tag => {
    expect(() => validateCatalog({ ...sampleCatalog(), release_tag: tag })).toThrow('release_tag')
    expect(() => validateEntry(sampleEntry('books', '1.1.4', tag))).toThrow('release_tag')
  })

  it('拒绝条目引用晚于所属目录的 tag', () => {
    expect(() => validateCatalog(sampleCatalog([sampleEntry('books', '1.1.4', 'v2.0.0')]))).toThrow('不能晚于')
  })

  it('URL 必须精确匹配，拒绝跳转主机、凭据、query、fragment 和路径混淆', () => {
    const url = sampleEntry().url
    for (const badUrl of [url.replace('github.com', 'evil.com'), url.replace('github.com', 'objects.githubusercontent.com'), url.replace('https:', 'http:'), url.replace('github.com', 'user@github.com'), url.replace('github.com', 'github.com:443'), `${url}?token=secret`, `${url}#fragment`, url.replace('v1.0.0', 'v1.0.1'), url.replace('test-plugin-1.0.0', 'wrong-name'), url.replace('/releases/', '/other/../releases/'), url.replace('lengyuesky', 'other')]) {
      expect(() => validateEntry({ ...sampleEntry(), url: badUrl })).toThrow('URL 不符合规范')
    }
  })

  it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)}\n`, 'not-a-hash'])('拒绝非法 sha256 %s', sha256 => {
    expect(() => validateEntry({ ...sampleEntry(), sha256 })).toThrow('sha256 必须为 64 位小写 hex')
  })

  it.each([0, -1, 1.5, '1024', NaN, Infinity, MAX_PACKAGE_BYTES + 1])('拒绝非法 size %s', size => {
    expect(() => validateEntry({ ...sampleEntry(), size })).toThrow('16 MiB')
  })

  it('允许恰好 16 MiB 的压缩包大小', () => {
    expect(() => validateEntry({ ...sampleEntry(), size: MAX_PACKAGE_BYTES })).not.toThrow()
  })

  it('相同摘要的重复记录仍拒绝，512 条为上限', () => {
    expect(() => validateCatalog(sampleCatalog([sampleEntry(), sampleEntry()]))).toThrow('禁止重复记录')
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => sampleEntry(`app-${i}`))
    expect(validateCatalog(sampleCatalog(entries))).toBe(true)
    expect(() => validateCatalog(sampleCatalog([...entries, sampleEntry('another')]))).toThrow('目录条目数超限')
  })

  it('有效字段合计超过 1 MiB 时失败，不靠非法长字段制造测试', () => {
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ ...sampleEntry(`app-${i}`), manifest: { ...sampleManifest(`app-${i}`), description: 'x'.repeat(1600), author: 'x'.repeat(160) } }))
    expect(() => validateCatalog(sampleCatalog(entries))).toThrow('目录大小超限')
  })

  it('原始 JSON 字节数包含空白；UTF-8 和 JSON 解析失败不能回退空目录', () => {
    const raw = serializeCatalog(sampleCatalog())
    const exact = ' '.repeat(MAX_CATALOG_BYTES - Buffer.byteLength(raw)) + raw
    expect(parseCatalog(exact)).toEqual(sampleCatalog())
    expect(() => parseCatalog(` ${exact}`)).toThrow('目录大小超限')
    for (const bad of ['', ' ', '{}', '{', Buffer.from([0xff])]) expect(() => parseCatalog(bad)).toThrow()
  })
})

describe('catalog 历史合并与防篡改', () => {
  it('首发正常生成，应用 ID 升序且 SemVer 数值降序', () => {
    const catalog = mergeCatalogs({ currentEntries: [sampleEntry('shorts', '1.0.3'), sampleEntry('books', '1.1.9'), sampleEntry('books', '1.1.10'), sampleEntry('books', '1.2.0')], releaseTag: 'v1.0.0' })
    expect(catalog.entries.map(entry => `${entry.manifest.id}@${entry.manifest.version}`)).toEqual(['books@1.2.0', 'books@1.1.10', 'books@1.1.9', 'shorts@1.0.3'])
    expect(compareStableVersions('18446744073709551615.0.0', '18446744073709551614.0.0')).toBe(1)
  })

  it('历史全量保留，相同内容复用原 URL/tag', () => {
    const original = sampleEntry('cinema', '1.1.2')
    const previous = sampleCatalog([original, sampleEntry('books', '1.1.3')])
    const merged = mergeCatalogs({ currentEntries: [original, sampleEntry('books', '1.1.4')], previousCatalog: previous, releaseTag: 'v1.2.0' })
    expect(merged.entries).toHaveLength(3)
    expect(merged.entries.find(entry => entry.manifest.id === 'cinema')).toEqual(original)
    expect(merged.entries.find(entry => entry.manifest.version === '1.1.3')).toEqual(previous.entries[1])
    expect(merged.entries.find(entry => entry.manifest.version === '1.1.4')?.release_tag).toBe('v1.2.0')
  })

  it('同版本不同摘要拒绝', () => {
    expect(() => mergeCatalogs({ currentEntries: [{ ...sampleEntry(), sha256: 'f'.repeat(64) }], previousCatalog: sampleCatalog(), releaseTag: 'v1.0.1' })).toThrow('同一应用相同版本不允许更换摘要（tamper detected）')
  })

  it.each<Partial<AppManifest>>([
    { name: '另一个名称' }, { author: '另一个作者' }, { description: '另一个描述' }, { entry: 'other.html' },
    { permissions: ['files.read', 'media.read'] }, { settings: [{ key: 'muted', label: '静音', type: 'boolean', default: true }] },
    { api_version: 3 }, { min_host_version: '3.0.0' },
  ])('相同 id/version/digest 也禁止更换任何完整清单元数据 %j', patch => {
    const entry = { ...sampleEntry(), manifest: { ...sampleManifest(), ...patch } }
    expect(() => mergeCatalogs({ currentEntries: [entry], previousCatalog: sampleCatalog(), releaseTag: 'v1.0.1' })).toThrow('不允许更换完整清单或大小')
  })

  it('相同摘要不能掩盖变化大小或未通过校验的当前产物', () => {
    expect(() => mergeCatalogs({ currentEntries: [{ ...sampleEntry(), size: 1025 }], previousCatalog: sampleCatalog(), releaseTag: 'v1.0.1' })).toThrow('完整清单或大小')
    expect(() => mergeCatalogs({ currentEntries: [{ ...sampleEntry(), size: MAX_PACKAGE_BYTES + 1 }], previousCatalog: sampleCatalog(), releaseTag: 'v1.0.1' })).toThrow('16 MiB')
    const invalid = { ...sampleEntry(), manifest: { ...sampleManifest(), name: '' } }
    expect(() => mergeCatalogs({ currentEntries: [invalid], previousCatalog: sampleCatalog(), releaseTag: 'v1.0.1' })).toThrow('manifest.name')
  })

  it('当前批次重复不可静默去重，包含复用历史的批次也拒绝', () => {
    for (const previousCatalog of [null, sampleCatalog()]) expect(() => mergeCatalogs({ currentEntries: [sampleEntry(), sampleEntry()], previousCatalog, releaseTag: 'v1.0.1' })).toThrow('禁止重复记录')
  })

  it('历史超量或 tag 倒退直接失败', () => {
    const previous = sampleCatalog(Array.from({ length: MAX_ENTRIES }, (_, i) => sampleEntry(`hist-${i}`)))
    expect(() => mergeCatalogs({ currentEntries: [sampleEntry('new-app')], previousCatalog: previous, releaseTag: 'v1.0.1' })).toThrow('目录合并后条目超过上限')
    for (const releaseTag of ['v1.0.0', 'v0.9.9']) expect(() => mergeCatalogs({ currentEntries: [], previousCatalog: sampleCatalog(), releaseTag })).toThrow('必须大于')
  })
})

describe('catalog CLI、真实 ZIP 与 SHA256SUMS', () => {
  it('发布文档中的完整 JSON 示例通过同一严格 schema 校验', async () => {
    const documentation = await readFile(`${root}/docs/release.md`, 'utf8')
    const example = documentation.match(/```json\s+([\s\S]*?)```/)
    expect(example).not.toBeNull()
    const catalog = parseCatalog(example![1])
    expect(catalog.entries[0].manifest).toEqual(JSON.parse(await readFile(`${root}/books/app.json`, 'utf8')))
  })

  it('显式 CLI 参数覆盖环境默认值，并验证实际包和全部 checksum', async () => {
    const { directory, packages } = await fixture()
    const output = `${directory}/output`
    await run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, output, '--tag=v2.0.0', '--repo=explicit/repo'], { env: { ...process.env, TGDRIVE_APP_RELEASE_TAG: 'v9.0.0', TGDRIVE_APP_GITHUB_REPO: 'env/repo' } })
    const catalog = await readCatalog(`${output}/catalog.json`, { repository: 'explicit/repo' })
    expect(catalog.release_tag).toBe('v2.0.0')
    expect(catalog.entries[0].url).toContain('/explicit/repo/releases/download/v2.0.0/')
    const [pkg] = await collectPackages(packages)
    expect(pkg.manifest).toEqual(sampleManifest())
    expect(catalog.entries[0].sha256).toBe(sha256Hex(pkg.buffer))
    expect(catalog.entries[0].size).toBe(pkg.buffer.length)
    expect(await readFile(`${output}/SHA256SUMS`, 'utf8')).toBe(formatSha256Sums([
      { name: pkg.filename, sha256: pkg.sha256 },
      { name: 'catalog.json', sha256: sha256Hex(await readFile(`${output}/catalog.json`)) },
    ]))
    const result = await run(process.execPath, [`${root}/catalog.mjs`, 'verify', `${output}/catalog.json`])
    expect(result.stdout).toContain('目录校验通过')
  })

  it.each(['9007199254740993', '-9007199254740993', '1e400'])('原始历史目录数字 %s 必须拒绝而不是合并后静默舍入', async (literal) => {
    const catalog = sampleCatalog()
    const raw = JSON.stringify(catalog).replace('"settings":[]', `"settings":[{"key":"scale","label":"比例","type":"number","default":${literal}}]`)
    expect(() => parseCatalog(raw)).toThrow()
    const { directory, packages } = await fixture()
    const previous = `${directory}/previous.json`
    await writeFile(previous, raw)
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, `${directory}/next`, '--tag=v1.0.1', `--previous=${previous}`])).rejects.toMatchObject({ code: 1 })
    expect(await readFile(previous, 'utf8')).toBe(raw)
  })

  it('显式 previous 缺失、空、坏 JSON 均失败，不降级首发', async () => {
    const { directory, packages } = await fixture()
    for (const content of [null, '', '{broken']) {
      const previous = `${directory}/previous.json`
      if (content !== null) await writeFile(previous, content)
      await expect(run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, directory, '--tag=v1.0.1', `--previous=${previous}`])).rejects.toMatchObject({ code: 1 })
    }
  })

  it('CLI verify 按磁盘实际字节数限制 JSON，未知参数报错', async () => {
    const { directory, packages } = await fixture()
    const path = `${directory}/large.json`
    await writeFile(path, `${JSON.stringify(sampleCatalog())}${' '.repeat(MAX_CATALOG_BYTES)}`)
    await expect(readCatalog(path)).rejects.toThrow('大小超限')
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'verify', path])).rejects.toMatchObject({ code: 1 })
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, directory, '--tga=v1.0.0'])).rejects.toMatchObject({ code: 1 })
  })

  it('真实归档中的非法清单、错误文件名和超限包均被拒绝', async () => {
    const manifest: Record<string, unknown> = { ...sampleManifest() }
    delete manifest.author
    const invalid = await fixture(manifest)
    await expect(collectPackages(invalid.packages)).rejects.toThrow('缺少必填字段')
    const valid = await fixture()
    await rename(`${valid.packages}/test-plugin-1.0.0.tgapp`, `${valid.packages}/wrong-1.0.0.tgapp`)
    await expect(collectPackages(valid.packages)).rejects.toThrow('包文件名')
    const file = await open(`${valid.packages}/wrong-1.0.0.tgapp`, 'w')
    try { await file.truncate(MAX_PACKAGE_BYTES + 1) } finally { await file.close() }
    await expect(collectPackages(valid.packages)).rejects.toThrow('大小超限')
  })

  it('压缩 app.json 解压受 64 KiB 限制，ZIP 长度和 CRC 不能伪造', async () => {
    await expect(fixture(sampleManifest(), MAX_MANIFEST_BYTES)).rejects.toThrow('大小超限')
    const valid = await fixture()
    const buffer = await readFile(`${valid.packages}/test-plugin-1.0.0.tgapp`)
    const oversized = Buffer.from(buffer)
    oversized.writeUInt32LE(MAX_MANIFEST_BYTES + 1, 22)
    expect(() => extractFileFromZip(oversized, 'app.json')).toThrow('解压大小超限')
    expect(JSON.parse(extractFileFromZip(buffer, 'app.json')!.toString())).toEqual(sampleManifest())
    const badCrc = Buffer.from(buffer)
    badCrc.writeUInt32LE(0, 14)
    expect(() => extractFileFromZip(badCrc, 'app.json')).toThrow('校验和不符')
    expect(extractFileFromZip(Buffer.from('not a zip'), 'app.json')).toBeNull()
  })

  it('checksum 格式按文件名排序', () => {
    expect(formatSha256Sums([{ name: 'shorts-1.0.3.tgapp', sha256: 'b'.repeat(64) }, { name: 'catalog.json', sha256: 'a'.repeat(64) }])).toBe(`${'a'.repeat(64)}  catalog.json\n${'b'.repeat(64)}  shorts-1.0.3.tgapp\n`)
  })
})
