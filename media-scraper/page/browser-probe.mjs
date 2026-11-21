import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { MemoryHost } from '@tgdrive/test-host'
import { CONTRACT_VERSION, ENDPOINTS, LIMITS, PAGE_CSP, SELF_API_BASE, UI_CHANNEL } from '../../contract/types/contract.ts'
import { buildPage } from '../../tools-v1/build-examples.mjs'
import { actor, FakeScraper } from './test-backend.ts'

// 编译真实入口，在本地 HTTP 的不透明 iframe 内运行；不启动真实宿主，不读取生产数据。
const directory = dirname(fileURLToPath(import.meta.url))
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp('/tmp/tgdrive-scraper-page-shots-')
if (process.argv[2]) await mkdir(output)
const stage = await mkdtemp(join(tmpdir(), 'scraper-page-render-'))
const cases = [{ id: 'desktop-light', width: 1280, height: 900, theme: 'light' }, { id: 'desktop-dark', width: 1280, height: 900, theme: 'dark' }, { id: 'mobile-light', width: 390, height: 844, theme: 'light' }, { id: 'mobile-dark', width: 390, height: 844, theme: 'dark' }]
const profiles = new Map(), tokens = new Map(), revoked = new Set(), sockets = new Set(), timers = new Set()
let browser, origin = ''
const endpoint = name => ENDPOINTS.find(item => item.name === name).path
const send = (response, value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(value === null ? undefined : JSON.stringify(value)) }
function populated(fake, run, current = false) {
  const items = Array.from({ length: 124 }, (_, position) => fake.makeItem(run, position, current ? position < 10 ? 'done' : position < 15 ? 'skipped' : position < 17 ? 'failed' : position === 17 ? 'processing' : 'pending' : 'done', { files: [{ ...fake.video, id: String(position + 3), name: `ABC-${100 + position}.mp4`, path: `${fake.root.path}/ABC-${100 + position}.mp4` }], reason: position === 16 ? '合成海报来源返回 HTTP 503，已写入的 NFO 保留' : '', steps: [{ role: 'organize', state: position < 18 ? 'done' : 'pending' }, { role: 'nfo', state: position < 18 ? 'done' : 'pending' }, { role: 'poster', state: position < 17 ? 'done' : 'pending' }] }))
  fake.items.set(run.id, items)
  for (const item of items) fake.details.set(item.id, { item, steps: [{ id: `${item.id}-nfo`, role: 'nfo', state: 'done', name: '合成资料.nfo', message: '已经取得写入回执', file: null }], next_step: null, actors: Array.from({ length: 40 }, (_, index) => actor(index)), next_actor: null, attempts: Array.from({ length: 40 }, (_, index) => ({ sequence: index + 1, stage: 'detail', provider: `合成来源${index + 1}`, reason: '资料接口返回 HTTP 503；保留完整原因，未连接真实资料源。' })), next_attempt: null })
}
function outer(bootstrap, profile) {
  function mount(config, id, channel, base) {
    const iframe = document.createElement('iframe')
    iframe.id = 'application'; iframe.setAttribute('sandbox', 'allow-scripts allow-downloads')
    iframe.style.cssText = 'border:0;width:100%;height:100vh;display:block'
    const bytes = new TextEncoder().encode(JSON.stringify(config))
    iframe.src = '/page/index.html#tgdrive=' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    document.body.style.margin = '0'; document.body.append(iframe)
    let closeTimer
    const reply = (message, value) => iframe.contentWindow?.postMessage({ type: 'response', channel, nonce: config.ui_nonce, id: message.id, result: { status: 'ok', value } }, '*')
    const finish = async () => { clearTimeout(closeTimer); iframe.remove(); await fetch(base + '/session', { method: 'DELETE', headers: { Authorization: 'Bearer ' + config.session_token } }); document.body.textContent = '已返回网盘，后台任务继续。' }
    window.addEventListener('message', async event => {
      const message = event.data
      if (event.source !== iframe.contentWindow || event.origin !== 'null' || message?.channel !== channel || message.nonce !== config.ui_nonce || message.type !== 'request') return
      const method = message.request.method
      if (method === 'ui.pick_directory' || method === 'ui.request_scope') {
        const value = await (await fetch('/probe/ui?profile=' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message.request) })).json()
        reply(message, value)
      } else if (method === 'ui.close') {
        reply(message, { type: 'acknowledged' })
        iframe.contentWindow.postMessage({ type: 'notice', channel, nonce: config.ui_nonce, notice: { event: 'ui.before_close', data: { close_id: 'browser-close', deadline_ms: 2000 } } }, '*')
        closeTimer = setTimeout(finish, 2000)
      } else if (method === 'ui.closed') { reply(message, { type: 'acknowledged' }); await finish() }
      else if (['ui.set_title', 'ui.set_immersive', 'ui.task'].includes(method)) reply(message, { type: 'acknowledged' })
    })
  }
  return '<!doctype html><html lang=zh-CN><head><meta charset=UTF-8><meta name=viewport content=width=device-width,initial-scale=1></head><body><script>(' + mount.toString() + ')(' + [bootstrap, profile, UI_CHANNEL, SELF_API_BASE].map(value => JSON.stringify(value)).join(',') + ')</script></body></html>'
}
async function requestJson(request) {
  let size = 0, value = ''
  for await (const chunk of request) { size += chunk.length; if (size > LIMITS.MAX_JSON_REQUEST_BYTES) throw new Error('页面探测请求超限'); value += chunk }
  return value ? JSON.parse(value) : {}
}
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'null'); response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID')
  void (async () => {
    const url = new URL(request.url, origin || 'http://127.0.0.1')
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return }
    if (url.pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return }
    if (url.pathname === '/') {
      const id = url.searchParams.get('profile'), profile = profiles.get(id)
      if (!profile) return send(response, {}, 404)
      const token = `synthetic-page-token-${id}-${++profile.launch}`, nonce = `${id}-nonce-${profile.launch}`
      tokens.set(token, profile)
      const bootstrap = { contract: CONTRACT_VERSION, app: { id: 'media-scraper', name: '影视刮削', version: '1.0.0', generation: 'browser-generation' }, session_token: token, expires_at: Date.now() + 3600000, host_origin: origin, api_base: SELF_API_BASE, backend_base: `${SELF_API_BASE}/backend`, ui_nonce: nonce, theme: profile.theme, launch: { action: 'browse' } }
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(outer(bootstrap, id)); return
    }
    if (url.pathname === '/probe/ui') {
      const profile = profiles.get(url.searchParams.get('profile')), input = await requestJson(request)
      if (input.method === 'ui.pick_directory') return send(response, { type: 'directory', directory: profile.fake.root })
      if (input.method === 'ui.request_scope') return send(response, { type: 'authorization', scope: await profile.host.setScope({ mode: 'selected', directories: [{ directory_id: '2', access: 'read_write' }] }) })
      return send(response, {}, 400)
    }
    if (url.pathname.startsWith('/page/')) {
      const path = resolve(stage, url.pathname.slice(6))
      if (!path.startsWith(stage + '/')) return send(response, {}, 404)
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream'
      response.setHeader('Content-Type', type); response.setHeader('Content-Security-Policy', PAGE_CSP); response.end(await readFile(path)); return
    }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, ''), profile = tokens.get(token)
    if (!profile || revoked.has(token)) return send(response, { error: { code: 'session_expired', message: '合成页面会话已关闭', request_id: 'browser' } }, 401)
    if (url.pathname === endpoint('session.close')) { revoked.add(token); return send(response, null, 204) }
    if (url.pathname === endpoint('scope.read')) return send(response, await profile.host.scope())
    if (url.pathname === endpoint('files.stat')) return send(response, await profile.host.stat(await requestJson(request)))
    if (url.pathname === endpoint('events')) {
      response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders()
      const controller = new AbortController(); response.on('close', () => controller.abort())
      try { for await (const event of profile.host.events({ signal: controller.signal })) response.write(`id: ${event.cursor}\nevent: host\ndata: ${JSON.stringify(event)}\n\n`) } catch { if (!controller.signal.aborted) throw new Error('合成事件连接失败') }
      response.end(); return
    }
    const prefix = `${SELF_API_BASE}/backend`
    if (url.pathname.startsWith(prefix + '/')) {
      const path = url.pathname.slice(prefix.length), value = await requestJson(request)
      const reply = await profile.fake.handle({ path, options: { method: request.method, body: request.method === 'GET' ? undefined : JSON.stringify(value) }, context: { contract: CONTRACT_VERSION, app_id: 'media-scraper', caller: 'owner', entry: 'page', request_id: 'browser-request', original_uri: url.pathname, public_origin: origin, public_base_url: origin + prefix, client_ip: null } })
      const data = JSON.parse(await reply.text())
      if (path === '/owner/runs' && reply.status === 202) {
        const run = profile.fake.runs.get(data.id), scope = await profile.host.scope()
        const timer = setTimeout(() => {
          timers.delete(timer)
          const current = { ...run, scope_revision: scope.revision, state: 'running', scan_complete: true, message: '正在处理 ABC-117 · ABC-117.mp4', counts: { total: 124, processed: 17, done: 10, skipped: 5, failed: 2 } }
          profile.fake.runs.set(run.id, current); populated(profile.fake, current, true)
        }, 150)
        timers.add(timer)
      } else if (path === '/owner/stop' && reply.ok) {
        const run = profile.fake.runs.get(value.run_id)
        const timer = setTimeout(() => { timers.delete(timer); profile.fake.runs.set(run.id, { ...run, state: 'cancelled', message: '已停止，已完成文件保留' }); profile.fake.activeId = null }, 150)
        timers.add(timer)
      }
      return send(response, data, reply.status)
    }
    send(response, {}, 404)
  })().catch(error => { if (!response.headersSent) send(response, { error: { code: 'fixture_error', message: error.message, request_id: 'browser' } }, 500); else response.destroy(error) })
})
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
try {
  await buildPage(directory, stage)
  for (const sample of cases) {
    const fake = new FakeScraper(), host = await MemoryHost.create({ app: { id: 'media-scraper', name: '影视刮削', version: '1.0.0', generation: 'browser-generation' }, files: { read: true, write: true }, scope: { mode: 'all', access: 'read_write' }, nodes: [{ id: '2', parent_id: '1', name: '合成影片', kind: 'directory' }, { id: '3', parent_id: '2', name: 'ABC-123.mp4', kind: 'file', bytes: [1, 2, 3] }] }, { backend: fake.handle })
    fake.root = await host.stat({ by: 'id', id: '2' }); fake.video = await host.stat({ by: 'id', id: '3' })
    fake.settings = { revision: 'settings-1', backend_url: 'https://fixture.invalid/', token_configured: false, overwrite_nfo: false, overwrite_poster: false, directory: fake.root }; fake.pageSize = 50
    for (let index = 0; index < 70; index++) {
      const run = fake.makeRun('completed', undefined, { message: '合成历史任务已完成', counts: { total: 124, processed: 124, done: 120, skipped: 3, failed: 1 }, created_at: Date.now() - (70 - index) * 3600000 })
      fake.add(run); populated(fake, run)
    }
    await host.setScope({ mode: 'none' })
    profiles.set(sample.id, { ...sample, fake, host, launch: 0 })
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.TGDRIVE_BROWSER_EXECUTABLE ? { executablePath: process.env.TGDRIVE_BROWSER_EXECUTABLE } : {}) })
  const results = []
  for (const sample of cases) {
    const context = await browser.newContext({ viewport: { width: sample.width, height: sample.height }, locale: 'zh-CN', isMobile: sample.id.startsWith('mobile'), hasTouch: sample.id.startsWith('mobile') })
    const escaped = [], errors = [], page = await context.newPage(), profile = profiles.get(sample.id)
    await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue(); escaped.push(url); return route.abort() })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`${origin}/?profile=${sample.id}`)
    const frame = page.frameLocator('#application')
    await frame.locator('#app').waitFor({ state: 'visible' })
    assert.equal(await frame.locator('html').getAttribute('data-theme'), sample.theme)
    assert.equal(await frame.locator('body').evaluate(() => globalThis.origin), 'null')
    assert.equal(await frame.locator('body').evaluate(() => location.hash), '')
    await frame.getByRole('button', { name: '选择目录', exact: true }).click()
    await frame.locator('#directory').filter({ hasText: '/合成影片' }).waitFor()
    await frame.getByRole('button', { name: '开始刮削', exact: true }).click()
    await frame.locator('#done-count').filter({ hasText: /^10$/ }).waitFor()
    const overflow = await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    await page.screenshot({ path: join(output, `${sample.id}-progress.png`) })
    await frame.locator('#results-next').scrollIntoViewIfNeeded(); await frame.locator('#results-next').click()
    await frame.locator('#results-page').filter({ hasText: '第 2 页' }).waitFor()
    assert.ok(await frame.locator('#results .result-row').count() <= 50)
    await frame.locator('#results button').first().click(); await frame.locator('#detail-actors .detail-row').first().waitFor()
    await frame.locator('#actor-next').click(); await frame.locator('#actor-page').filter({ hasText: '第 2 页' }).waitFor()
    assert.equal(await frame.locator('#detail-actors .detail-row').count(), 10)
    await frame.getByRole('button', { name: '操作记录', exact: true }).click()
    await frame.locator('#history .history-card').first().waitFor(); await frame.locator('#history-next').click()
    await frame.locator('#history-page').filter({ hasText: '第 2 页' }).waitFor()
    assert.equal(await frame.locator('#history .history-card').count(), 30)
    await frame.getByRole('button', { name: '目录刮削', exact: true }).click()
    await frame.getByRole('button', { name: '停止刮削', exact: true }).click()
    await frame.locator('#execution-status').filter({ hasText: /^已停止$/ }).waitFor()
    await frame.getByRole('button', { name: '设置', exact: true }).click()
    await frame.locator('#backend-url').fill('https://saved-fixture.invalid/')
    await frame.locator('#backend-token').fill('synthetic-browser-token')
    await frame.locator('#overwrite-nfo').check(); await frame.getByRole('button', { name: '保存设置', exact: true }).click()
    await frame.locator('#token-status').filter({ hasText: /^已配置 Token。$/ }).waitFor()
    assert.equal(await frame.locator('#backend-token').inputValue(), '')
    await frame.getByRole('button', { name: '关闭提示', exact: true }).click()
    await frame.locator('#message').waitFor({ state: 'hidden' })
    assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await frame.locator('#connection-view').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, `${sample.id}-settings.png`) })
    await frame.getByRole('button', { name: '目录刮削', exact: true }).click(); await frame.getByRole('button', { name: '开始刮削', exact: true }).click()
    // 旧任务可能也显示相同计数；先确认假后端已启动并推进新任务，不能把旧 DOM 当成新任务就绪。
    await expect.poll(() => profile.fake.activeId ? profile.fake.runs.get(profile.fake.activeId)?.counts.done : null).toBe(10)
    await frame.locator('#done-count').filter({ hasText: /^10$/ }).waitFor()
    const activeId = profile.fake.activeId, stops = profile.fake.requests.filter(request => request.path === '/owner/stop').length
    assert.notEqual(activeId, null)
    await frame.getByRole('button', { name: '返回网盘', exact: true }).click(); await page.getByText('已返回网盘，后台任务继续。').waitFor()
    assert.equal(profile.fake.activeId, activeId); assert.equal(profile.fake.requests.filter(request => request.path === '/owner/stop').length, stops)
    await page.goto(`${origin}/?profile=${sample.id}`); await page.frameLocator('#application').locator('#app').waitFor({ state: 'visible' })
    assert.equal(profile.fake.activeId, activeId)
    assert.equal(await page.frameLocator('#application').locator('#done-count').textContent(), '10')
    assert.deepEqual(escaped, []); assert.deepEqual(errors, [])
    results.push({ profile: sample.id, opaque_sandbox: true, correct_theme: true, no_horizontal_overflow: true, scoped_start: true, result_history_actor_pagination: true, stop: true, settings_saved: true, token_status_only: true, close_keeps_job: true, reopen_observes_same_job: true, external_requests: 0, console_errors: 0 })
    await context.close()
  }
  process.stdout.write(JSON.stringify({ output, results, actual_compiled_page: true, real_host_tested: false, metatube_contacted: false }) + '\n')
} finally {
  for (const timer of timers) clearTimeout(timer)
  await browser?.close()
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await Promise.all([...profiles.values()].map(profile => profile.host.dispose()))
  await rm(stage, { recursive: true, force: true })
}
