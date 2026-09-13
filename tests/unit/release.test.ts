import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  collectPackages, DEFAULT_REPOSITORY, formatSha256Sums, mergeCatalogs, parseCatalog, serializeCatalog, sha256Hex,
  type Catalog,
} from '../../catalog.mjs'
import { parseReleasePages, publishRelease, selectPreviousRelease, type CommandRunner, type ReleaseRecord } from '../../release.mjs'

const root = resolve(import.meta.dirname, '../..')
const exec = promisify(execFile)
let temporary = '', packagesDir = '', previousCatalog: Catalog

function release(tag_name: string, id = 1, draft = false, prerelease = false): ReleaseRecord {
  return { id, tag_name, draft, prerelease, published_at: draft ? null : '2026-01-01T00:00:00Z' }
}

interface HarnessOptions {
  history?: ReleaseRecord[]
  previous?: string
  apiErrorAt?: number
  apiError?: string
  apiResponse?: string
  downloadError?: boolean
  createError?: boolean
  ancestor?: boolean
  wrongHead?: boolean
  mutateDownload?: (files: Map<string, Buffer>, releases: ReleaseRecord[]) => void
}

function harness(options: HarnessOptions = {}) {
  const releases = structuredClone(options.history ?? [])
  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const uploaded = new Map<string, Buffer>()
  let apiCalls = 0, created = false, published = false
  const run: CommandRunner = async (command, args, { cwd }) => {
    calls.push({ command, args, cwd })
    if (command === 'git') {
      if (args[0] === 'fetch') return ''
      if (args[0] === 'rev-parse') return options.wrongHead && args[1] !== 'HEAD' ? 'b'.repeat(40) : 'a'.repeat(40)
      if (args[0] === 'merge-base') {
        if (options.ancestor === false) throw new Error('不是 main 祖先')
        return ''
      }
    }
    if (command === 'gh' && args[0] === 'api') {
      apiCalls++
      if (apiCalls === options.apiErrorAt) throw new Error(options.apiError ?? 'HTTP 500 https://signed.invalid?token=secret')
      if (options.apiResponse !== undefined) return options.apiResponse
      // 模拟 gh 的完整分页输出；遗漏 --paginate 时只能看到第一页。
      const pages = args.includes('--paginate') ? [releases.slice(0, 1), releases.slice(1)] : [releases.slice(0, 1)]
      return JSON.stringify(pages)
    }
    if (command === 'gh' && args[0] === 'release') {
      if (!args.includes('--repo') || args[args.indexOf('--repo') + 1] !== DEFAULT_REPOSITORY) throw new Error('临时 cwd 必须显式指定仓库')
      if (args[1] === 'create') {
        created = true
        releases.push(release(args[2], Math.max(0, ...releases.map(item => item.id)) + 1, true))
        if (options.createError) throw new Error('草稿创建后上传中断')
        for (const path of args.slice(args.indexOf('--notes') + 2)) uploaded.set(basename(path), await readFile(path))
        return ''
      }
      if (args[1] === 'download') {
        if (options.downloadError) throw new Error('下载失败 HTTP 404')
        const directory = args[args.indexOf('--dir') + 1]
        if (args.includes('--pattern')) {
          if (options.previous === undefined) throw new Error('上一稳定版本缺少 catalog.json')
          await writeFile(`${directory}/catalog.json`, options.previous)
        } else {
          const files = new Map([...uploaded].map(([name, buffer]) => [name, Buffer.from(buffer)]))
          options.mutateDownload?.(files, releases)
          for (const [name, buffer] of files) await writeFile(`${directory}/${name}`, buffer)
        }
        return ''
      }
      if (args[1] === 'edit') {
        published = true
        return ''
      }
    }
    throw new Error(`离线夹具未声明命令：${command} ${args.join(' ')}`)
  }
  return { run, calls, uploaded, releases, get created() { return created }, get published() { return published }, get apiCalls() { return apiCalls } }
}

async function publish(remote: ReturnType<typeof harness>, releaseTag = 'v1.0.0', packages = packagesDir) {
  return publishRelease({ packagesDir: packages, releaseTag, temporaryRoot: temporary, run: remote.run })
}

beforeAll(async () => {
  temporary = await mkdtemp(`${tmpdir()}/tgdrive-release-tests-`)
  packagesDir = `${temporary}/packages`
  for (const id of ['shorts', 'books', 'comics', 'cinema']) {
    const source = `${temporary}/${id}`
    await mkdir(source)
    await copyFile(`${root}/${id}/app.json`, `${source}/app.json`)
    await writeFile(`${source}/index.html`, '<!doctype html><html><body>Release 门禁的真实 ZIP 夹具</body></html>')
    await exec(process.execPath, [`${root}/package.mjs`, source, packagesDir])
  }
  const oldSource = `${temporary}/old-books`
  await mkdir(oldSource)
  const oldManifest = JSON.parse(await readFile(`${root}/books/app.json`, 'utf8'))
  oldManifest.version = '0.9.0'
  await writeFile(`${oldSource}/app.json`, JSON.stringify(oldManifest))
  await writeFile(`${oldSource}/index.html`, '<!doctype html><html><body>真实历史版本</body></html>')
  await exec(process.execPath, [`${root}/package.mjs`, oldSource, `${temporary}/old-packages`])
  previousCatalog = mergeCatalogs({ currentEntries: [...await collectPackages(packagesDir), ...await collectPackages(`${temporary}/old-packages`)], releaseTag: 'v1.0.0' })
})

afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })

describe('Release 完整历史与单调 tag', () => {
  it('从所有分页按 SemVer 选择最高已发布稳定版本，忽略草稿和预发布', () => {
    const records = parseReleasePages(JSON.stringify([[release('v1.9.0')], [release('v1.10.0', 2), release('v8.0.0-rc.1', 3, false, true), release('v9.0.0', 4, true)]]))
    expect(selectPreviousRelease(records, 'v1.11.0')?.tag_name).toBe('v1.10.0')
    expect(() => selectPreviousRelease(records, 'v1.9.1')).toThrow('必须大于所有已发布稳定 tag')
  })

  it.each(['', '{}', '[]', '[null]', '[[{}]]', JSON.stringify([[{ ...release('v1.0.0'), draft: undefined }]])])('坏分页响应 %s 不能当首发', content => {
    expect(() => parseReleasePages(content)).toThrow()
  })

  it('只有成功查询空历史才允许 v1.0.0 首发', async () => {
    const remote = harness()
    const result = await publish(remote)
    expect(remote.created).toBe(true)
    expect(remote.published).toBe(true)
    expect(result.catalog.release_tag).toBe('v1.0.0')
    expect(result.catalog.entries).toHaveLength(4)
    expect(result.assets).toHaveLength(6)
    for (const asset of result.assets) {
      const buffer = remote.uploaded.get(asset.name)!
      expect(buffer.length).toBe(asset.size)
      expect(sha256Hex(buffer)).toBe(asset.sha256)
    }
    expect(result.assets.some(asset => asset.name === 'SHA256SUMS')).toBe(true)
    expect(remote.calls.find(call => call.args[1] === 'create')?.args).toEqual(expect.arrayContaining(['--verify-tag', '--draft', '--repo', DEFAULT_REPOSITORY]))
    expect(remote.calls.filter(call => call.args[1] === 'download')).toHaveLength(1)
    expect(remote.calls.filter(call => call.args[1] === 'download')[0].cwd).not.toBe(root)
    expect(remote.apiCalls).toBe(4)
    expect(remote.calls.at(-1)?.args).toEqual(['release', 'edit', 'v1.0.0', '--repo', DEFAULT_REPOSITORY, '--draft=false', '--latest'])
  })

  it('合并真实历史包并保留全部旧条目及旧 URL/tag', async () => {
    const remote = harness({ history: [release('v0.9.0'), release('v1.0.0', 2)], previous: serializeCatalog(previousCatalog) })
    const result = await publish(remote, 'v1.0.1')
    expect(remote.published).toBe(true)
    expect(result.catalog.entries).toEqual(previousCatalog.entries)
    expect(result.catalog.entries.find(entry => entry.manifest.version === '0.9.0')?.release_tag).toBe('v1.0.0')
    expect(parseCatalog(remote.uploaded.get('catalog.json')!).release_tag).toBe('v1.0.1')
    const previousDownload = remote.calls.find(call => call.args.includes('--pattern'))!
    expect(previousDownload.args).toEqual(expect.arrayContaining(['v1.0.0', '--repo', DEFAULT_REPOSITORY, '--pattern', 'catalog.json']))
    expect(remote.calls.filter(call => call.args[0] === 'api').every(call => call.args.includes('--paginate') && call.args.includes('--slurp'))).toBe(true)
  })

  it.each(['v0.9.0', 'v1.0.1', 'v01.0.0', 'v1.0.0-rc.1'])('错误首发 tag %s 在任何 GitHub 写入前拒绝', async tag => {
    const remote = harness()
    await expect(publish(remote, tag)).rejects.toThrow()
    expect(remote.created).toBe(false)
    expect(remote.published).toBe(false)
  })

  it.each([release('v1.0.0'), release('v1.0.0', 1, true)])('已存在的正式版或残留草稿均禁止覆盖：%j', async existing => {
    const remote = harness({ history: [existing] })
    await expect(publish(remote)).rejects.toThrow('已存在（包括草稿）')
    expect(remote.created).toBe(false)
    expect(remote.published).toBe(false)
  })

  it('已发布稳定版本乱序或相同版本均不能回退 latest', async () => {
    const remote = harness({ history: [release('v1.2.0'), release('v1.10.0', 2)] })
    await expect(publish(remote, 'v1.9.0')).rejects.toThrow('必须大于所有已发布稳定 tag')
    expect(remote.created).toBe(false)
    expect(() => selectPreviousRelease([release('v1.0.0'), release('v1.0.0', 2)], 'v1.1.0')).toThrow('重复记录')
    expect(() => selectPreviousRelease([release('v01.0.0')], 'v1.1.0')).toThrow('release_tag')
  })

  it.each(['网络超时', 'HTTP 403', 'HTTP 404', 'HTTP 429', 'HTTP 500'])('历史列表查询 %s 失败关闭，绝不降级首发', async apiError => {
    const remote = harness({ apiErrorAt: 1, apiError })
    await expect(publish(remote)).rejects.toThrow('查询完整 Release 历史列表失败')
    expect(remote.created).toBe(false)
    expect(remote.published).toBe(false)
  })

  it('API 返回坏 JSON 或空响应也不能降级首发', async () => {
    for (const apiResponse of ['', '{}', '<html>服务出错</html>']) {
      const remote = harness({ apiResponse })
      await expect(publish(remote)).rejects.toThrow()
      expect(remote.created).toBe(false)
    }
  })

  it.each([undefined, '', '{bad', '{}'])('已有发布但 catalog 缺失或无效：%s', async previous => {
    const remote = harness({ history: [release('v1.0.0')], previous })
    await expect(publish(remote, 'v1.0.1')).rejects.toThrow()
    expect(remote.created).toBe(false)
    expect(remote.published).toBe(false)
  })

  it('历史目录仓库/tag/清单不匹配必须停止，不能只发布本次四条', async () => {
    const wrongTag = { ...previousCatalog, release_tag: 'v1.0.1' }
    const wrongRepository = { ...previousCatalog, repository: 'other/repo' }
    const changed = structuredClone(previousCatalog)
    changed.entries[0].manifest.author = '被篡改的目录作者'
    const invalid = { ...previousCatalog, entries: [{ ...previousCatalog.entries[0], manifest: { id: 'books' } }] }
    for (const catalog of [wrongTag, wrongRepository, changed, invalid]) {
      const remote = harness({ history: [release('v1.0.0')], previous: JSON.stringify(catalog) })
      await expect(publish(remote, 'v1.0.2')).rejects.toThrow()
      expect(remote.created).toBe(false)
    }
  })

  it('不属于 main 的提交或构建/tag 提交不一致时不访问 GitHub 发布 API', async () => {
    for (const option of [{ ancestor: false }, { wrongHead: true }]) {
      const remote = harness(option)
      await expect(publish(remote)).rejects.toThrow()
      expect(remote.calls.some(call => call.command === 'gh')).toBe(false)
    }
  })
})

describe('Release 草稿资产必须匹配本地期望', () => {
  it.each(['books-1.1.4.tgapp', 'cinema-1.1.2.tgapp', 'comics-1.0.8.tgapp', 'shorts-1.0.3.tgapp', 'catalog.json', 'SHA256SUMS'])('即使大小不变，篡改 %s 也禁止转正', async name => {
    const remote = harness({ mutateDownload(files) { const buffer = files.get(name)!; buffer[0] ^= 1 } })
    await expect(publish(remote)).rejects.toThrow('本地期望不符')
    expect(remote.created).toBe(true)
    expect(remote.published).toBe(false)
  })

  it('攻击者重算下载的 SHA256SUMS 仍不能伪造本地已验证资产', async () => {
    const remote = harness({ mutateDownload(files) {
      files.get('shorts-1.0.3.tgapp')![50] ^= 1
      files.set('SHA256SUMS', Buffer.from(formatSha256Sums([...files].filter(([name]) => name !== 'SHA256SUMS').map(([name, buffer]) => ({ name, sha256: sha256Hex(buffer) })))))
    } })
    await expect(publish(remote)).rejects.toThrow('本地期望不符')
    expect(remote.published).toBe(false)
  })

  it.each(['missing', 'extra', 'shorter', 'larger'])('资产集合或实际大小 %s 必须失败', async change => {
    const remote = harness({ mutateDownload(files) {
      const name = 'catalog.json', buffer = files.get(name)!
      if (change === 'missing') files.delete(name)
      if (change === 'extra') files.set('unwanted.txt', Buffer.from('不应发布'))
      if (change === 'shorter') files.set(name, buffer.subarray(0, buffer.length - 1))
      if (change === 'larger') files.set(name, Buffer.concat([buffer, Buffer.from(' ')]))
    } })
    await expect(publish(remote)).rejects.toThrow()
    expect(remote.created).toBe(true)
    expect(remote.published).toBe(false)
  })

  it('草稿下载或上传失败保留人工处理提示，错误不泄露 gh URL', async () => {
    for (const option of [{ downloadError: true }, { createError: true }, { apiErrorAt: 3 }]) {
      const remote = harness(option)
      const error = await publish(remote).catch((value: Error) => value)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('请维护者检查处理后重试')
      expect((error as Error).message).not.toContain('signed.invalid')
      expect((error as Error).message).not.toContain('token=')
      expect(remote.published).toBe(false)
    }
  })

  it.each([2, 4])('创建前/转正前的第 %s 次历史查询失败也关闭', async apiErrorAt => {
    const remote = harness({ apiErrorAt })
    await expect(publish(remote)).rejects.toThrow('查询完整 Release 历史列表失败')
    expect(remote.created).toBe(apiErrorAt === 4)
    expect(remote.published).toBe(false)
  })

  it('下载期间出现另一个稳定 Release 即使版本更低也不能丢历史转正', async () => {
    const remote = harness({ history: [release('v1.0.0')], previous: serializeCatalog(previousCatalog), mutateDownload(_files, releases) { releases.push(release('v1.0.1', 20)) } })
    await expect(publish(remote, 'v1.0.2')).rejects.toThrow('历史发生变化')
    expect(remote.published).toBe(false)
  })

  it('新建草稿被外部替换或提前发布时不得再次发布', async () => {
    const remote = harness({ mutateDownload(_files, releases) { releases[0].id++ } })
    await expect(publish(remote)).rejects.toThrow('草稿状态已变化')
    expect(remote.published).toBe(false)
  })

  it('发布输入缺少一个当前官方包或混入旧包时在创建前拒绝', async () => {
    const missing = `${temporary}/missing`, extra = `${temporary}/extra`
    await cp(packagesDir, missing, { recursive: true })
    await rm(`${missing}/shorts-1.0.3.tgapp`)
    await cp(packagesDir, extra, { recursive: true })
    await copyFile(`${temporary}/old-packages/books-0.9.0.tgapp`, `${extra}/books-0.9.0.tgapp`)
    for (const path of [missing, extra]) {
      const remote = harness()
      await expect(publish(remote, 'v1.0.0', path)).rejects.toThrow('恰好包含四个官方插件当前包')
      expect(remote.created).toBe(false)
    }
  })

  it('同包数但不是当前源码完整清单也必须重新构建', async () => {
    const stale = `${temporary}/stale`
    await cp(packagesDir, stale, { recursive: true })
    await rm(`${stale}/books-1.1.4.tgapp`)
    await copyFile(`${temporary}/old-packages/books-0.9.0.tgapp`, `${stale}/books-0.9.0.tgapp`)
    const remote = harness()
    await expect(publish(remote, 'v1.0.0', stale)).rejects.toThrow('当前包完整清单与源码不符')
    expect(remote.created).toBe(false)
  })

  it('工作流仓库级串行且只有同仓库 tag 事件获得发布门禁，宿主不进入公开 CI', async () => {
    const workflow = await readFile(`${root}/.github/workflows/release.yml`, 'utf8')
    expect(workflow).toContain('group: tgdrive-app-stable-release')
    expect(workflow).not.toContain('group: release-${{ github.ref }}')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain("github.event_name == 'push' && github.repository == 'lengyuesky/tgdrive-app'")
    expect(workflow).toContain('git merge-base --is-ancestor HEAD refs/remotes/origin/main')
    expect(workflow.indexOf('git merge-base --is-ancestor')).toBeLessThan(workflow.indexOf('node ./release.mjs validate-tag'))
    expect(workflow.indexOf('node ./release.mjs validate-tag')).toBeLessThan(workflow.indexOf('run: npm ci'))
    expect(workflow).toContain('node-version: 22.22.0')
    expect(workflow).toContain('node ./release.mjs publish ./catalog')
    expect(workflow).not.toMatch(/curl|\|\| true|test:e2e|TGDRIVE_HOST_DIR|--clobber/)
  })
})
