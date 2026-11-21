/** 测试夹具只负责合成文件、故障注入和界面替身；文件查询、Range、CAS 全部使用 Rust 内存宿主。 */
import { afterEach, vi } from 'vitest'
import { MemoryHost, type SeedNode } from '@tgdrive/test-host'
import type { CacheEntry, FileNode, HostClient, JsonValue, KvRecord, NodeId, PageContext, UiNotice } from '@tgdrive/page-sdk'
import { fileVersion } from '../files'
import { parentPath, unitFormat, type ReadingUnit } from './model'
import type { SourcesSnapshot } from './sources'
import type { PageRuntime, ReaderUi, EventListener } from '../runtime'
import { startApp, type AppOptions } from '../app'
import { readerDefaultPreferences, type Preferences } from '../state'

const hosts = new Set<MemoryHost>()
const pages = new WeakMap<HostClient, PageRuntime>()
const bindings = new WeakMap<HostClient, { ui: ReaderUi; onHostEvent(name: string, listener: EventListener): () => void; openSettings(): Promise<void> }>()
export function testBindings(host: HostClient) { const value = bindings.get(host); if (!value) throw new Error('界面测试必须使用 MemoryHost 夹具'); return value }
export function pageFor(host: HostClient): PageRuntime { const page = pages.get(host); if (!page) throw new Error('页面测试必须使用 MemoryHost 夹具'); return page }
/** 正文控件回归先按真实阅读馆流程选择命名书库，不恢复退役的独立书漫入口。 */
export async function startInShelf(options: AppOptions, page: PageRuntime) {
  await startApp({ ...options, id: 'reader' }, page)
  if (document.getElementById('startup-error')?.hidden && document.getElementById('reader')?.hidden) {
    document.querySelector<HTMLButtonElement>('.shelf-card')?.click()
    await vi.waitFor(() => { if (!document.querySelector('#items .library-card')) throw new Error('书库卡片尚未加载') })
  }
}
/** 从视图偏好构造当前应用的分格式记录，仅用于写入测试初始状态。 */
export function configuredPreferences(patch: Partial<Preferences>) {
  const value = readerDefaultPreferences()
  for (const key of ['theme', 'fontSize', 'lineHeight', 'width', 'font', 'margin'] as const) if (patch[key] !== undefined) Object.assign(value.text, { [key]: patch[key] })
  if (patch.mode === 'page' || patch.mode === 'scroll') value.text.mode = patch.mode
  for (const key of ['theme', 'direction', 'fit', 'zoom', 'coverAlone', 'spreadOffset'] as const) if (patch[key] !== undefined) Object.assign(value.comic, { [key]: patch[key] })
  if (patch.mode) value.comic.mode = patch.mode === 'page' ? 'single' : patch.mode
  for (const key of ['theme', 'fit', 'zoom'] as const) if (patch[key] !== undefined) Object.assign(value.pdf, { [key]: patch[key] })
  return value
}
declare global { interface Window { readerTestHost: HostClient } }
afterEach(async () => { await Promise.all([...hosts].map(host => host.dispose())); hosts.clear() })
export const signal = () => new AbortController().signal
/** 数字仅作为测试输入简写；应用收到的始终是规范十进制字符串，1 保留给真实网盘根。 */
export const testId = (id: number | string): NodeId => typeof id === 'number' ? id === 0 ? '1' : id === 1 ? '1000000000000000001' : String(id) : id
export const file = (id: number | string, path: string, isDirectory = false, version = 'v1', size = 0): FileNode => ({ id: path === '/' ? '1' : testId(id), parent_id: path === '/' ? null : '1', path, name: path === '/' ? '' : path.split('/').pop()!, kind: isDirectory ? 'directory' : 'file', content_version: isDirectory ? null : version, children_revision: isDirectory ? version : null, revision: version, size: String(size), created_at: 1, modified_at: 1, has_thumbnail: false })
export function unit(entry: FileNode, sourceIds: (number | string)[] = [1], firstIndexedAt = 10): ReadingUnit { return { nodeId: entry.id, file: entry, format: unitFormat(entry, 'books') ?? unitFormat(entry, 'comics')!, sourceIds: sourceIds.map(testId), firstIndexedAt } }
export function sources(...directories: FileNode[]): SourcesSnapshot { return { revision: 'sources-1', config: { schemaVersion: 1, sources: directories.map(directory => ({ nodeId: directory.id, path: directory.path, contentVersion: directory.revision, addedAt: 1, rootConfirmed: directory.path === '/' })) } } }
export function shelves(...directories: FileNode[]): SourcesSnapshot { const snapshot = sources(...directories); snapshot.config.sources.forEach(source => { source.name = source.path === '/' ? '我的网盘' : source.path.split('/').pop()! }); return snapshot }
export function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

class NodeSeeds extends Map<NodeId, FileNode> {
  dirty = new Set<NodeId>()
  override set(id: NodeId | number, value: FileNode): this { const key = testId(id); this.dirty.add(key); return super.set(key, value) }
  override get(id: NodeId | number) { return super.get(testId(id)) }
  override delete(id: NodeId | number) { const key = testId(id); this.dirty.add(key); return super.delete(key) }
  replace(value: FileNode) { const original = super.get(value.id); if (original) Object.assign(original, value); else super.set(value.id, value); this.dirty.delete(value.id) }
}
export function testUi() {
  const notices = new Set<(notice: UiNotice) => void | Promise<void>>(), closing = new Set<(signal: AbortSignal) => void | Promise<void>>()
  const ui: ReaderUi = {
    setImmersive: vi.fn(async () => {}), setTitle: vi.fn(async () => {}), pickDirectory: vi.fn(async () => null), requestScope: vi.fn(async () => null), task: vi.fn(async () => {}),
    close: vi.fn(async () => { await Promise.all([...closing].map(handler => handler(AbortSignal.timeout(2000)))) }),
    onNotice: listener => { notices.add(listener); return () => notices.delete(listener) }, beforeClose: handler => { closing.add(handler); return () => closing.delete(handler) },
  }
  return { ui, emitUi: (notice: UiNotice) => Promise.all([...notices].map(listener => listener(notice))) }
}
export async function memoryHost(initial: FileNode[] = [], configuration: { source?: string } = {}) {
  const originals = initial.filter(node => node.path !== '/'), bytes = new Map<NodeId, Uint8Array>(), seeds: SeedNode[] = []
  const byPath = new Map<string, NodeId>([['/', '1']])
  let generated = 9000000
  const directory = (path: string): NodeId => {
    const existing = byPath.get(path); if (existing) return existing
    const source = originals.find(node => node.path === path && node.kind === 'directory'), id = source?.id ?? String(++generated)
    const parent = directory(parentPath(path)); byPath.set(path, id); seeds.push({ id, parent_id: parent, name: path.split('/').pop()!, kind: 'directory' }); return id
  }
  for (const node of [...originals].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (node.kind === 'directory') { directory(node.path); continue }
    const parent = directory(parentPath(node.path)), data = new Uint8Array(Math.min(Number(node.size), 2 * 1024 * 1024))
    bytes.set(node.id, data); byPath.set(node.path, node.id); seeds.push({ id: node.id, parent_id: parent, name: node.name, kind: 'file', bytes: [...data] })
  }
  const startedAt = Date.now()
  const host = await MemoryHost.create({ now: startedAt, app: { id: 'reader', name: '阅读馆测试', version: '2.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes: seeds })
  hosts.add(host)
  const native = {
    stat: host.stat.bind(host), list: host.list.bind(host), query: host.query.bind(host), directoriesWithFiles: host.directoriesWithFiles.bind(host), changes: host.changes.bind(host), random: host.random.bind(host), bytes: host.bytes.bind(host), readRange: host.readRange.bind(host),
    kvGet: host.kvGet.bind(host), kvPut: host.kvPut.bind(host), kvDelete: host.kvDelete.bind(host), kvList: host.kvList.bind(host), cacheLookup: host.cacheLookup.bind(host), cachePut: host.cachePut.bind(host), cacheDelete: host.cacheDelete.bind(host), dataUsage: host.dataUsage.bind(host), mediaUrl: host.mediaUrl.bind(host),
  }
  const nodes = new NodeSeeds(), applied = new Map<NodeId, FileNode>(), records = new Map<string, KvRecord>()
  const originalById = new Map(originals.map(node => [node.id, node]))
  let cursor: string | null = null
  do {
    const page = await native.query({ roots: [], recursive: true, filter: { kind: 'all', extensions: [], include_hidden: true }, sort: 'id', order: 'asc', limit: 500, cursor })
    for (const node of page.items) { const original = originalById.get(node.id); if (original) Object.assign(original, node); nodes.replace(original ?? node); applied.set(node.id, structuredClone(node)) }
    cursor = page.next_cursor
  } while (cursor)
  nodes.replace(await native.stat({ by: 'id', id: '1' })); applied.set('1', nodes.get('1')!)
  let updating = Promise.resolve()
  const ensureDirectory = async (path: string): Promise<NodeId> => {
    const known = [...nodes.values()].find(node => node.kind === 'directory' && node.path === path)
    if (known) return known.id
    const parent = await ensureDirectory(parentPath(path))
    const node = await host.addNode({ id: String(++generated), parent_id: parent, name: path.split('/').pop()!, kind: 'directory' })
    nodes.replace(node); applied.set(node.id, structuredClone(node)); return node.id
  }
  const syncNodes = () => {
    const task = updating.then(async () => {
      for (const id of [...nodes.dirty].sort((a, b) => (nodes.get(a)?.path.split('/').length ?? 0) - (nodes.get(b)?.path.split('/').length ?? 0))) {
        const wanted = nodes.get(id), previous = applied.get(id)
        if (!wanted) { if (previous) await host.changeNode({ id, visible: false }); nodes.dirty.delete(id); continue }
        if (wanted.id !== id) throw new Error('合成节点的键与 ID 不一致，请改为真实 addNode/changeNode 操作')
        const parent = wanted.path === '/' ? '1' : await ensureDirectory(parentPath(wanted.path))
        const data = bytes.get(id) ?? new Uint8Array()
        const node = previous
          ? await host.changeNode({ id, name: wanted.name, parent, visible: true, ...(wanted.kind === 'file' && wanted.content_version !== previous.content_version ? { bytes: [...data] } : {}) })
          : await host.addNode({ id, parent_id: parent, name: wanted.name, kind: wanted.kind, ...(wanted.kind === 'file' ? { bytes: [...data] } : {}) })
        nodes.replace(node); Object.assign(wanted, node); applied.set(id, structuredClone(node))
      }
    })
    updating = task.catch(() => {}); return task
  }
  const get = vi.fn(async (...args: Parameters<HostClient['kvGet']>) => { const result = await native.kvGet(...args); if (result.record) records.set(args[0], result.record); else records.delete(args[0]); return result })
  const set = vi.fn(async (...args: Parameters<HostClient['kvPut']>) => { const result = await native.kvPut(...args); records.set(result.key, result); return result })
  const remove = vi.fn(async (...args: Parameters<HostClient['kvDelete']>) => { await native.kvDelete(...args); records.delete(args[0]) })
  const storageList = vi.fn(async (...args: Parameters<HostClient['kvList']>) => { const result = await native.kvList(...args); for (const record of result.records) records.set(record.key, record); return result })
  const stat = vi.fn(async (...args: Parameters<HostClient['stat']>) => { await syncNodes(); const node = await native.stat(...args); nodes.replace(node); applied.set(node.id, structuredClone(node)); return node })
  const list = vi.fn(async (...args: Parameters<HostClient['list']>) => { await syncNodes(); const page = await native.list(...args); nodes.replace(page.directory); for (const node of page.items) nodes.replace(node); return page })
  const query = vi.fn(async (...args: Parameters<HostClient['query']>) => { await syncNodes(); return native.query(...args) })
  const directoriesWithFiles = vi.fn(async (...args: Parameters<HostClient['directoriesWithFiles']>) => { await syncNodes(); return native.directoriesWithFiles(...args) })
  const changes = vi.fn(async (...args: Parameters<HostClient['changes']>) => { await syncNodes(); return native.changes(...args) })
  const readRange = vi.fn(async (...args: Parameters<HostClient['readRange']>) => { await syncNodes(); return native.readRange(...args) })
  const cacheEntries = new Map<string, CacheEntry>()
  const cacheLookup = vi.fn(native.cacheLookup)
  const cachePut = vi.fn(async (...args: Parameters<HostClient['cachePut']>) => { const entry = await native.cachePut(...args); cacheEntries.set(entry.key, entry); return entry })
  const cacheDelete = vi.fn(async (...args: Parameters<HostClient['cacheDelete']>) => { await native.cacheDelete(...args); cacheEntries.delete(args[0]) })
  const mediaUrl = vi.fn(native.mediaUrl)
  Object.assign(host, { kvGet: get, kvPut: set, kvDelete: remove, kvList: storageList, stat, list, query, directoriesWithFiles, changes, readRange, cacheLookup, cachePut, cacheDelete, mediaUrl })
  let clock = startedAt
  const seed = async (key: string, value: unknown, updatedAt?: number) => {
    if (updatedAt !== undefined) { await host.advance(updatedAt - clock); clock = updatedAt }
    const previous = (await native.kvGet(key)).record, result = await native.kvPut(key, { value: value as JsonValue, condition: previous ? { type: 'revision', revision: previous.revision } : { type: 'absent' } })
    records.set(key, result); return result
  }
  const binary = async (entry: FileNode, data: Uint8Array) => {
    await syncNodes()
    const original = entry
    bytes.set(entry.id, data)
    const previous = nodes.get(entry.id)
    if (previous) entry = await host.changeNode({ id: entry.id, bytes: [...data] })
    else entry = await host.addNode({ id: entry.id, parent_id: await ensureDirectory(parentPath(entry.path)), name: entry.name, kind: 'file', bytes: [...data] })
    nodes.replace(entry); Object.assign(original, entry); applied.set(entry.id, structuredClone(entry))
    if (entry.parent_id) { const parent = await native.stat({ by: 'id', id: entry.parent_id }); nodes.replace(parent); applied.set(parent.id, structuredClone(parent)) }
    return entry
  }
  if (configuration.source) {
    const directory = [...nodes.values()].find(node => node.path === configuration.source && node.kind === 'directory')
    if (!directory) throw new Error('测试来源目录不存在')
    await seed('library:sources', sources(directory).config)
    await seed('library:shelves:v1', shelves(directory).config)
  }
  const { ui, emitUi } = testUi()
  const context: PageContext = { contract: { major: 1, minor: 0 }, app: { id: 'reader', name: '阅读馆测试', version: '2.0.0', generation: 'g1' }, host_origin: 'https://test.invalid', api_base: 'https://test.invalid/admin/api/apps/v1/self', backend_base: null, ui_nonce: 'nonce', theme: 'light', launch: { action: 'browse' } }
  const page: PageRuntime = { host, ui, context, dispose: vi.fn() }
  pages.set(host, page)
  const eventListeners = new Map<string, Set<EventListener>>()
  const onHostEvent = (name: string, listener: EventListener) => { const listeners = eventListeners.get(name) ?? new Set<EventListener>(); listeners.add(listener); eventListeners.set(name, listeners); return () => listeners.delete(listener) }
  // 界面用例可以显式注入提示事件；持久文件变更仍读取 Rust changes，不能由此制造回执。
  const eventQueue: { event: string; data: unknown }[] = []
  let eventWake: (() => void) | undefined, eventSequence = 0
  host.events = async function* (options = {}) {
    while (!options.signal?.aborted) {
      if (!eventQueue.length) await new Promise<void>(resolve => {
        const abort = () => { options.signal?.removeEventListener('abort', abort); resolve() }
        eventWake = () => { options.signal?.removeEventListener('abort', abort); resolve() }
        options.signal?.addEventListener('abort', abort, { once: true })
      })
      options.signal?.throwIfAborted()
      const next = eventQueue.shift()
      if (next) yield { cursor: `event-${++eventSequence}`, occurred_at: 1, event: next.event, data: next.data as JsonValue }
    }
  }
  const emitEvent = async (name: string, data: unknown) => { eventQueue.push({ event: name, data }); eventWake?.(); await Promise.all([...(eventListeners.get(name) ?? [])].map(listener => listener(data))) }
  const listeners = new Map<string, (data?: unknown) => Promise<unknown>>()
  for (const name of ['files.changed', 'scope.changed', 'kv.changed', 'sync.required']) listeners.set(name, data => emitEvent(name, data))
  listeners.set('ui.theme_changed', data => emitUi({ event: 'ui.theme_changed', data: data as { theme: 'light' | 'dark' } }))
  listeners.set('ui.task_cancel', data => emitUi({ event: 'ui.task_cancel', data: data as { task_id: string } }))
  listeners.set('ui.before_close', async () => { await ui.close() })
  bindings.set(host, { ui, onHostEvent, openSettings: vi.fn(async () => {}) })
  return { host, page, ui, context, listeners, emitUi, onHostEvent, emitEvent, nodes, records, data: bytes, get, set, remove, storageList, stat, list, query, directoriesWithFiles, changes, readRange, seed, binary, cacheLookup, cachePut, cacheDelete, cacheEntries, mediaUrl, syncNodes }
}
