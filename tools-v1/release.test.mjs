import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { applications, ensureTool, generateCatalog, packagePaths, root, tool, verifyPackages } from './pipeline.mjs'
import { executeRelease, prepareRelease } from './release-core.mjs'
import { GitHubRemote, validateDownloadUrl } from './release-github.mjs'
import { emptyState, OfflineRemote, pageFixture } from './release-offline.mjs'
import { release } from './release.mjs'

let directory, packages, logs, reports
const repository = 'example/apps'

// ELF 仅是与 tgapp 单测相同的格式夹具，不执行，也不计为原生启动验收。
function elf(target) {
  const bytes = Buffer.alloc(120)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes)
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(target === 'linux-amd64' ? 62 : 183, 18)
  bytes.writeUInt32LE(1, 20); bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(120n, 96); bytes.writeBigUInt64LE(120n, 104)
  return bytes
}

async function packFixture(manifest, target, stage, output) {
  await mkdir(dirname(resolve(stage, manifest.page.entry)), { recursive: true })
  await writeFile(resolve(stage, manifest.page.entry), `<!doctype html><title>${manifest.id} 发布格式夹具</title>`)
  await writeFile(resolve(stage, 'app.json'), JSON.stringify(manifest))
  if (manifest.icon) {
    await mkdir(dirname(resolve(stage, manifest.icon)), { recursive: true })
    await writeFile(resolve(stage, manifest.icon), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>')
  }
  if (target !== 'web') { await mkdir(resolve(stage, 'backend')); await writeFile(resolve(stage, 'backend/app'), elf(target)) }
  return tool(['pack', stage, output, target], logs)
}

before(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'tgapp-release-tests-'))
  logs = resolve(directory, 'logs'); packages = resolve(directory, 'packages')
  await ensureTool(logs)
  for (const app of applications) {
    const manifest = JSON.parse(await readFile(resolve(root, app.id, 'app.json'), 'utf8'))
    for (const target of app.targets) await packFixture(manifest, target, resolve(directory, 'sources', app.id, target), packages)
  }
  reports = await verifyPackages(await packagePaths(packages), logs)
})
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function context(name, options = {}) {
  const path = resolve(directory, name); await mkdir(path)
  const state = await emptyState(resolve(path, 'state'), repository, logs)
  const remoteDirectory = resolve(path, 'remote'); await mkdir(remoteDirectory)
  const remote = new OfflineRemote(remoteDirectory, state, options)
  const prepare = label => prepareRelease(packages, resolve(path, label), { repository, stateDirectory: state })
  return { path, state, remote, prepare }
}

async function checkedState(state) { return tool(['catalog-check', resolve(state, 'catalog.json')], logs) }

async function withoutNetwork(run) {
  const previous = globalThis.fetch
  globalThis.fetch = () => { throw new Error('离线演练不应联网') }
  try { return await run() } finally { globalThis.fetch = previous }
}

async function githubEnvironment(run) {
  const keys = ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GH_TOKEN', 'GITHUB_API_URL']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), previousFetch = globalThis.fetch
  const source = 'a'.repeat(40)
  Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repository, GITHUB_SHA: source, GH_TOKEN: 'local-test-token', GITHUB_API_URL: 'https://api.github.com' })
  try { return await run(source) } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('真实发布默认禁止本地、PR 与非 main 环境，且不访问网络', async () => withoutNetwork(async () => {
  assert.throws(() => new GitHubRemote(repository, 'a'.repeat(40)), /workflow_dispatch|工作流/)
  await assert.rejects(release({ publish: true, output: resolve(directory, 'forbidden-live'), packages, repository }), /workflow_dispatch|工作流/)
}))

test('离线发布完整模拟首发、跳过不变版本、合法换包与版本倒退拒绝', async () => withoutNetwork(async () => {
  const beforeEnv = Object.fromEntries(['CARGO_NET_OFFLINE', 'TGAPP_OFFLINE_BUILD', 'RUSTUP_TOOLCHAIN'].map(key => [key, process.env[key]]))
  const result = await release({ dryRun: true, output: resolve(directory, 'rehearsal'), packages, repository })
  assert.equal(result.networkUsed, false); assert.equal(result.gitCommitCreated, false)
  assert.equal(result.initial.created, 4); assert.equal(result.initial.uploaded, 6); assert.equal(result.initial.published, 4)
  assert.equal(result.repeated.skipped, 4); assert.equal(result.repeated.uploaded, 0); assert.equal(result.repeated.committed, false)
  assert.equal(result.sameVersionReplacementRejected, true); assert.equal(result.downgradeRejected, true)
  for (const [key, value] of Object.entries(beforeEnv)) assert.equal(process.env[key], value)
}))

test('首次空目录允许没有历史，但不会修改源状态或自动补造非空历史', async () => {
  const { state, prepare } = await context('bootstrap-without-history')
  await readFile(resolve(state, 'catalog-history.json'))
  await rm(resolve(state, 'catalog-history.json'))
  const prepared = await prepare('first')
  assert.equal(prepared.previous.entries.length, 0)
  assert.equal(prepared.history.entries.length, 0)
  assert.equal(prepared.catalog.entries.length, 4)
  await assert.rejects(readFile(resolve(state, 'catalog-history.json')), { code: 'ENOENT' })
})

test('非空目录历史缺失时发布前失败，不会从目录重建历史', async () => {
  const { state, remote, prepare } = await context('missing-published-history')
  await executeRelease(await prepare('first'), remote, 'source')
  await readFile(resolve(state, 'catalog-history.json'))
  await rm(resolve(state, 'catalog-history.json'))
  remote.events.length = 0
  await assert.rejects(prepare('second'), /非空目录缺少发布历史/)
  assert.equal(remote.events.length, 0)
  await assert.rejects(readFile(resolve(state, 'catalog-history.json')), { code: 'ENOENT' })
})

test('历史必须包含现有目录的完整已见绑定，缺失或矛盾均失败', async () => {
  const { state, remote, prepare, path } = await context('inconsistent-published-history')
  await executeRelease(await prepare('first'), remote, 'source')
  const history = JSON.parse(await readFile(resolve(state, 'catalog-history.json'), 'utf8'))
  for (const scenario of ['missing-bindings', 'changed-binding']) {
    const source = resolve(path, scenario); await mkdir(source)
    await copyFile(resolve(state, 'catalog.json'), resolve(source, 'catalog.json'), constants.COPYFILE_EXCL)
    const changed = structuredClone(history)
    if (scenario === 'missing-bindings') changed.entries = []
    else Object.values(changed.entries[0].packages)[0].sha256 = 'f'.repeat(64)
    await writeFile(resolve(source, 'catalog-history.json'), JSON.stringify(changed))
    await assert.rejects(prepareRelease(packages, resolve(path, `${scenario}-release`), { repository, stateDirectory: source }), /没有记录在发布历史|包绑定矛盾/)
  }
})

test('汇总必须两架构齐全，拒绝缺包与重复目标', async () => {
  const paths = reports.map(report => report.path)
  await assert.rejects(verifyPackages(paths.slice(1), logs), /恰好覆盖/)
  await assert.rejects(verifyPackages([...paths, paths[0]], logs), /恰好覆盖/)
})

test('示例不进入真实目录，且包版本必须等于本轮源码版本', async () => {
  const manifest = reports.find(report => report.manifest.id === 'reader').manifest
  const example = await pageFixture(resolve(directory, 'example-fixture'), { ...manifest, id: 'example-page' }, logs)
  await assert.rejects(verifyPackages([example], logs), /正式应用/)
  const older = await pageFixture(resolve(directory, 'older-fixture'), { ...manifest, version: '0.0.0' }, logs)
  await assert.rejects(verifyPackages([older], logs), /本轮源码版本/)
})

test('同版本双架构必须拥有完全相同清单', async () => {
  const manifest = reports.find(report => report.manifest.id === 'cinema').manifest
  const changed = resolve(directory, 'different-manifest-packages'); await mkdir(changed)
  for (const report of reports.filter(report => !(report.manifest.id === 'cinema' && report.package.target === 'linux-arm64'))) await copyFile(report.path, resolve(changed, report.filename), constants.COPYFILE_EXCL)
  await packFixture({ ...manifest, description: manifest.description + ' 不同架构清单' }, 'linux-arm64', resolve(directory, 'different-manifest-source'), changed)
  const state = await emptyState(resolve(directory, 'different-manifest-state'), repository, logs)
  await assert.rejects(prepareRelease(changed, resolve(directory, 'different-manifest-release'), { repository, stateDirectory: state }), /相同完整 app.json/)
})

test('上传中途失败保留草稿，重跑只补缺失资产且不覆盖已上传包', async () => {
  const { state, remote, prepare } = await context('interrupted-upload', { failUploadAt: 2 })
  await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /上传中断/)
  assert.equal((await checkedState(state)).catalog.entries.length, 0)
  remote.options.failUploadAt = undefined
  const result = await executeRelease(await prepare('second'), remote, 'source')
  assert.equal(result.created, 3); assert.equal(result.uploaded, 5); assert.equal(result.published, 4)
  assert.equal(remote.events.filter(event => event.type === 'upload').length, 6)
  assert.equal(new Set(remote.events.filter(event => event.type === 'public-download').map(event => event.name)).size, 6)
  assert.equal(remote.events.at(-1).type, 'state-snapshot')
  assert.equal((await checkedState(state)).catalog.entries.length, 4)
})

test('Release 已发布但目录提交失败时，重跑不重新上传或改动 Release', async () => {
  const { state, remote, prepare } = await context('interrupted-commit', { failCommit: true })
  await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /目录提交中断/)
  assert.equal((await checkedState(state)).catalog.entries.length, 0)
  remote.options.failCommit = false
  const result = await executeRelease(await prepare('second'), remote, 'source')
  assert.equal(result.created, 0); assert.equal(result.uploaded, 0); assert.equal(result.published, 0)
  assert.equal(result.added, 4); assert.equal(result.committed, true)
  assert.equal((await checkedState(state)).catalog.entries.length, 4)
})

test('任何既有资产摘要不一致，都在创建其他 Release 前失败', async () => {
  const { state, remote, prepare } = await context('asset-conflict')
  const manifest = reports.find(report => report.manifest.id === 'reader').manifest
  const replacement = await pageFixture(resolve(directory, 'remote-conflict-fixture'), manifest, logs)
  await remote.seed([{ ...await tool(['verify', replacement], logs), path: replacement }])
  await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /大小不一致|摘要不一致/)
  assert.equal(remote.events.length, 0)
  assert.equal((await checkedState(state)).catalog.entries.length, 0)
})

test('公开下载字节不符时不更新目录，即使元数据摘要看起来正确', async () => {
  const { state, remote, prepare } = await context('download-conflict')
  await remote.seed(reports)
  const manifest = reports.find(report => report.manifest.id === 'reader').manifest
  const replacement = await pageFixture(resolve(directory, 'download-conflict-fixture'), manifest, logs)
  remote.options.downloadReplacement = { [reports.find(report => report.manifest.id === 'reader').filename]: replacement }
  await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /公开下载与已核验产物不一致/)
  assert.equal((await checkedState(state)).catalog.entries.length, 0)
  assert.equal(remote.events.some(event => ['create', 'upload', 'publish', 'state-snapshot'].includes(event.type)), false)
})

test('历史中的 Release 丢失时不清除绑定，也不重建已有版本', async () => {
  const { state, remote, prepare } = await context('missing-release')
  await executeRelease(await prepare('first'), remote, 'source')
  const tag = `${reports[0].manifest.id}-v${reports[0].manifest.version}`
  assert.ok(await remote.getRelease(tag))
  await rm(resolve(remote.directory, tag), { recursive: true })
  remote.events.length = 0
  await assert.rejects(executeRelease(await prepare('second'), remote, 'source'), /Release 不存在/)
  assert.equal(remote.events.length, 0)
  assert.equal((await checkedState(state)).catalog.entries.length, 4)
})

test('撤回条目仍保留历史，不允许删掉目录后同版本换包', async () => {
  const { state, remote, prepare, path } = await context('withdrawn-version')
  await executeRelease(await prepare('first'), remote, 'source')
  const withdrawn = await generateCatalog(reports.filter(report => report.manifest.id !== 'reader').map(report => report.path), resolve(path, 'withdrawn'), logs, { repository, stateDirectory: state })
  const manifest = reports.find(report => report.manifest.id === 'reader').manifest
  const replacement = await pageFixture(resolve(directory, 'withdrawn-fixture'), manifest, logs)
  const paths = reports.map(report => report.manifest.id === 'reader' ? replacement : report.path)
  await assert.rejects(generateCatalog(paths, resolve(path, 'restore'), logs, { repository, stateDirectory: withdrawn.directory }), /不可变|不能|改变|摘要|绑定/)
})

test('main 在上传前或正式发布前推进时都拒绝更新目录', async () => {
  for (const staleAt of [2, 3]) {
    const { state, remote, prepare } = await context(`stale-source-${staleAt}`, { staleAt })
    await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /main 已推进/)
    assert.equal((await checkedState(state)).catalog.entries.length, 0)
    if (staleAt === 2) assert.equal(remote.events.length, 0)
    assert.equal(remote.events.some(event => event.type === 'state-snapshot'), false)
  }
})

test('非本管线的同名草稿不会被上传、发布或修改', async () => {
  const { state, remote, prepare } = await context('foreign-draft')
  const reader = reports.find(report => report.manifest.id === 'reader')
  await remote.createRelease(`${reader.manifest.id}-v${reader.manifest.version}`, 'source')
  remote.events.length = 0
  const getRelease = remote.getRelease.bind(remote)
  remote.getRelease = async tag => { const value = await getRelease(tag); return value && { ...value, body: '其他维护者创建的草稿' } }
  await assert.rejects(executeRelease(await prepare('first'), remote, 'source'), /本管线的待发布草稿/)
  assert.equal(remote.events.length, 0)
  assert.equal((await checkedState(state)).catalog.entries.length, 0)
})

test('草稿从分页列表续跑，多个同名草稿明确失败而非重新创建', async () => githubEnvironment(async source => {
  const remote = new GitHubRemote(repository, source), calls = []
  const tag = 'reader-v1.0.0', draft = { id: 41, tag_name: tag, draft: true, assets: [] }
  remote.api = async (_, path) => {
    calls.push(path)
    if (path.startsWith('releases/tags/')) return null
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => ({ tag_name: `other-${index}`, draft: false }))
    return [draft]
  }
  assert.deepEqual(await remote.getRelease(tag), draft)
  assert.ok(calls.includes('releases?per_page=100&page=2'))
  remote.api = async (_, path) => path.startsWith('releases/tags/') ? null : [draft, { ...draft, id: 42 }]
  await assert.rejects(remote.getRelease(tag), /多个同名草稿/)
}))

test('目录与历史使用单次分支头前置条件提交，服务端拒绝时不强推', async () => githubEnvironment(async source => {
  const state = await emptyState(resolve(directory, 'graphql-state'), repository, logs)
  const remote = new GitHubRemote(repository, source), mutations = []
  let refused = false
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: source } }))
    assert.equal(url, 'https://api.github.com/graphql')
    mutations.push(JSON.parse(options.body))
    return new Response(JSON.stringify(refused ? { errors: [{ message: 'expectedHeadOid mismatch' }] } : { data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40) } } } }))
  }
  assert.equal(await remote.commitCatalog(state, source), 'b'.repeat(40))
  const input = mutations[0].variables.input
  assert.equal(input.expectedHeadOid, source)
  assert.deepEqual(input.branch, { repositoryNameWithOwner: repository, branchName: 'main' })
  assert.deepEqual(input.fileChanges.additions.map(value => value.path), ['catalog.json', 'catalog-history.json'])
  for (const addition of input.fileChanges.additions) assert.deepEqual(Buffer.from(addition.contents, 'base64'), await readFile(resolve(state, addition.path)))
  refused = true
  await assert.rejects(remote.commitCatalog(state, source), /最新 main 重跑/)
  assert.equal(mutations.length, 2)
}))

test('下载仅接受契约列出的 HTTPS 域与签发查询，拒绝越界和重复查询', () => {
  validateDownloadUrl('https://github.com/example/apps/releases/download/reader-v1.0.0/reader-1.0.0.tgapp', true)
  validateDownloadUrl('https://release-assets.githubusercontent.com/file?sp=r&sig=signature&jwt=token', false)
  for (const value of ['http://github.com/file', 'https://evil.example/file', 'https://github.com:444/file', 'https://user:password@github.com/file', 'https://objects.githubusercontent.com/file#fragment', 'https://objects.githubusercontent.com/file?url=https://evil.example/', 'https://objects.githubusercontent.com/file?sig=a&sig=b']) assert.throws(() => validateDownloadUrl(value, false))
})

test('草稿 API 令牌不随重定向转发，正式包下载从首跳起完全无令牌', async () => {
  const keys = ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GH_TOKEN', 'GITHUB_API_URL']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), previousFetch = globalThis.fetch
  const source = 'a'.repeat(40), payload = Buffer.from('只用于检查下载请求头')
  const initial = 'https://github.com/example/apps/releases/download/reader-v1.0.0/reader-1.0.0.tgapp'
  const requests = []
  Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repository, GITHUB_SHA: source, GH_TOKEN: 'local-test-token', GITHUB_API_URL: 'https://api.github.com' })
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers })
    return url.startsWith('https://release-assets.githubusercontent.com/') ? new Response(payload, { headers: { 'Content-Length': String(payload.length) } }) : new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/file?sig=signature' } })
  }
  try {
    const remote = new GitHubRemote(repository, source)
    const report = { manifest: { id: 'reader', version: '1.0.0' }, filename: 'reader-1.0.0.tgapp', size: String(payload.length) }
    const asset = { id: 1, browser_download_url: initial }
    for (const draft of [true, false]) {
      const output = resolve(directory, `headers-${draft}`); await mkdir(output)
      await remote.download({ draft }, asset, report, output)
    }
    assert.equal(requests[0].headers.Authorization, 'Bearer local-test-token')
    assert.ok(requests.slice(1).every(request => request.headers.Authorization === undefined))
    assert.equal(requests[2].url, initial)
  } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
