import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { applications, createOutput, ensureTool, exists, generateCatalog, tool, writeJson } from './pipeline.mjs'
import { executeRelease, prepareRelease, releaseDraftMarker } from './release-core.mjs'

/** 文件系统远端替身：只在隔离目录创建草稿/资产/发布状态，不联网，不提交 Git。 */
export class OfflineRemote {
  constructor(directory, stateDirectory, options = {}) {
    this.directory = directory; this.stateDirectory = stateDirectory; this.options = options
    this.events = []; this.uploads = 0; this.sourceChecks = 0
  }

  async assertSource() {
    this.sourceChecks++
    if (this.options.staleAt === this.sourceChecks) throw new Error('main 已推进；离线模拟拒绝过期源码')
  }

  async getRelease(tag) {
    const file = resolve(this.directory, tag, 'release.json')
    if (!await exists(file)) return null
    const release = JSON.parse(await readFile(file, 'utf8'))
    release.assets = await Promise.all((await readdir(resolve(this.directory, tag, 'assets'))).sort().map(async name => {
      const bytes = await readFile(resolve(this.directory, tag, 'assets', name))
      return { id: 1, name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
    }))
    return release
  }

  async createRelease(tag, source) {
    const directory = resolve(this.directory, tag)
    await mkdir(directory); await mkdir(resolve(directory, 'assets'))
    await writeJson(resolve(directory, 'release.json'), { id: 1, tag_name: tag, source, draft: true, prerelease: false, body: releaseDraftMarker })
    this.events.push({ type: 'create', tag })
    return this.getRelease(tag)
  }

  async upload(release, report) {
    if (!release.draft) throw new Error('离线不可变 Release 已锁定，不能追加或覆盖资产')
    this.uploads++
    if (this.options.failUploadAt === this.uploads) throw new Error('离线模拟上传中断')
    await copyFile(report.path, resolve(this.directory, release.tag_name, 'assets', report.filename), constants.COPYFILE_EXCL)
    this.events.push({ type: 'upload', name: report.filename })
  }

  async download(release, asset, report, directory) {
    const path = resolve(directory, report.filename)
    await copyFile(this.options.downloadReplacement?.[report.filename] ?? resolve(this.directory, release.tag_name, 'assets', asset.name), path, constants.COPYFILE_EXCL)
    this.events.push({ type: release.draft ? 'draft-download' : 'public-download', name: report.filename })
    return path
  }

  async publish(release) {
    const file = resolve(this.directory, release.tag_name, 'release.json')
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (!value.draft || !value.body.startsWith(releaseDraftMarker)) throw new Error('离线远端不是本管线的待发布草稿')
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeJson(temporary, { ...value, draft: false })
    await rename(temporary, file)
    this.events.push({ type: 'publish', tag: release.tag_name })
    return this.getRelease(release.tag_name)
  }

  async commitCatalog(directory) {
    if (this.options.failCommit) throw new Error('离线模拟目录提交中断')
    // 只复制演练状态；它不是 Git 提交，也绝不修改应用仓库。
    for (const name of ['catalog-history.json', 'catalog.json']) {
      await readFile(resolve(this.stateDirectory, name), 'utf8')
      const temporary = resolve(this.stateDirectory, `${name}.${randomUUID()}.tmp`)
      await copyFile(resolve(directory, name), temporary, constants.COPYFILE_EXCL)
      await rename(temporary, resolve(this.stateDirectory, name))
    }
    this.events.push({ type: 'state-snapshot' })
    return 'offline-state-snapshot'
  }

  async seed(reports) {
    for (const report of reports) {
      const tag = `${report.manifest.id}-v${report.manifest.version}`
      let release = await this.getRelease(tag)
      if (!release) release = await this.createRelease(tag, 'offline-seed')
      await this.upload(release, report)
    }
    for (const tag of new Set(reports.map(report => `${report.manifest.id}-v${report.manifest.version}`))) await this.publish(await this.getRelease(tag))
    this.events.length = 0; this.uploads = 0
  }
}

export async function emptyState(directory, repository, logs) {
  await createOutput(directory)
  await tool(['catalog', repository, directory], logs)
  await tool(['catalog-check', resolve(directory, 'catalog.json')], logs)
  return directory
}

/** 创建一个完整合法但字节不同的纯页面包，用来证明历史门禁而非仅触发 CRC 错误。 */
export async function pageFixture(directory, manifest, logs, text = '同版本的不同演练内容') {
  directory = await createOutput(directory)
  const source = resolve(directory, 'source'), output = resolve(directory, 'packages')
  await mkdir(source, { recursive: true })
  const page = resolve(source, manifest.page.entry)
  await mkdir(dirname(page), { recursive: true })
  await writeFile(page, `<!doctype html><html><title>${text}</title><body>${text}</body></html>`)
  await writeFile(resolve(source, 'app.json'), JSON.stringify(manifest))
  if (manifest.icon) {
    await mkdir(dirname(resolve(source, manifest.icon)), { recursive: true })
    await writeFile(resolve(source, manifest.icon), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>')
  }
  const report = await tool(['pack', source, output, 'web'], logs)
  const path = resolve(output, report.filename)
  await tool(['verify', path], logs)
  return path
}

function lowerVersion(version) {
  const parts = version.split('.').map(BigInt)
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] > 0n) return [...parts.slice(0, index), parts[index] - 1n, ...parts.slice(index + 1).map(() => 0n)].join('.')
  }
  throw new Error('0.0.0 不存在更低的稳定版本，不能执行倒退演练')
}

export async function rehearseRelease(packageDirectory, output, options = {}) {
  output = await createOutput(output)
  const repository = options.repository ?? 'lengyuesky/tgdrive-app'
  const logs = resolve(output, 'rehearsal-logs')
  await ensureTool(logs)
  const state = resolve(output, 'rehearsal-state')
  if (options.stateDirectory) {
    await createOutput(state)
    for (const name of ['catalog.json', 'catalog-history.json']) await copyFile(resolve(options.stateDirectory, name), resolve(state, name), constants.COPYFILE_EXCL)
  } else await emptyState(state, repository, logs)
  const first = await prepareRelease(packageDirectory, resolve(output, 'first-release'), { repository, stateDirectory: state })
  const mockDirectory = resolve(output, 'mock-releases'); await mkdir(mockDirectory)
  const remote = new OfflineRemote(mockDirectory, state)
  const existing = new Set([...first.previous.entries, ...first.history.entries].map(entry => `${entry.manifest.id}@${entry.manifest.version}`))
  if (existing.size) await remote.seed(first.reports.filter(report => existing.has(`${report.manifest.id}@${report.manifest.version}`)))
  const initial = await executeRelease(first, remote, 'offline-source')
  const replay = await prepareRelease(packageDirectory, resolve(output, 'replay-release'), { repository, stateDirectory: state })
  const repeated = await executeRelease(replay, remote, 'offline-source')
  assert.equal(repeated.skipped, applications.length)
  for (const key of ['created', 'uploaded', 'published']) assert.equal(repeated[key], 0)
  assert.equal(repeated.committed, false)
  const reader = first.reports.find(report => report.manifest.id === 'reader')
  const sameVersion = await pageFixture(resolve(output, 'changed-version-fixture'), reader.manifest, logs)
  const downgrade = await pageFixture(resolve(output, 'downgrade-fixture'), { ...reader.manifest, version: lowerVersion(reader.manifest.version) }, logs, '较低版本的演练包')
  const rejected = {}
  for (const [scenario, replacement] of [['同版本换包', sameVersion], ['版本倒退', downgrade]]) {
    const packages = first.reports.map(report => report.manifest.id === 'reader' ? replacement : report.path)
    let failure
    try { await generateCatalog(packages, resolve(output, `${scenario === '同版本换包' ? 'changed' : 'downgrade'}-catalog`), logs, { repository, stateDirectory: state }) }
    catch (error) { failure = error }
    if (!failure) throw new Error(`${scenario} 未被目录历史拒绝`)
    rejected[scenario] = failure.message
  }
  await tool(['catalog-check', resolve(state, 'catalog.json')], logs)
  const result = { mode: 'dry-run', networkUsed: false, gitCommitCreated: false, initial, repeated, sameVersionReplacementRejected: Boolean(rejected['同版本换包']), downgradeRejected: Boolean(rejected['版本倒退']), rejected, catalog: resolve(state, 'catalog.json') }
  await writeJson(resolve(output, 'rehearsal.json'), result)
  process.stdout.write('离线演练通过：未变化版本跳过、合法同版本换包被拒、版本倒退被拒；未联网或提交 Git\n')
  return result
}
