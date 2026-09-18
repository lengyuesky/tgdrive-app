import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackages, compareStableVersions, extractFileFromZip, formatSha256Sums,
  mergeCatalogs, parseCatalog, readCatalog, serializeCatalog, sha256Hex,
  validateCatalog, validateEntry, validateManifest, validateRepository,
  verifyCatalogPackages,
  DEFAULT_REPOSITORY, MAX_CATALOG_BYTES, MAX_ENTRIES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
  type AppManifest, type Catalog, type CatalogEntry,
} from '../../catalog.mjs'

const root = resolve(import.meta.dirname, '../..')
const run = promisify(execFile)
const temporary: string[] = []

function sampleManifest(id = 'test-plugin', version = '1.0.0'): AppManifest {
  return {
    id,
    name: '测试插件',
    version,
    api_version: 2,
    min_host_version: '0.1.0',
    description: '测试用插件',
    author: 'tgdrive',
    entry: 'index.html',
    permissions: ['files.read'],
    settings: [],
  }
}

function sampleEntry(id = 'test-plugin', version = '1.0.0', sha = 'a'.repeat(64), size = 1024): CatalogEntry {
  return {
    manifest: sampleManifest(id, version),
    sha256: sha,
    size,
    url: `https://raw.githubusercontent.com/${DEFAULT_REPOSITORY}/main/apps/${id}-${version}.tgapp`,
  }
}

function sampleCatalog(entries = [sampleEntry()]): Catalog {
  return { schema_version: 2, repository: DEFAULT_REPOSITORY, entries }
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

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('catalog 完整清单 schema', () => {
  it('接受完整清单及有效但不兼容未来宿主的记录', () => {
    const future = sampleEntry('books', '2.0.0')
    future.manifest.api_version = 0xffffffff
    future.manifest.min_host_version = '90.0.0-rc.1+build.01'
    expect(validateCatalog(sampleCatalog([future]))).toBe(true)
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
    const manifest: AppManifest = {
      ...sampleManifest(),
      settings: [
        { key: 'enabled', label: '启用', type: 'boolean', default: false },
        { key: 'scale', label: '比例', description: '', type: 'number', default: 1.25 },
        { key: 'title', label: '标题', type: 'string', default: '中文' },
        { key: 'directory', label: '目录', type: 'directory', default: './中文//书籍' },
      ],
    }
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

describe('catalog 结构、URL、唯一性与大小 (schema_version: 2)', () => {
  it('接受完整合法目录和有效空目录', () => {
    expect(validateCatalog(sampleCatalog([sampleEntry('books', '1.1.4'), sampleEntry('cinema', '1.1.2')]))).toBe(true)
    expect(validateCatalog(sampleCatalog([]))).toBe(true)
  })

  it('拒绝未知字段、旧 schema_version 1、错误版本 3、数组替代对象和缺必填字段', () => {
    for (const catalog of [[], null, { ...sampleCatalog(), hidden: true }, { ...sampleCatalog(), schema_version: 1 }, { ...sampleCatalog(), schema_version: 3 }, { ...sampleCatalog(), release_tag: 'v1.0.0' }, { ...sampleCatalog(), branch: 'main' }, { ...sampleCatalog(), ref: 'refs/heads/main' }, { ...sampleCatalog(), entries: null }]) {
      expect(() => validateCatalog(catalog)).toThrow()
    }
    for (const key of Object.keys(sampleCatalog())) {
      const catalog: Record<string, unknown> = { ...sampleCatalog() }
      delete catalog[key]
      expect(() => validateCatalog(catalog)).toThrow('缺少必填字段')
    }
    expect(() => validateEntry({ ...sampleEntry(), hidden: true })).toThrow('未知字段')
    expect(() => validateEntry({ ...sampleEntry(), release_tag: 'v1.0.0' })).toThrow('未知字段')
  })

  it.each(['invalid repository', 'owner/', '/repo', './repo', '../repo', 'owner/.', 'owner/..', 'owner/repo ', ' owner/repo', 'owner/repo\n', 'a/b/c', 'a/'.padEnd(101, 'b')])('拒绝非法仓库 %s', repository => {
    expect(() => validateRepository(repository)).toThrow('仓库标识无效')
    expect(() => validateCatalog({ ...sampleCatalog(), repository })).toThrow()
  })

  it('保留合法仓库字符边界且显式校验预期仓库', () => {
    for (const repository of ['owner_name/repo.name', 'Owner-Name/repo_name', 'a/'.padEnd(100, 'b')]) expect(() => validateRepository(repository)).not.toThrow()
    expect(() => validateCatalog(sampleCatalog(), { repository: 'other/repo' })).toThrow('不匹配')
  })

  it('URL 必须精确匹配 raw.githubusercontent.com/<repo>/main/apps/<id>-<version>.tgapp', () => {
    const url = sampleEntry().url
    expect(url).toBe(`https://raw.githubusercontent.com/${DEFAULT_REPOSITORY}/main/apps/test-plugin-1.0.0.tgapp`)
    for (const badUrl of [
      url.replace('raw.githubusercontent.com', 'github.com'),
      url.replace('raw.githubusercontent.com', 'evil.com'),
      url.replace('https:', 'http:'),
      url.replace('raw.githubusercontent.com', 'user@raw.githubusercontent.com'),
      url.replace('raw.githubusercontent.com', 'raw.githubusercontent.com:443'),
      `${url}?token=secret`,
      `${url}#fragment`,
      url.replace('/main/', '/master/'),
      url.replace('/main/', '/v1.0.0/'),
      url.replace('/apps/', '/releases/download/v1.0.0/'),
      url.replace('test-plugin-1.0.0', 'wrong-name-1.0.0'),
      url.replace('1.0.0.tgapp', '1.0.1.tgapp'),
      url.replace('lengyuesky', 'other'),
    ]) {
      expect(() => validateEntry({ ...sampleEntry(), url: badUrl })).toThrow('条目 URL 不符合规范')
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

  it('每个应用 ID 仅限一条记录，重复即拒绝', () => {
    expect(() => validateCatalog(sampleCatalog([sampleEntry('app-a', '1.0.0'), sampleEntry('app-a', '1.0.1')]))).toThrow('禁止重复应用记录')
    expect(() => validateCatalog(sampleCatalog([sampleEntry('app-a'), sampleEntry('app-a')]))).toThrow('禁止重复应用记录')
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => sampleEntry(`app-${i}`))
    expect(validateCatalog(sampleCatalog(entries))).toBe(true)
    expect(() => validateCatalog(sampleCatalog([...entries, sampleEntry('another')]))).toThrow('目录条目数超限')
  })

  it('有效字段合计超过 1 MiB 时失败，不靠非法长字段制造测试', () => {
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
      ...sampleEntry(`app-${i}`),
      manifest: { ...sampleManifest(`app-${i}`), description: 'x'.repeat(1600), author: 'x'.repeat(160) },
    }))
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

describe('catalog 版本升级、移除与防篡改 (mergeCatalogs)', () => {
  it('新生成目录按应用 ID 字典序升序排序', () => {
    const catalog = mergeCatalogs({
      currentEntries: [
        sampleEntry('shorts', '1.0.3'),
        sampleEntry('comics', '1.0.11'),
        sampleEntry('books', '1.1.4'),
        sampleEntry('cinema', '1.1.2'),
      ],
    })
    expect(catalog.entries.map(e => e.manifest.id)).toEqual(['books', 'cinema', 'comics', 'shorts'])
    expect(catalog.schema_version).toBe(2)
  })

  it('允许新版本替换旧版本，保持每 ID 仅一条最新记录', () => {
    const previous = sampleCatalog([sampleEntry('books', '1.1.4'), sampleEntry('cinema', '1.1.2')])
    const updated = mergeCatalogs({
      currentEntries: [sampleEntry('books', '1.1.5'), sampleEntry('cinema', '1.1.2')],
      previousCatalog: previous,
    })
    expect(updated.entries).toHaveLength(2)
    expect(updated.entries.find(e => e.manifest.id === 'books')?.manifest.version).toBe('1.1.5')
    expect(updated.entries.find(e => e.manifest.id === 'cinema')?.manifest.version).toBe('1.1.2')
  })

  it('允许目录移除插件，不强制保留旧插件', () => {
    const previous = sampleCatalog([sampleEntry('books', '1.1.4'), sampleEntry('cinema', '1.1.2')])
    const reduced = mergeCatalogs({
      currentEntries: [sampleEntry('books', '1.1.4')],
      previousCatalog: previous,
    })
    expect(reduced.entries).toHaveLength(1)
    expect(reduced.entries[0].manifest.id).toBe('books')
  })

  it('同应用版本倒退必须拒绝', () => {
    const previous = sampleCatalog([sampleEntry('books', '1.1.4')])
    expect(() => mergeCatalogs({
      currentEntries: [sampleEntry('books', '1.1.3')],
      previousCatalog: previous,
    })).toThrow('不允许同应用版本倒退')
  })

  it('同一应用相同版本内容不可更换（防篡改检测）', () => {
    const previous = sampleCatalog([sampleEntry('books', '1.1.4')])

    // 摘要变化
    expect(() => mergeCatalogs({
      currentEntries: [{ ...sampleEntry('books', '1.1.4'), sha256: 'b'.repeat(64) }],
      previousCatalog: previous,
    })).toThrow('同一应用相同版本不允许更换摘要（tamper detected）')

    // 大小变化
    expect(() => mergeCatalogs({
      currentEntries: [{ ...sampleEntry('books', '1.1.4'), size: 2048 }],
      previousCatalog: previous,
    })).toThrow('同一应用相同版本不允许更换完整清单或大小')

    // 清单字段变化
    const changedManifest = { ...sampleManifest('books', '1.1.4'), name: '新图书名称' }
    expect(() => mergeCatalogs({
      currentEntries: [{ ...sampleEntry('books', '1.1.4'), manifest: changedManifest }],
      previousCatalog: previous,
    })).toThrow('同一应用相同版本不允许更换完整清单或大小')
  })

  it('当前批次中包含重复应用 ID 拒绝', () => {
    expect(() => mergeCatalogs({
      currentEntries: [sampleEntry('books', '1.1.4'), sampleEntry('books', '1.1.5')],
    })).toThrow('禁止重复记录')
  })
})

describe('verifyCatalogPackages 本地真实包与目录核验（通用安全门禁）', () => {
  it('四个匹配的真实包核验通过', async () => {
    const { directory, packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg] })
    await expect(verifyCatalogPackages(catalog, packages)).resolves.toBeUndefined()
  })

  it('包内容篡改（大小未变）拒绝', async () => {
    const { packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg] })

    // 修改目录记录的预期 SHA256，模拟本地包内容被静默修改/篡改
    catalog.entries[0].sha256 = '0'.repeat(64)

    await expect(verifyCatalogPackages(catalog, packages)).rejects.toThrow('SHA256 与目录记录不符')
  })

  it('包大小篡改（截断或增补空白）拒绝', async () => {
    const { packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg] })

    const filePath = resolve(packages, pkg.filename)
    const buffer = await readFile(filePath)
    await writeFile(filePath, Buffer.concat([buffer, Buffer.from(' ')]))

    await expect(verifyCatalogPackages(catalog, packages)).rejects.toThrow('大小与目录记录不符')
  })

  it('目录中有记录但本地缺失包文件拒绝', async () => {
    const { packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg, sampleEntry('cinema', '1.1.2')] })

    await expect(verifyCatalogPackages(catalog, packages)).rejects.toThrow('本地插件包数量')
  })

  it('本地有多余的未索引包文件拒绝', async () => {
    const { directory, packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg] })

    // 在 packages 增加一个额外的包
    const extraSource = `${directory}/extra-source`
    await mkdir(extraSource)
    await writeFile(`${extraSource}/app.json`, JSON.stringify(sampleManifest('shorts', '1.0.3')))
    await writeFile(`${extraSource}/index.html`, '<!doctype html><html></html>')
    await run(process.execPath, [`${root}/package.mjs`, extraSource, packages])

    await expect(verifyCatalogPackages(catalog, packages)).rejects.toThrow('数量')
  })

  it('包内清单与 catalog 记录不符拒绝', async () => {
    const { packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    // 目录中篡改 description
    const tamperedManifest = { ...pkg.manifest, description: '被篡改的描述' }
    const catalog: Catalog = {
      schema_version: 2,
      repository: DEFAULT_REPOSITORY,
      entries: [{
        manifest: tamperedManifest,
        sha256: pkg.sha256,
        size: pkg.size,
        url: `https://raw.githubusercontent.com/${DEFAULT_REPOSITORY}/main/apps/${pkg.manifest.id}-${pkg.manifest.version}.tgapp`,
      }],
    }
    await expect(verifyCatalogPackages(catalog, packages)).rejects.toThrow('manifest 与目录记录不符')
  })
})

describe('catalog CLI、真实 ZIP 与 SHA256SUMS', () => {
  it('发布文档中的完整 JSON 示例通过同一严格 schema 校验', async () => {
    const documentation = await readFile(`${root}/docs/release.md`, 'utf8')
    const example = documentation.match(/```json\s+([\s\S]*?)```/)
    expect(example).not.toBeNull()
    const catalog = parseCatalog(example![1])
    expect(catalog.schema_version).toBe(2)
    expect(catalog.entries[0].manifest).toEqual(JSON.parse(await readFile(`${root}/books/app.json`, 'utf8')))
  })

  it('CLI generate 生成带 apps/ 路径的 SHA256SUMS 与根目录 catalog.json', async () => {
    const { directory, packages } = await fixture(sampleManifest('books', '1.1.4'))
    const output = `${directory}/dist`
    const appsDir = `${output}/apps`
    await mkdir(appsDir, { recursive: true })
    const [pkg] = await collectPackages(packages)
    await cp(`${packages}/${pkg.filename}`, `${appsDir}/${pkg.filename}`)

    await run(process.execPath, [`${root}/catalog.mjs`, 'generate', appsDir, output, '--repo=custom/tgapp'])
    const catalog = await readCatalog(`${output}/catalog.json`, { repository: 'custom/tgapp' })
    expect(catalog.schema_version).toBe(2)
    expect(catalog.repository).toBe('custom/tgapp')
    expect(catalog.entries[0].url).toBe(`https://raw.githubusercontent.com/custom/tgapp/main/apps/${pkg.filename}`)

    const sumsContent = await readFile(`${output}/SHA256SUMS`, 'utf8')
    expect(sumsContent).toContain(`apps/${pkg.filename}`)
    expect(sumsContent).toContain('catalog.json')

    const verifyResult = await run(process.execPath, [`${root}/catalog.mjs`, 'verify', `${output}/catalog.json`])
    expect(verifyResult.stdout).toContain('目录校验通过')
    expect(verifyResult.stdout).toContain('已核对本地包')
  })

  it('CLI verify 支持指定独立的包目录', async () => {
    const { directory, packages } = await fixture(sampleManifest('books', '1.1.4'))
    const [pkg] = await collectPackages(packages)
    const catalog = mergeCatalogs({ currentEntries: [pkg] })
    const catalogPath = `${directory}/test-catalog.json`
    await writeFile(catalogPath, serializeCatalog(catalog))

    const result = await run(process.execPath, [`${root}/catalog.mjs`, 'verify', catalogPath, packages])
    expect(result.stdout).toContain('已核对本地包')
  })

  it.each(['缺失', '普通文件'])('CLI verify 默认包目录为%s时失败，不退化为仅校验结构', async (kind) => {
    const { directory, packages } = await fixture()
    const catalogPath = `${directory}/catalog.json`
    await writeFile(catalogPath, serializeCatalog(mergeCatalogs({ currentEntries: await collectPackages(packages) })))
    if (kind === '普通文件') await writeFile(`${directory}/apps`, '不是包目录')
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'verify', catalogPath])).rejects.toMatchObject({ code: 1 })
  })

  it('CLI verify 拒绝多余参数，不能静默忽略校验选项', async () => {
    const { directory, packages } = await fixture()
    const catalogPath = `${directory}/catalog.json`
    await writeFile(catalogPath, serializeCatalog(mergeCatalogs({ currentEntries: await collectPackages(packages) })))
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'verify', catalogPath, packages, '--skip-checks'])).rejects.toMatchObject({ code: 1 })
  })

  it.each([false, true])('CLI generate 自动保护已有同版本内容，显式空基线也不能绕过（%s）', async (explicitPrevious) => {
    const { directory, packages, source } = await fixture()
    const args = [`${root}/catalog.mjs`, 'generate', packages, directory]
    await run(process.execPath, args)
    const catalogBefore = await readFile(`${directory}/catalog.json`)
    const sumsBefore = await readFile(`${directory}/SHA256SUMS`)
    await writeFile(`${source}/index.html`, '<!doctype html><p>同版本被修改的内容</p>')
    await run(process.execPath, [`${root}/package.mjs`, source, packages])
    if (explicitPrevious) {
      await writeFile(`${directory}/empty.json`, serializeCatalog(sampleCatalog([])))
      args.push(`--previous=${directory}/empty.json`)
    }
    await expect(run(process.execPath, args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('不允许更换摘要') })
    expect(await readFile(`${directory}/catalog.json`)).toEqual(catalogBefore)
    expect(await readFile(`${directory}/SHA256SUMS`)).toEqual(sumsBefore)
  })

  it('CLI generate 拒绝已有版本倒退和损坏基线，保留原索引与校验清单', async () => {
    const { directory, packages } = await fixture()
    await writeFile(`${directory}/SHA256SUMS`, '原校验清单')
    for (const previous of [serializeCatalog(sampleCatalog([sampleEntry('test-plugin', '2.0.0')])), '{broken']) {
      await writeFile(`${directory}/catalog.json`, previous)
      await expect(run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, directory])).rejects.toMatchObject({ code: 1 })
      expect(await readFile(`${directory}/catalog.json`, 'utf8')).toBe(previous)
      expect(await readFile(`${directory}/SHA256SUMS`, 'utf8')).toBe('原校验清单')
    }
  })

  it('CLI generate 拒绝包目录位于输出目录外，不留下错误索引或校验清单', async () => {
    const { directory, packages } = await fixture()
    const output = `${directory}/separate`
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, output])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('必须位于分发输出目录内') })
    await expect(readFile(`${output}/catalog.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${output}/SHA256SUMS`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('CLI 拒绝已废止的 --tag 参数', async () => {
    const { directory, packages } = await fixture()
    await expect(
      run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, directory, '--tag=v2.0.0'])
    ).rejects.toMatchObject({ code: 1 })
  })

  it.each(['9007199254740993', '-9007199254740993', '1e400'])('原始历史目录数字 %s 必须拒绝', async (literal) => {
    const catalog = sampleCatalog()
    const raw = JSON.stringify(catalog).replace('"settings":[]', `"settings":[{"key":"scale","label":"比例","type":"number","default":${literal}}]`)
    expect(() => parseCatalog(raw)).toThrow()
    const { directory, packages } = await fixture()
    const previous = `${directory}/previous.json`
    await writeFile(previous, raw)
    await expect(
      run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, `${directory}/next`, `--previous=${previous}`])
    ).rejects.toMatchObject({ code: 1 })
  })

  it('显式 previous 缺失、空、坏 JSON 均失败', async () => {
    const { directory, packages } = await fixture()
    for (const content of [null, '', '{broken']) {
      const previous = `${directory}/previous.json`
      if (content !== null) await writeFile(previous, content)
      await expect(
        run(process.execPath, [`${root}/catalog.mjs`, 'generate', packages, directory, `--previous=${previous}`])
      ).rejects.toMatchObject({ code: 1 })
    }
  })

  it('CLI verify 按磁盘实际字节数限制 JSON，未知参数报错', async () => {
    const { directory, packages } = await fixture()
    const path = `${directory}/large.json`
    await writeFile(path, `${JSON.stringify(sampleCatalog())}${' '.repeat(MAX_CATALOG_BYTES)}`)
    await expect(readCatalog(path)).rejects.toThrow('大小超限')
    await expect(run(process.execPath, [`${root}/catalog.mjs`, 'verify', path])).rejects.toMatchObject({ code: 1 })
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
    expect(
      formatSha256Sums([
        { name: 'apps/shorts-1.0.3.tgapp', sha256: 'b'.repeat(64) },
        { name: 'catalog.json', sha256: 'a'.repeat(64) },
      ])
    ).toBe(`${'b'.repeat(64)}  apps/shorts-1.0.3.tgapp\n${'a'.repeat(64)}  catalog.json\n`)
  })
})

describe('build.mjs 与独立分发输出行为', () => {
  it('TGDRIVE_APP_BUILD_OUTPUT 指定独立输出分发目录时生成完整分发产物并通过校验', async () => {
    const output = await mkdtemp(`${tmpdir()}/tgdrive-dist-output-`)
    temporary.push(output)
    await run(process.execPath, [`${root}/build.mjs`], {
      env: { ...process.env, TGDRIVE_APP_BUILD_OUTPUT: output },
    })
    const catalog = await readCatalog(`${output}/catalog.json`)
    expect(catalog.schema_version).toBe(2)
    expect(catalog.entries).toHaveLength(4)
    const packages = await collectPackages(`${output}/apps`)
    expect(packages).toHaveLength(4)
    await expect(verifyCatalogPackages(catalog, `${output}/apps`)).resolves.toBeUndefined()
    const shaCheck = await run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: output })
    // execFile 成功退出已证明校验通过，不绑定系统语言中的“成功”或“OK”。
    expect(shaCheck.stdout).toContain('apps/books-1.3.4.tgapp:')
    expect(shaCheck.stdout).toContain('catalog.json:')
  }, 20_000)

  it('目标 catalog.json 存在同版本篡改时，在 staging 阻断并不破坏目标目录', async () => {
    const output = await mkdtemp(`${tmpdir()}/tgdrive-dist-output-`)
    temporary.push(output)
    const tamperedCatalog = sampleCatalog([sampleEntry('books', '1.3.4', 'f'.repeat(64))])
    await writeFile(`${output}/catalog.json`, JSON.stringify(tamperedCatalog, null, 2))

    await expect(
      run(process.execPath, [`${root}/build.mjs`], {
        env: { ...process.env, TGDRIVE_APP_BUILD_OUTPUT: output },
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('同一应用相同版本不允许更换摘要') })

    // 目标目录的 catalog.json 未被覆盖破坏
    expect(await readFile(`${output}/catalog.json`, 'utf8')).toBe(JSON.stringify(tamperedCatalog, null, 2))
  }, 20_000)

  it('目标 catalog.json 损坏或格式错误时，构建失败且现有资产保持不变', async () => {
    const output = await mkdtemp(`${tmpdir()}/tgdrive-dist-output-`)
    temporary.push(output)
    const brokenContent = '{ "schema_version": 1, "repository": "broken" '
    await writeFile(`${output}/catalog.json`, brokenContent)
    await mkdir(`${output}/apps`, { recursive: true })
    const markerContent = '不可被覆盖'
    await writeFile(`${output}/apps/marker.txt`, markerContent)

    // 构建必须失败，不能把损坏的 catalog 误当成 ENOENT 首次构建
    await expect(
      run(process.execPath, [`${root}/build.mjs`], {
        env: { ...process.env, TGDRIVE_APP_BUILD_OUTPUT: output },
      })
    ).rejects.toMatchObject({ code: 1 })

    // 目标目录的损坏文件和现有资产完全保持原样未被静默覆盖
    expect(await readFile(`${output}/catalog.json`, 'utf8')).toBe(brokenContent)
    expect(await readFile(`${output}/apps/marker.txt`, 'utf8')).toBe(markerContent)
  }, 20_000)

  it('构建成功后自动清理 apps/ 中的历史旧版本包，仅保留最新四包', async () => {
    const output = await mkdtemp(`${tmpdir()}/tgdrive-dist-output-`)
    temporary.push(output)
    await mkdir(`${output}/apps`, { recursive: true })
    await writeFile(`${output}/apps/comics-1.0.8.tgapp`, '旧版占位')
    await writeFile(`${output}/apps/legacy-0.0.1.tgapp`, '废弃包')

    await run(process.execPath, [`${root}/build.mjs`], {
      env: { ...process.env, TGDRIVE_APP_BUILD_OUTPUT: output },
    })

    const packages = await collectPackages(`${output}/apps`)
    expect(packages).toHaveLength(4)
    expect(packages.map(p => p.filename)).toEqual([
      'books-1.3.4.tgapp',
      'cinema-1.2.4.tgapp',
      'comics-1.2.4.tgapp',
      'shorts-1.1.2.tgapp',
    ])
  }, 20_000)
})
