import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium, expect } from '@playwright/test'
import { MemoryHost } from '@tgdrive/test-host'
import { CONTRACT_VERSION, CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, ENDPOINTS, LIMITS, PAGE_CSP, SELF_API_BASE, UI_CHANNEL } from '../../contract/types/contract.ts'

// 只编译真实页面并连接本地合成网盘与页面假后端，不启动正式宿主或真实影视服务。
const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../..')
const output = process.argv[2] ? join(await realpath(dirname(resolve(process.argv[2]))), basename(process.argv[2])) : await mkdtemp(join(tmpdir(), 'cinema-page-browser-'))
if (output === root || output.startsWith(root + '/')) throw new Error('页面测试产物必须放在仓库外的新目录')
if (process.argv[2]) await mkdir(output)
const compiled = join(output, 'page'), sampleFile = join(output, '合成视频.mp4')
const cases = [{ id: 'desktop-light', width: 1280, height: 900, theme: 'light' }, { id: 'desktop-dark', width: 1280, height: 900, theme: 'dark' }, { id: 'mobile-light', width: 390, height: 844, theme: 'light' }, { id: 'mobile-dark', width: 390, height: 844, theme: 'dark' }]
const libraryId = '1'.repeat(32), itemGuid = 'd'.repeat(32), mediaGuids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]
const labels = ['4K 中字', '1080P 第1段', '1080P 第2段']
const profiles = new Map(), tokens = new Map(), tickets = new Map(), sockets = new Set()
let origin = '', browser, activePage, activeProfile = ''
const endpoint = name => ENDPOINTS.find(endpoint => endpoint.name === name).path
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const failure = message => json({ error: { code: 'fixture_error', message, request_id: 'browser' } }, 400)
const send = (response, value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(status === 204 ? undefined : JSON.stringify(value)) }
function latest(profile) {
  return [...profile.playedAt].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '3'
}
async function owner(profile, path, value) {
  const file = profile.files.find(file => file.id === value.id), key = value.key
  if (path === '/owner/config') return json({ revision: 'settings', username: '', account_configured: false, running: false, libraries: [{ id: libraryId, name: '合成电影', kind: 'movie', root_id: '2', path: '/合成电影', authorized: true }], index: { state: 'ready', error: '', entries: 1 } })
  if (path === '/owner/revision') return json({ revision: `data-${profile.sequence}` })
  if (path === '/owner/catalog') return json({ items: [profile.files[0]], total: 1, next_cursor: null, descriptions: { '3': { title: 'ABC-123 合成影片', year: '2024', number: 'ABC-123', kind: 'movie', cover_key: null } } })
  if (path === '/owner/files/stat') return json(await profile.host.stat(value))
  if (path === '/owner/files/list' || path === '/owner/playlist') return json({ items: [profile.files[0]], total: 1, next_cursor: null })
  if (path === '/owner/versions') {
    if (!file && value.id !== itemGuid || value.library_id !== libraryId) return failure('影片或媒体库不匹配')
    return json({ item_guid: itemGuid, representative_media_guid: mediaGuids[0], default_media_guid: mediaGuids[Number(latest(profile)) - 3], versions: profile.files.map((file, index) => ({ media_guid: mediaGuids[index], name: labels[index], file })) })
  }
  if (path === '/owner/description') return json({ title: 'ABC-123 合成影片', overview: '这是只供沙箱回归使用的合成影片。', year: '2024', number: 'ABC-123', kind: 'movie', cover_key: null, subtitles: [] })
  if (path === '/owner/cover') return json({ key: null })
  if (path === '/owner/play/neighbor') return json({ file: null })
  if (path === '/owner/flags/get') return json({ watched: false, revision: null })
  if (path === '/owner/storage/get') return json(profile.records.get(key) ?? null)
  if (path === '/owner/storage/list') {
    const record = value.prefix === 'progress:' ? profile.records.get(`progress:${latest(profile)}`) : profile.records.get(`favorite:${itemGuid}`)
    return json({ records: record ? [{ ...record, library_id: libraryId }] : [], total: record ? 1 : 0, next_cursor: null })
  }
  if (path === '/owner/play/start') {
    if (!file) return failure('所选文件不存在')
    const playId = `play-${++profile.sequence}`
    profile.plays.set(playId, file.id); profile.starts.push(file.id)
    return json({ play_id: playId })
  }
  if (path === '/owner/play/quit') { profile.plays.delete(value.play_id); return json({ ok: true }) }
  if (path === '/owner/storage/set') {
    if (key.startsWith('progress:')) {
      const id = key.slice('progress:'.length)
      if (profile.plays.get(value.play_id) !== id || value.value.file.id !== id) return failure('进度与当前版本的播放会话不匹配')
      profile.playedAt.set(id, ++profile.sequence)
    }
    const record = { key, value: value.value, revision: `saved-${++profile.sequence}` }
    profile.records.set(key, record); return json(record)
  }
  return failure(`页面测试未提供接口：${path}`)
}
function outer(bootstrap) {
  function mount(config, channel) {
    const frame = document.createElement('iframe')
    frame.id = 'application'; frame.setAttribute('sandbox', 'allow-scripts allow-downloads')
    frame.style.cssText = 'border:0;width:100%;height:100vh;display:block'
    const bytes = new TextEncoder().encode(JSON.stringify(config))
    frame.src = '/page/index.html#tgdrive=' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    document.body.style.margin = '0'; document.body.append(frame)
    window.addEventListener('message', event => {
      const message = event.data
      if (event.source !== frame.contentWindow || event.origin !== 'null' || message?.channel !== channel || message.nonce !== config.ui_nonce || message.type !== 'request') return
      if (['ui.set_title', 'ui.set_immersive', 'ui.task', 'ui.close', 'ui.closed'].includes(message.request.method)) frame.contentWindow.postMessage({ type: 'response', channel, nonce: config.ui_nonce, id: message.id, result: { status: 'ok', value: { type: 'acknowledged' } } }, '*')
    })
  }
  return '<!doctype html><html lang=zh-CN><head><meta charset=UTF-8><meta name=viewport content=width=device-width,initial-scale=1></head><body><script>(' + mount.toString() + ')(' + JSON.stringify(bootstrap) + ',' + JSON.stringify(UI_CHANNEL) + ')</script></body></html>'
}
async function requestJson(request) {
  let size = 0, text = ''
  for await (const part of request) { size += part.length; if (size > LIMITS.MAX_JSON_REQUEST_BYTES) throw new Error('合成页面请求超过契约预算'); text += part }
  return text ? JSON.parse(text) : {}
}
function binary(response, value) {
  response.statusCode = value.status; value.headers.forEach((value, key) => response.setHeader(key, value))
  if (!value.body) { response.end(); return }
  const stream = Readable.fromWeb(value.body); stream.on('error', error => response.destroy(error)); stream.pipe(response)
}
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'null'); response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS); response.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS)
  void (async () => {
    const url = new URL(request.url, origin || 'http://127.0.0.1')
    if (request.method === 'OPTIONS' || url.pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return }
    if (url.pathname === '/') {
      const profile = profiles.get(url.searchParams.get('profile'))
      if (!profile) return send(response, {}, 404)
      const token = `synthetic-page-${profile.id}-${++profile.launch}`
      tokens.set(token, profile)
      const bootstrap = { contract: CONTRACT_VERSION, app: { id: 'cinema', name: '影视', version: '1.0.7', generation: 'browser-generation' }, session_token: token, expires_at: Date.now() + 3600000, host_origin: origin, api_base: SELF_API_BASE, backend_base: SELF_API_BASE + '/backend', ui_nonce: token + '-nonce', theme: profile.theme, launch: { action: 'browse' } }
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(outer(bootstrap)); return
    }
    if (url.pathname.startsWith('/page/')) {
      const file = resolve(compiled, url.pathname.slice(6))
      if (!file.startsWith(compiled + '/')) return send(response, {}, 404)
      response.setHeader('Content-Security-Policy', PAGE_CSP)
      response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream')
      response.end(await readFile(file)); return
    }
    const options = { range: request.headers.range, head: request.method === 'HEAD', ifNoneMatch: request.headers['if-none-match'], ifRange: request.headers['if-range'] }
    const ticket = tickets.get(url.pathname + url.search)
    if (ticket) { ticket.profile.reads.push(ticket.id); binary(response, await ticket.profile.host.readTicket(url.pathname + url.search, options)); return }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, ''), profile = tokens.get(token)
    if (!profile) return send(response, { error: { code: 'session_expired', message: '合成会话不存在', request_id: 'browser' } }, 401)
    if (url.pathname === endpoint('session.close')) { tokens.delete(token); return send(response, null, 204) }
    if (url.pathname === endpoint('runtime.info')) return send(response, await profile.host.runtimeInfo())
    if (url.pathname === endpoint('scope.read')) return send(response, await profile.host.scope())
    if (url.pathname === endpoint('files.stat')) return send(response, await profile.host.stat(await requestJson(request)))
    if (url.pathname === endpoint('files.media_url')) {
      const input = await requestJson(request), media = await profile.host.mediaUrl(input)
      tickets.set(media.url, { profile, id: input.file.id }); return send(response, media)
    }
    const [prefix, suffix] = endpoint('files.bytes').split('{id}')
    if (url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix)) {
      const id = url.pathname.slice(prefix.length, url.pathname.length - suffix.length)
      profile.reads.push(id); binary(response, await profile.host.bytes({ id, content_version: url.searchParams.get('content_version') }, options)); return
    }
    if (url.pathname === endpoint('events')) {
      response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders()
      const controller = new AbortController(); response.on('close', () => controller.abort())
      try { for await (const event of profile.host.events({ signal: controller.signal })) response.write(`id: ${event.cursor}\nevent: host\ndata: ${JSON.stringify(event)}\n\n`) } catch (error) { if (!controller.signal.aborted) throw error }
      response.end(); return
    }
    const backend = SELF_API_BASE + '/backend'
    if (url.pathname.startsWith(backend + '/')) {
      const reply = await owner(profile, url.pathname.slice(backend.length), await requestJson(request))
      return send(response, JSON.parse(await reply.text()), reply.status)
    }
    send(response, {}, 404)
  })().catch(error => { if (!response.headersSent) send(response, { error: { code: 'fixture_error', message: error.message, request_id: 'browser' } }, 500); else response.destroy(error) })
})
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
try {
  const generated = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=12', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '30', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', sampleFile], { encoding: 'utf8' })
  assert.equal(generated.status, 0, `合成视频生成失败：${generated.stderr}`)
  const bytes = [...await readFile(sampleFile)]
  await build({ configFile: false, envDir: false, root: directory, base: './', publicDir: false, logLevel: 'error', build: { outDir: compiled, emptyOutDir: false, target: 'es2022', minify: true, sourcemap: false } })
  for (const sample of cases) {
    const profile = { ...sample, launch: 0, sequence: 0, files: [], records: new Map(), playedAt: new Map(), plays: new Map(), starts: [], reads: [] }
    profile.host = await MemoryHost.create({ app: { id: 'cinema', name: '影视', version: '1.0.7', generation: 'browser-generation' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, now: Date.now(), nodes: [{ id: '2', parent_id: '1', name: '合成电影', kind: 'directory' }, ...['ABC-123-4K.mp4', 'ABC-123-1080P-part1.mp4', 'ABC-123-1080P-part2.mp4'].map((name, index) => ({ id: String(index + 3), parent_id: '2', name, kind: 'file', bytes }))] }, { backend: request => owner(profile, request.path, request.options.body ? JSON.parse(String(request.options.body)) : {}) })
    profile.files = await Promise.all(['3', '4', '5'].map(id => profile.host.stat({ by: 'id', id })))
    profiles.set(sample.id, profile)
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.TGDRIVE_BROWSER_EXECUTABLE ? { executablePath: process.env.TGDRIVE_BROWSER_EXECUTABLE } : {}) })
  const results = []
  for (const sample of cases) {
    const context = await browser.newContext({ viewport: { width: sample.width, height: sample.height }, locale: 'zh-CN', isMobile: sample.id.startsWith('mobile'), hasTouch: sample.id.startsWith('mobile') })
    const escaped = [], errors = [], page = await context.newPage(), profile = profiles.get(sample.id)
    activePage = page; activeProfile = sample.id
    await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue(); escaped.push(url); return route.abort() })
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`${origin}/?profile=${sample.id}`)
    const frame = page.frameLocator('#application')
    await expect(frame.locator('#app')).toBeVisible(); await expect(frame.locator('html')).toHaveCSS('color-scheme', sample.theme)
    assert.equal(await frame.locator('html').evaluate(root => root.classList.contains('dark')), sample.theme === 'dark')
    assert.equal(await frame.locator('body').evaluate(() => globalThis.origin), 'null')
    assert.equal(await frame.locator('body').evaluate(() => location.hash), '')
    await frame.getByRole('button', { name: '进入媒体库：合成电影', exact: true }).click()
    await expect(frame.locator('#items > article')).toHaveCount(1)
    assert.equal(profile.reads.length, 0)
    await frame.locator('#items > article button').first().click()
    await expect(frame.locator('#detail-version')).toHaveValue(mediaGuids[0])
    await expect(frame.locator('#detail-version option')).toHaveText(labels)
    await expect(frame.locator('#detail-title')).toHaveText('ABC-123 合成影片')
    assert.equal(profile.reads.length, 0)
    await frame.locator('#detail-version').selectOption(mediaGuids[1])
    await expect(frame.locator('#detail-meta')).toContainText(labels[1]); await expect(frame.locator('#detail-play')).toBeEnabled()
    await frame.locator('#detail').evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)))
    assert.equal(await frame.locator('.detail-top').evaluate(top => top.scrollWidth > top.clientWidth + 1), false)
    await page.screenshot({ path: join(output, `${sample.id}-detail.png`) })
    await frame.locator('#video').evaluate(video => { video.muted = true })
    await frame.locator('#detail-play').click()
    await expect(frame.locator('#player-version')).toHaveValue(mediaGuids[1])
    await expect(frame.locator('#autoplay')).toBeDisabled(); await expect(frame.locator('#autoplay')).not.toBeChecked()
    await expect.poll(() => profile.starts.includes('4')).toBe(true)
    await frame.locator('#seek').evaluate(seek => { seek.value = '7'; seek.dispatchEvent(new Event('change', { bubbles: true })) })
    await expect.poll(() => frame.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(6)
    await frame.locator('#player-version').selectOption(mediaGuids[2])
    await expect(frame.locator('#player-version')).toHaveValue(mediaGuids[2]); await expect.poll(() => profile.starts.includes('5')).toBe(true)
    assert.ok(profile.records.get('progress:4').value.seconds > 6)
    await expect.poll(() => frame.locator('#video').evaluate(video => video.currentTime)).toBeLessThan(3)
    await frame.locator('#seek').evaluate(seek => { seek.value = '11'; seek.dispatchEvent(new Event('change', { bubbles: true })) })
    await expect.poll(() => frame.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(10)
    await frame.locator('#player-back').click(); await expect(frame.locator('#player')).toBeHidden()
    const savedSecond = profile.records.get('progress:5').value.seconds
    assert.ok(savedSecond > 10); assert.ok(profile.records.get('progress:4').value.seconds < 10)
    await expect(frame.locator('#continue-items > *')).toHaveCount(1)
    await frame.locator('[data-nav="history"]:visible').first().click(); await expect(frame.locator('#items > article')).toHaveCount(1)
    await frame.locator('#items > article button').first().click(); await expect(frame.locator('#detail-version')).toHaveValue(mediaGuids[2])
    await frame.locator('#detail-version').selectOption(mediaGuids[1]); await expect(frame.locator('#detail-play')).toBeEnabled(); await frame.locator('#detail-play').click()
    await expect(frame.locator('#player-version')).toHaveValue(mediaGuids[1]); await expect.poll(() => frame.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(6)
    assert.equal(profile.records.get('progress:5').value.seconds, savedSecond)
    assert.ok(profile.reads.includes('4') && profile.reads.includes('5'))
    assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    assert.equal(await frame.locator('#player-version').evaluate(select => {
      const style = getComputedStyle(select), context = document.createElement('canvas').getContext('2d')
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      return context.measureText(select.selectedOptions[0].text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 18 > select.clientWidth
    }), false, '播放器版本文字必须能显示完整段号')
    await page.screenshot({ path: join(output, `${sample.id}-player.png`) })
    await frame.locator('#player-back').click(); await expect(frame.locator('#player')).toBeHidden()
    assert.deepEqual(escaped, []); assert.deepEqual(errors, [])
    results.push({ profile: sample.id, opaque_sandbox: true, one_movie_three_versions: true, default_representative_then_recent: true, switches_real_media_file: true, independent_resume: true, unique_history_and_continue: true, no_horizontal_overflow: true, external_requests: 0, console_errors: 0 })
    console.log(`${sample.id}：版本选择、默认版本、真实视频切换和独立续播通过`)
    await context.close(); activePage = undefined
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(`影视沙箱页面：${results.length} 个配置通过，产物 ${output}`)
} catch (error) {
  if (activePage) await activePage.screenshot({ path: join(output, `${activeProfile}-failed.png`) }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  for (const profile of profiles.values()) await profile.host.dispose()
}
