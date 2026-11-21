import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { LIMITS } from '../contract/types/contract.ts'
import { releaseDraftMarker } from './release-core.mjs'

// 契约 §5.2 的重定向边界；不接受 CDN、任意外站或查询中嵌套的下载地址。
const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const signedQueryNames = new Set([
  'sp', 'sv', 'sr', 'spr', 'se', 'st', 'sig', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'jwt', 'rscd', 'rsct', 'rscc', 'rsce', 'rscl',
  'response-content-disposition', 'response-content-type', 'response-cache-control', 'response-content-encoding', 'response-content-language', 'response-expires',
  'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-expires', 'x-amz-security-token', 'x-amz-signature', 'x-amz-signedheaders',
  'awsaccesskeyid', 'expires', 'signature', 'security-token',
])

export function validateDownloadUrl(value, initial) {
  let url
  try { url = new URL(value) } catch { throw new Error('资产下载地址非法') }
  if (Buffer.byteLength(value) > LIMITS.MAX_URI_BYTES || /[\x00-\x20\x7f]/.test(value) || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || !downloadHosts.has(url.hostname)) throw new Error('资产下载重定向超出契约允许的 HTTPS 边界')
  if (initial && (url.hostname !== 'github.com' || url.search)) throw new Error('资产初始地址必须是无查询的 GitHub Release URL')
  const seen = new Set()
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase()
    if (!signedQueryNames.has(normalized) || seen.has(normalized)) throw new Error('资产重定向含非签发下载查询参数')
    seen.add(normalized)
  }
  return url
}

async function jsonResponse(response) {
  let bytes = 0, text = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 8 * 1024 * 1024) throw new Error('GitHub 元数据响应超出发布预算')
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  try { return JSON.parse(text) } catch { throw new Error('GitHub 元数据不是合法 JSON') }
}

/** 真实适配器只能在 main 的显式手动工作流中构造；令牌只进入固定 GitHub API 请求头。 */
export class GitHubRemote {
  constructor(repository, source) {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('真实发布只允许 main 分支上的 workflow_dispatch')
    if (repository !== process.env.GITHUB_REPOSITORY || source !== process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(source)) throw new Error('发布仓库或源码提交与手动工作流不符')
    if (process.env.GITHUB_API_URL && process.env.GITHUB_API_URL !== 'https://api.github.com') throw new Error('此发布管线只支持 GitHub.com 的公开仓库')
    const token = process.env.GH_TOKEN
    if (!token) throw new Error('手动发布缺少 GitHub 令牌')
    this.repository = repository
    this.source = source
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'app-release-client' }
  }

  async api(method, path, body, missing = false) {
    let response
    try {
      response = await fetch(`https://api.github.com/repos/${this.repository}/${path}`, { method, headers: { ...this.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(60000) })
    } catch { throw new Error('GitHub API 网络请求失败；未记录令牌或请求地址') }
    if (missing && response.status === 404) { await response.body?.cancel(); return null }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub API 请求失败（HTTP ${response.status}）；不会覆盖资产或强推目录`) }
    return jsonResponse(response)
  }

  async assertSource(source) {
    const ref = await this.api('GET', 'git/ref/heads/main')
    if (ref.object.sha !== source || source !== this.source) throw new Error('main 已推进；请从最新 main 重新手动运行，不能发布过期源码')
  }

  async getRelease(tag) {
    const published = await this.api('GET', `releases/tags/${encodeURIComponent(tag)}`, undefined, true)
    if (published) return published
    // 按标签接口仅保证查询正式 Release；草稿必须从有写权限的分页列表找，才能安全续跑。
    const matches = []
    for (let page = 1; page <= 100; page++) {
      const releases = await this.api('GET', `releases?per_page=100&page=${page}`)
      matches.push(...releases.filter(release => release.tag_name === tag))
      if (releases.length < 100) {
        if (matches.length > 1) throw new Error(`${tag} 有多个同名草稿，不能自行选择、覆盖或删除`)
        return matches[0] ?? null
      }
    }
    throw new Error('Release 列表超过安全查询预算；不会冒险创建重复草稿')
  }

  async createRelease(tag, source) {
    if (await this.getRelease(tag)) throw new Error(`${tag} 在预检后已出现，请重跑核验既有 Release 或草稿`)
    const ref = await this.api('GET', `git/ref/tags/${encodeURIComponent(tag)}`, undefined, true)
    if (ref) {
      let object = ref.object
      for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await this.api('GET', `git/tags/${object.sha}`)).object
      if (object.type !== 'commit' || object.sha !== source) throw new Error(`${tag} 已指向其他提交；不能移动既有标签`)
    }
    return this.api('POST', 'releases', { tag_name: tag, target_commitish: source, name: tag, body: `${releaseDraftMarker}\n源提交：${source}\n应用包已通过契约、真实 ZIP/ELF 与隔离启动门禁；安装目录仅在公开下载摘要核验后更新。`, draft: true, prerelease: false, make_latest: 'false' })
  }

  async publish(release) {
    if (!release.draft || !release.body?.startsWith(releaseDraftMarker)) throw new Error('只能发布本管线创建且已核验的草稿，不修改既有正式 Release')
    return this.api('PATCH', `releases/${release.id}`, { draft: false, make_latest: 'false' })
  }

  async upload(release, report) {
    if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('Release 标识非法')
    let response
    try {
      response = await fetch(`https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?name=${encodeURIComponent(report.filename)}`, {
        method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': report.size },
        body: createReadStream(report.path), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(LIMITS.PACKAGE_DOWNLOAD_SECONDS * 1000),
      })
    } catch { throw new Error(`${report.filename} 上传失败；不会重传覆盖同名资产`) }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${report.filename} 上传失败（HTTP ${response.status}）；不存在覆盖模式，修复后安全重跑`) }
    return jsonResponse(response)
  }

  async download(release, asset, report, directory) {
    // 草稿先使用 API 读取原字节；正式发布后必须再证明无令牌的精确公开 URL 可下载。
    const tag = `${report.manifest.id}-v${report.manifest.version}`
    const initial = `https://github.com/${this.repository}/releases/download/${tag}/${report.filename}`
    if (asset.browser_download_url !== initial) throw new Error(`${report.filename} 的 Release 下载地址不精确匹配契约`)
    if (release.draft && (!Number.isSafeInteger(asset.id) || asset.id <= 0)) throw new Error('草稿资产标识非法')
    const signal = AbortSignal.timeout(LIMITS.PACKAGE_DOWNLOAD_SECONDS * 1000)
    for (let attempt = 0; attempt < 4; attempt++) {
      const attemptDirectory = resolve(directory, `attempt-${attempt}`)
      await mkdir(attemptDirectory)
      let current = initial, response
      for (let redirects = 0; redirects <= LIMITS.MAX_DOWNLOAD_REDIRECTS; redirects++) {
        const authenticated = release.draft && redirects === 0
        const requestUrl = authenticated ? `https://api.github.com/repos/${this.repository}/releases/assets/${asset.id}` : current
        if (!authenticated) validateDownloadUrl(current, !release.draft && current === initial)
        try {
          response = await fetch(requestUrl, { redirect: 'manual', headers: authenticated ? { ...this.headers, Accept: 'application/octet-stream' } : { 'User-Agent': 'app-release-client' }, signal })
        } catch { throw new Error(`${report.filename} 的资产下载失败；不会记录签名地址`) }
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location || redirects === LIMITS.MAX_DOWNLOAD_REDIRECTS) throw new Error('资产重定向次数超限或缺少地址')
        try { current = new URL(location, requestUrl).href } catch { throw new Error('资产重定向地址非法') }
        // 后续请求只走契约允许的下载域，决不转发 API 令牌。
        validateDownloadUrl(current, false)
      }
      if (response.status !== 200) {
        const retryable = [404, 502, 503, 504].includes(response.status)
        await response.body?.cancel()
        if (retryable && attempt < 3) { await delay(1000 * 2 ** attempt, undefined, { signal }); continue }
        throw new Error(`${report.filename} 的${release.draft ? '草稿资产' : '无令牌公开'}下载失败（HTTP ${response.status}）`)
      }
      const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
      if ((length && length !== report.size) || (encoding && encoding !== 'identity')) { await response.body?.cancel(); throw new Error(`${report.filename} 的下载响应长度或表示与原包不符`) }
      let bytes = 0
      const budget = new Transform({ transform(chunk, _, callback) {
        bytes += chunk.length
        callback(bytes > LIMITS.MAX_PACKAGE_BYTES || bytes > Number(report.size) ? new Error('资产字节数超出已核验包') : null, chunk)
      } })
      const path = resolve(attemptDirectory, report.filename)
      try { await pipeline(Readable.fromWeb(response.body), budget, createWriteStream(path, { flags: 'wx' }), { signal }) }
      catch { throw new Error(`${report.filename} 的资产字节读取失败；不会更新目录`) }
      if (String(bytes) !== report.size) throw new Error(`${report.filename} 的资产实际长度不符`)
      return path
    }
  }

  async commitCatalog(directory, source) {
    await this.assertSource(source)
    const query = 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
    const input = {
      branch: { repositoryNameWithOwner: this.repository, branchName: 'main' },
      expectedHeadOid: source,
      message: { headline: 'chore(release): 更新应用目录与不可变发布历史' },
      fileChanges: { additions: await Promise.all(['catalog.json', 'catalog-history.json'].map(async path => ({ path, contents: (await readFile(resolve(directory, path))).toString('base64') }))) },
    }
    let response
    try {
      response = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { input } }), redirect: 'error', signal: AbortSignal.timeout(60000) })
    } catch { throw new Error('目录与历史提交请求失败；不会强推或清空历史') }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`目录与历史提交失败（HTTP ${response.status}），请检查分支保护与发布权限`) }
    const result = await jsonResponse(response)
    const oid = result.data?.createCommitOnBranch?.commit?.oid
    // expectedHeadOid 是服务端的分支头前置条件：两文件同一次提交，HEAD 变化就拒绝。
    if (result.errors?.length || !/^[a-f0-9]{40}$/.test(oid ?? '')) throw new Error('目录提交被拒绝：main 可能已推进或分支保护不允许发布；请从最新 main 重跑')
    return oid
  }
}
