// Release 门禁：历史查询失败即停止，草稿资产与本地期望逐字节校验后才允许发布。
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_REPOSITORY, MAX_MANIFEST_BYTES, collectPackages, compareStableVersions,
  formatSha256Sums, mergeCatalogs, readCatalog, readLimitedFile, serializeCatalog,
  sha256Hex, validateManifest, validateReleaseTag, validateRepository,
} from './catalog.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const officialApps = ['shorts', 'books', 'comics', 'cinema']
const exec = promisify(execFile)

async function runCommand(command, args, options) {
  const result = await exec(command, args, {
    ...options, env: { ...process.env, GH_HOST: 'github.com' }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

async function invoke(run, command, args, label, cwd = root) {
  try {
    return await run(command, args, { cwd })
  } catch {
    // 不转发 gh 的 stderr，避免将下载签名 URL 或凭据带入日志。
    throw new Error(`${label}失败，已停止发布`)
  }
}

export function parseReleasePages(content) {
  let pages
  try { pages = JSON.parse(content) } catch { throw new Error('Release 列表不是有效 JSON，不能判定为首次发布') }
  if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) throw new Error('Release 分页响应无效，不能判定为首次发布')
  const releases = pages.flat()
  for (const release of releases) {
    if (!release || typeof release !== 'object' || !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.tag_name !== 'string' || !release.tag_name || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || (!release.draft && (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))))) {
      throw new Error('Release 元数据无效，不能判定为首次发布')
    }
  }
  return releases
}

/** 从完整分页结果选择最高稳定版本，不依赖可被人工回退的 latest 指针。 */
export function selectPreviousRelease(releases, releaseTag, expectedDraftId) {
  validateReleaseTag(releaseTag)
  const tags = new Set()
  const ids = new Set()
  for (const release of releases) {
    if (tags.has(release.tag_name) || ids.has(release.id)) throw new Error('Release 列表包含重复记录，停止发布')
    tags.add(release.tag_name)
    ids.add(release.id)
  }
  const existing = releases.find(release => release.tag_name === releaseTag)
  if (expectedDraftId === undefined && existing) throw new Error(`Release ${releaseTag} 已存在（包括草稿），禁止覆盖；请维护者检查并处理残留草稿`)
  if (expectedDraftId !== undefined && (!existing || existing.id !== expectedDraftId || !existing.draft || existing.prerelease)) throw new Error('新建草稿状态已变化，禁止发布或覆盖')
  const stable = releases.filter(release => !release.draft && !release.prerelease)
  // 非预发布却使用非法稳定标签时拒绝继续，不能静默丢失其可能存在的历史。
  for (const release of stable) validateReleaseTag(release.tag_name)
  stable.sort((a, b) => compareStableVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
  const previous = stable[0] ?? null
  if (!previous && releaseTag !== 'v1.0.0') throw new Error('仓库首次稳定发布必须为 v1.0.0')
  if (previous && compareStableVersions(releaseTag.slice(1), previous.tag_name.slice(1)) <= 0) throw new Error('新稳定 tag 必须大于所有已发布稳定 tag，禁止乱序或同版本发布')
  return previous
}

async function listReleases(run, repository) {
  const raw = await invoke(run, 'gh', ['api', `repos/${repository}/releases?per_page=100`, '--method', 'GET', '--paginate', '--slurp', '--hostname', 'github.com'], '查询完整 Release 历史列表')
  return parseReleasePages(raw)
}

function stableHistory(releases) {
  return releases.filter(release => !release.draft && !release.prerelease).map(release => `${release.id}:${release.tag_name}`).sort()
}

function assertSameHistory(before, after) {
  if (!isDeepStrictEqual(stableHistory(before), stableHistory(after))) throw new Error('发布期间稳定 Release 历史发生变化，请重新验证完整历史后重试')
}

export async function verifyMainAncestor(releaseTag, run = runCommand) {
  validateReleaseTag(releaseTag)
  await invoke(run, 'git', ['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'], '获取可信 main 分支')
  const head = await invoke(run, 'git', ['rev-parse', 'HEAD'], '读取当前提交')
  const tag = await invoke(run, 'git', ['rev-parse', `refs/tags/${releaseTag}^{commit}`], '读取发布 tag 提交')
  if (!head.trim() || head.trim() !== tag.trim()) throw new Error('当前构建提交与发布 tag 不一致')
  await invoke(run, 'git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], '验证发布提交为 main 祖先')
}

/** 从当前四个真实包生成期望资产，不信任目录里遗留的 catalog 或 SHA256SUMS。 */
export async function prepareReleaseAssets({ packagesDir, previousCatalog, releaseTag, repository }) {
  const packages = await collectPackages(packagesDir)
  if (packages.length !== officialApps.length || new Set(packages.map(pkg => pkg.manifest.id)).size !== officialApps.length || packages.some(pkg => !officialApps.includes(pkg.manifest.id))) throw new Error('发布必须恰好包含四个官方插件当前包，不能混入旧包或其他文件版本')
  for (const pkg of packages) {
    const manifest = JSON.parse((await readLimitedFile(join(root, pkg.manifest.id, 'app.json'), MAX_MANIFEST_BYTES, '源清单')).toString('utf8'))
    validateManifest(manifest)
    if (!isDeepStrictEqual(manifest, pkg.manifest)) throw new Error('当前包完整清单与源码不符，请重新构建')
  }
  const catalog = mergeCatalogs({ currentEntries: packages, previousCatalog, releaseTag, repository })
  const catalogBuffer = Buffer.from(serializeCatalog(catalog))
  const assets = packages.map(pkg => ({ name: pkg.filename, buffer: pkg.buffer }))
  assets.push({ name: 'catalog.json', buffer: catalogBuffer })
  const sums = formatSha256Sums(assets.map(asset => ({ name: asset.name, sha256: sha256Hex(asset.buffer) })))
  assets.push({ name: 'SHA256SUMS', buffer: Buffer.from(sums) })
  return {
    catalog,
    assets: assets.map(asset => ({ ...asset, size: asset.buffer.length, sha256: sha256Hex(asset.buffer) })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** 期望集合来自上传前的本地快照，连 SHA256SUMS 自身也必须匹配。 */
export async function verifyDownloadedAssets(directory, expectedAssets) {
  const files = await readdir(directory, { withFileTypes: true })
  const expectedNames = expectedAssets.map(asset => asset.name).sort()
  if (files.some(file => !file.isFile()) || !isDeepStrictEqual(files.map(file => file.name).sort(), expectedNames)) throw new Error('草稿下载资产集合与本地期望不符（缺失、多余或非普通文件）')
  for (const asset of expectedAssets) {
    const buffer = await readLimitedFile(join(directory, asset.name), asset.size, '草稿资产')
    if (buffer.length !== asset.size || sha256Hex(buffer) !== asset.sha256) throw new Error(`草稿资产大小或 SHA256 与本地期望不符：${asset.name}`)
  }
}

export async function publishRelease({ packagesDir, releaseTag, repository = DEFAULT_REPOSITORY, temporaryRoot = tmpdir(), run = runCommand }) {
  validateRepository(repository)
  validateReleaseTag(releaseTag)
  if (repository !== DEFAULT_REPOSITORY) throw new Error('自动发布仅允许官方同仓库可信事件')
  await verifyMainAncestor(releaseTag, run)
  const history = await listReleases(run, repository)
  const previous = selectPreviousRelease(history, releaseTag)
  const temporary = await mkdtemp(join(temporaryRoot, 'tgdrive-release-'))
  let draftMayExist = false
  try {
    let previousCatalog = null
    if (previous) {
      const previousDir = join(temporary, 'previous')
      await mkdir(previousDir)
      await invoke(run, 'gh', ['release', 'download', previous.tag_name, '--repo', repository, '--pattern', 'catalog.json', '--dir', previousDir], '下载上一稳定 catalog', temporary)
      previousCatalog = await readCatalog(join(previousDir, 'catalog.json'), { repository })
      if (previousCatalog.release_tag !== previous.tag_name) throw new Error('上一稳定 catalog 的 release_tag 与实际 Release 不符')
    }
    const prepared = await prepareReleaseAssets({ packagesDir, previousCatalog, releaseTag, repository })
    const uploadDir = join(temporary, 'upload')
    const downloadDir = join(temporary, 'download')
    await mkdir(uploadDir)
    await mkdir(downloadDir)
    for (const asset of prepared.assets) await writeFile(join(uploadDir, asset.name), asset.buffer, { flag: 'wx' })
    await verifyDownloadedAssets(uploadDir, prepared.assets)
    const beforeCreate = await listReleases(run, repository)
    selectPreviousRelease(beforeCreate, releaseTag)
    assertSameHistory(history, beforeCreate)
    // 创建成功但上传中断时也可能留下草稿，重试前必须由维护者处理。
    draftMayExist = true
    await invoke(run, 'gh', ['release', 'create', releaseTag, '--repo', repository, '--verify-tag', '--draft', '--title', releaseTag, '--notes', `tgdrive-app 官方插件发布 ${releaseTag}`, ...prepared.assets.map(asset => join(uploadDir, asset.name))], '创建草稿 Release 并上传资产')
    const afterCreate = await listReleases(run, repository)
    const draft = afterCreate.find(release => release.tag_name === releaseTag)
    if (!draft || !draft.draft) throw new Error('未能确认新建 Release 为草稿，停止发布')
    selectPreviousRelease(afterCreate, releaseTag, draft.id)
    assertSameHistory(history, afterCreate)
    await invoke(run, 'gh', ['release', 'download', releaseTag, '--repo', repository, '--dir', downloadDir], '下载草稿资产', temporary)
    await verifyDownloadedAssets(downloadDir, prepared.assets)
    const beforePublish = await listReleases(run, repository)
    selectPreviousRelease(beforePublish, releaseTag, draft.id)
    assertSameHistory(history, beforePublish)
    await invoke(run, 'gh', ['release', 'edit', releaseTag, '--repo', repository, '--draft=false', '--latest'], '正式发布并设置 latest')
    return { catalog: prepared.catalog, assets: prepared.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
  } catch (error) {
    if (draftMayExist) throw new Error(`${error.message}；可能残留的草稿不会自动覆盖或删除，请维护者检查处理后重试`)
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'validate-tag' && args.length === 1) {
    validateReleaseTag(args[0])
    console.log('稳定 tag 校验通过')
    return
  }
  if (command !== 'publish') throw new Error('用法：release.mjs publish <包目录> --tag=vX.Y.Z --repo=owner/repo')
  const packagesDir = resolve(args.shift() ?? './catalog')
  let releaseTag = process.env.TGDRIVE_APP_RELEASE_TAG
  let repository = process.env.TGDRIVE_APP_GITHUB_REPO ?? DEFAULT_REPOSITORY
  for (const arg of args) {
    if (arg.startsWith('--tag=')) releaseTag = arg.slice('--tag='.length)
    else if (arg.startsWith('--repo=')) repository = arg.slice('--repo='.length)
    else throw new Error(`未知发布参数：${arg}`)
  }
  const result = await publishRelease({ packagesDir, releaseTag, repository })
  console.log(`Release ${releaseTag} 已通过全部门禁并发布为 latest；${result.assets.length} 个资产，${result.catalog.entries.length} 条历史记录`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Release 失败：', error.message)
    process.exitCode = 1
  })
}
