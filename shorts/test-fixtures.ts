import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, vi } from 'vitest'
import { MemoryHost, type SeedNode } from '@tgdrive/test-host'
import type { FileNode, HostEvent, JsonValue, MediaUrlRequest, PageContext, UiNotice } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { startShorts, type ShortsRuntime, type ShortsUi } from './app'
import { SETTINGS_KEY, type Source } from './state'

const clients = new Set<MemoryHost>(), apps = new Set<ReturnType<typeof startShorts>>()
afterEach(async () => { for (const app of apps) app.dispose(); apps.clear(); await Promise.all([...clients].map(client => client.dispose())); clients.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren() })
export const settle = async () => { for (let step = 0; step < 20; step++) await Promise.resolve() }
export function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export const fileId = (index: number) => String(index + 2)
export function testUi() {
  const notices = new Set<(notice: UiNotice) => unknown>(), handlers = new Set<(signal: AbortSignal) => unknown>()
  const ui: ShortsUi = { setImmersive: vi.fn(async () => {}), setTitle: vi.fn(async () => {}), pickDirectory: vi.fn(async () => null), requestScope: vi.fn(async () => null), task: vi.fn(async () => {}), close: vi.fn(async () => { await Promise.all([...handlers].map(handler => handler(AbortSignal.timeout(LIMITS.UI_CLOSE_GRACE_MILLIS)))) }), onNotice: listener => { notices.add(listener); return () => notices.delete(listener) }, beforeClose: handler => { handlers.add(handler); return () => handlers.delete(handler) } }
  const emitUi = async (notice: UiNotice) => { await Promise.all([...notices].map(listener => listener(notice))); if (notice.event === 'ui.before_close') await Promise.all([...handlers].map(handler => handler(AbortSignal.timeout(notice.data.deadline_ms)))) }
  return { ui, emitUi }
}
export async function fixture(options: { poster?: Promise<string>; preview?: (path: string) => Promise<string>; autoplayError?: string; paged?: number; source?: Source; launchIndex?: number; thumbnail?: boolean; nodes?: SeedNode[]; initialize?: (host: MemoryHost) => Promise<void>; start?: boolean } = {}) {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'page/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  const video = document.querySelector('video')!
  let paused = true, hidden = false, time = 0
  Object.defineProperties(video, { paused: { get: () => paused }, readyState: { get: () => 4 }, duration: { get: () => 90 }, currentTime: { get: () => time, set: (value: number) => { time = value } }, buffered: { get: () => ({ length: 1, start: () => 0, end: () => 30 }) } })
  const play = vi.spyOn(video, 'play').mockImplementation(async () => { if (options.autoplayError) { const name = options.autoplayError; options.autoplayError = undefined; throw Object.assign(new Error(name), { name }) }; paused = false; video.dispatchEvent(new Event('play')); video.dispatchEvent(new Event('playing')) })
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; video.dispatchEvent(new Event('pause')) }); vi.spyOn(video, 'load').mockImplementation(() => {})
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const mobile = new EventTarget() as EventTarget & { matches: boolean }; mobile.matches = false
  vi.stubGlobal('matchMedia', vi.fn(() => mobile))
  const nodes: SeedNode[] = [{ id: '1000000', parent_id: '1', name: '视频', kind: 'directory' }, ...Array.from({ length: options.paged ?? 4 }, (_, index): SeedNode => ({ id: fileId(index), parent_id: '1000000', name: `${index}.mp4`, kind: 'file', bytes: [], ...(options.thumbnail === false ? {} : { thumbnail: [1] }) })), ...options.nodes ?? []]
  const host = await MemoryHost.create({ now: Date.now(), app: { id: 'shorts', name: '短视频', version: '2.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes }); clients.add(host)
  await host.kvPut(SETTINGS_KEY, { value: { schemaVersion: 1, source: options.source ?? { type: 'directory', id: '1000000', path: '/视频' }, muted: true }, condition: { type: 'absent' } })
  const native = { random: host.random.bind(host), stat: host.stat.bind(host), kvPut: host.kvPut.bind(host), kvGet: host.kvGet.bind(host), kvDelete: host.kvDelete.bind(host), kvList: host.kvList.bind(host), mediaUrl: host.mediaUrl.bind(host), changes: host.changes.bind(host) }
  const files: FileNode[] = []
  let cursor: string | null = null
  do {
    const page = await host.query({ roots: [], recursive: true, filter: { kind: 'file', extensions: [], include_hidden: false }, sort: 'id', order: 'asc', limit: 500, cursor })
    files.push(...page.items); cursor = page.next_cursor
  } while (cursor)
  await options.initialize?.(host)
  const random = vi.fn(async (...args: Parameters<MemoryHost['random']>) => { const page = await native.random(...args); page.items.sort((a, b) => Number(a.id) - Number(b.id)); return page })
  const stat = vi.fn(native.stat), kvPut = vi.fn(native.kvPut), kvGet = vi.fn(native.kvGet), kvDelete = vi.fn(native.kvDelete), kvList = vi.fn(native.kvList), changes = vi.fn(native.changes)
  const issued = new Map<string, string[]>()
  const urls = vi.fn(async (request: MediaUrlRequest, params?: Parameters<MemoryHost['mediaUrl']>[1]) => {
    const grant = await native.mediaUrl(request, params), file = files.find(file => file.id === request.file.id) ?? await native.stat({ by: 'id', id: request.file.id })
    if (request.representation === 'thumbnail' && options.poster) grant.url = await options.poster
    else if (request.representation !== 'thumbnail' && options.preview) grant.url = await options.preview(file.path)
    if (request.representation !== 'thumbnail') issued.set(request.file.id, [...issued.get(request.file.id) ?? [], grant.url])
    return grant
  })
  Object.assign(host, { random, stat, kvPut, kvGet, kvDelete, kvList, mediaUrl: urls, renewMediaUrl: urls, changes })
  const events: HostEvent[] = [], listeners = new Map<string, (value: unknown) => Promise<void>>()
  let wake: (() => void) | undefined, eventSequence = 0
  host.events = async function* (params = {}) {
    while (!params.signal?.aborted) {
      if (!events.length) await new Promise<void>(resolve => { const abort = () => { params.signal?.removeEventListener('abort', abort); resolve() }; wake = abort; params.signal?.addEventListener('abort', abort, { once: true }) })
      params.signal?.throwIfAborted()
      const event = events.shift(); if (event) yield event
    }
  }
  const emitEvent = async (event: string, data: unknown) => { events.push({ event, cursor: `event-${++eventSequence}`, occurred_at: Date.now(), data: data as JsonValue }); wake?.(); await new Promise(resolve => setTimeout(resolve, 0)) }
  for (const event of ['files.changed', 'scope.changed', 'sync.required', 'kv.changed', 'app.changed']) listeners.set(event, data => emitEvent(event, data))
  const { ui, emitUi } = testUi()
  const context: PageContext = { contract: { major: 1, minor: 0 }, app: { id: 'shorts', name: '短视频', version: '2.0.0', generation: 'g1' }, host_origin: 'https://test.invalid', api_base: '/admin/api/apps/v1/self', backend_base: null, ui_nonce: 'nonce', theme: 'light', launch: options.launchIndex === undefined ? { action: 'browse' } : { action: 'open', file: files[options.launchIndex]! } }
  const runtime: ShortsRuntime = { host, ui, context, dispose: vi.fn() }
  let app: ReturnType<typeof startShorts> | undefined
  const start = async (expectLoaded = true) => { app = startShorts(runtime); apps.add(app); await app.ready; if (expectLoaded && !options.preview) await loaded(); return app }
  const loaded = async () => { await vi.waitFor(() => { if (!video.hasAttribute('src') || video.dataset.fileId !== document.getElementById('video-name')?.dataset.fileId) throw new Error('视频地址尚未挂载') }, { timeout: 5000, interval: 1 }); await vi.waitFor(() => { if (document.getElementById('favorite')?.hasAttribute('disabled')) throw new Error('收藏尚未读取') }, { timeout: 5000, interval: 1 }) }
  const click = async (id: string, wait = true) => {
    const before = document.getElementById('video-name')?.dataset.fileId
    document.getElementById(id)!.click()
    if (!wait) { await settle(); return }
    if (['next', 'previous', 'skip-error', 'shuffle'].includes(id)) { await vi.waitFor(() => { if (document.getElementById('video-name')?.dataset.fileId === before) throw new Error('切换尚未开始') }, { timeout: 5000, interval: 1 }); await loaded() }
    else if (['retry-video', 'retry-list'].includes(id)) await loaded()
    else if (id === 'mute' || id === 'favorite') await vi.waitFor(() => { if (document.getElementById(id)?.hasAttribute('disabled')) throw new Error('写入尚未完成') }, { interval: 1 })
    else if (id === 'exit') await vi.waitFor(() => { if (!vi.mocked(ui.close).mock.calls.length || video.hasAttribute('src')) throw new Error('关闭尚未完成') }, { interval: 1 })
    await settle()
  }
  if (options.start !== false) await start()
  return { host, runtime, ui, emitUi, emitEvent, mobile, video, play, random, stat, kvPut, kvGet, kvDelete, kvList, changes, urls, native, issued, close: vi.mocked(ui.close), click, listeners, files, start, loaded, app: () => app!, visibility: async (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); await settle() } }
}
