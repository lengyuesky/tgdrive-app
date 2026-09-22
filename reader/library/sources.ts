/** 来源按节点绑定；所有路径只作缓存，异步操作前后均核对身份和代次。 */
import type { BatchResult, Drive, FileEntry, Search } from '../../sdk/types'
import { gate, isAbort } from '../io'
import { LIBRARY_LIMITS, LibraryError, errorMessage, filePath, parentPath, validFile, validId, within } from './model'

export const SOURCES_KEY = 'library:sources'
export interface LibrarySource { nodeId: number; path: string; contentVersion: string; addedAt: number; rootConfirmed: boolean }
export interface SourcesConfig { schemaVersion: 1; sources: LibrarySource[] }
export interface SourcesSnapshot { config: SourcesConfig; revision: string | null }
export interface SourcesMigration { snapshot: SourcesSnapshot; migration: 'existing' | 'none' | 'migrated' | 'confirm-root' }
export interface ResolvedSource { source: LibrarySource; file: FileEntry }
export interface SourceRoots { roots: ResolvedSource[]; unavailable: { source: LibrarySource; message: string }[] }
/** 宿主批量信封的单次上限；更多节点分批核对。 */
const BATCH_LIMIT = 16
type StatOutcome = { file: FileEntry; error?: undefined } | { error: unknown; file?: undefined }

export function parseSources(raw: unknown): SourcesConfig {
  const value = raw as SourcesConfig | null
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sources)) throw new LibraryError('unknown_sources', '来源配置损坏或版本未知，未覆盖原配置')
  if (value.sources.length > LIBRARY_LIMITS.sources) throw new LibraryError('source_limit', '每个应用最多添加 16 个来源')
  const seen = new Set<number>()
  const sources = value.sources.map(source => {
    if (!source || !validId(source.nodeId) || seen.has(source.nodeId) || typeof source.path !== 'string'
      || typeof source.contentVersion !== 'string' || !source.contentVersion || source.contentVersion.length > 256
      || !Number.isFinite(source.addedAt) || source.addedAt < 0 || typeof source.rootConfirmed !== 'boolean') throw new LibraryError('invalid_sources', '来源标识无效或重复')
    const path = filePath(source.path)
    if (path === '/' && !source.rootConfirmed) throw new LibraryError('confirm_root', '添加根目录前必须确认包含整个网盘')
    seen.add(source.nodeId)
    return { ...source, path }
  })
  return { schemaVersion: 1, sources }
}
/**
 * 文件事件是否与阅读来源相关：宿主已按应用权限范围过滤，这里再按来源目录过滤。
 * `paths` 是发生变化的目录；缺省表示范围未知，一律相关。变更目录落在某个来源之下，
 * 或本身是来源目录的祖先（来源可能被改名、移动或删除）才需要重扫。
 */
export function filesChangeAffectsSources(sources: readonly LibrarySource[], paths: unknown): boolean {
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) return true
  if (!sources.length) return false
  return (paths as string[]).some(path => sources.some(source => within(path, source.path) || within(source.path, path)))
}
export function sourcesIdentity(snapshot: SourcesSnapshot): string {
  return JSON.stringify([snapshot.revision, snapshot.config.sources.map(source => [source.nodeId, source.rootConfirmed])])
}

export class SourcesStore {
  constructor(private drive: Drive) {}
  async load(signal?: AbortSignal): Promise<SourcesSnapshot> {
    signal?.throwIfAborted()
    const record = await this.drive.storage.get(SOURCES_KEY, { signal })
    signal?.throwIfAborted()
    return { config: record ? parseSources(record.value) : { schemaVersion: 1, sources: [] }, revision: record?.revision ?? null }
  }
  async save(config: SourcesConfig, revision: string | null, signal?: AbortSignal): Promise<SourcesSnapshot> {
    const value = parseSources(config)
    signal?.throwIfAborted()
    const record = await this.drive.storage.set(SOURCES_KEY, value, revision, { signal })
    signal?.throwIfAborted()
    return { config: parseSources(record.value), revision: record.revision }
  }
  async add(base: SourcesSnapshot, path: string, confirmRoot = false, signal?: AbortSignal) {
    const config = parseSources(base.config), selected = filePath(path)
    if (selected === '/' && !confirmRoot) throw new LibraryError('confirm_root', '添加根目录前必须确认包含整个网盘')
    if (config.sources.length >= LIBRARY_LIMITS.sources) throw new LibraryError('source_limit', '每个应用最多添加 16 个来源')
    signal?.throwIfAborted()
    const directory = await this.drive.files.stat({ path: selected }, { signal })
    signal?.throwIfAborted()
    if (!validFile(directory) || !directory.is_dir || directory.path !== selected) throw new LibraryError('source_unavailable', '所选来源不是有效目录')
    if (config.sources.some(source => source.nodeId === directory.id)) throw new LibraryError('duplicate_source', '此目录已经添加为来源')
    // 选择和保存之间目录可能被删除或移动，绝不把同路径的新节点作为原选择。
    const current = await this.drive.files.stat({ id: directory.id }, { signal })
    signal?.throwIfAborted()
    if (!sameNode(directory, current)) throw new LibraryError('source_changed', '所选来源发生变化，请重新选择')
    config.sources.push({ nodeId: current.id, path: current.path, contentVersion: current.content_version, addedAt: Date.now(), rootConfirmed: selected === '/' && confirmRoot })
    return this.save(config, base.revision, signal)
  }
  remove(base: SourcesSnapshot, nodeId: number, signal?: AbortSignal) {
    const config = parseSources(base.config)
    if (!config.sources.some(source => source.nodeId === nodeId)) throw new LibraryError('source_removed', '此来源已移除，请重新读取配置')
    return this.save({ ...config, sources: config.sources.filter(source => source.nodeId !== nodeId) }, base.revision, signal)
  }
  async migrate(signal?: AbortSignal, confirmRoot = false): Promise<SourcesMigration> {
    const snapshot = await this.load(signal)
    if (snapshot.revision !== null) return { snapshot, migration: 'existing' }
    const settings = await this.drive.settings.get()
    signal?.throwIfAborted()
    const legacy = settings.source_dir
    if (legacy === undefined || legacy === '') return { snapshot, migration: 'none' }
    if (typeof legacy !== 'string') throw new LibraryError('invalid_legacy_source', '旧版来源设置无效，未创建新来源')
    if (filePath(legacy) === '/' && !confirmRoot) return { snapshot, migration: 'confirm-root' }
    return { snapshot: await this.add(snapshot, legacy, confirmRoot, signal), migration: 'migrated' }
  }
}
function sameNode(a: FileEntry, b: FileEntry) {
  return validFile(b) && a.id === b.id && a.path === b.path && a.content_version === b.content_version && a.is_dir === b.is_dir
}

export class LibraryAccess {
  private snapshot: SourcesSnapshot = { config: { schemaVersion: 1, sources: [] }, revision: null }
  private generation = 0
  private controller = new AbortController()
  constructor(private drive: Drive) {}
  setSources(snapshot: SourcesSnapshot) {
    this.snapshot = { config: parseSources(snapshot.config), revision: snapshot.revision }
    this.generation++; this.controller.abort(); this.controller = new AbortController()
  }
  get identity() { return sourcesIdentity(this.snapshot) }
  get sources() { return structuredClone(this.snapshot.config.sources) }
  get revision() { return this.snapshot.revision }
  private ticket(signal: AbortSignal) {
    const generation = this.generation, combined = AbortSignal.any([signal, this.controller.signal])
    return { signal: combined, check: () => { combined.throwIfAborted(); if (generation !== this.generation) throw new LibraryError('source_changed', '来源已变化，请重新加载') } }
  }
  private validated(id: number, file: unknown): FileEntry {
    if (!validFile(file) || file.id !== id) throw new LibraryError('invalid_file', '节点身份或文件信息无效')
    return file
  }
  private async stat(id: number, signal: AbortSignal) {
    const file = await gate.run(signal, () => this.drive.files.stat({ id }, { signal }))
    signal.throwIfAborted()
    return this.validated(id, file)
  }
  /**
   * 一次核对多个节点：宿主声明 rpc.batch 时合并为一次往返（每 16 个一批），否则逐个 stat。
   * 每个节点独立返回文件或错误，取消一律向上抛出。
   */
  private async statMany(ids: number[], signal: AbortSignal): Promise<StatOutcome[]> {
    if (!ids.length) return []
    const batch = typeof this.drive.can === 'function' && this.drive.can('rpc.batch') && typeof this.drive.batch === 'function'
    if (!batch) {
      return Promise.all(ids.map(async (id): Promise<StatOutcome> => {
        try { return { file: await this.stat(id, signal) } } catch (error) { if (isAbort(error)) throw error; return { error } }
      }))
    }
    const outcomes: StatOutcome[] = []
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
      const slice = ids.slice(start, start + BATCH_LIMIT)
      const results: BatchResult[] = await gate.run(signal, () => this.drive.batch(slice.map(id => ({ method: 'files.stat', params: { id } })), { signal }))
      signal.throwIfAborted()
      if (!Array.isArray(results) || results.length !== slice.length) throw new LibraryError('invalid_file', '批量核对返回的条目数与请求不一致')
      slice.forEach((id, index) => {
        const item = results[index]!
        if (item.error) { outcomes.push({ error: item.error }); return }
        try { outcomes.push({ file: this.validated(id, item.result) }) } catch (error) { outcomes.push({ error }) }
      })
    }
    return outcomes
  }
  private collectRoots(sources: LibrarySource[], outcomes: StatOutcome[]): SourceRoots {
    const roots: ResolvedSource[] = [], unavailable: SourceRoots['unavailable'] = []
    sources.forEach((source, index) => {
      const outcome = outcomes[index]!
      if (outcome.error !== undefined || !outcome.file) { unavailable.push({ source, message: errorMessage(outcome.error) }); return }
      if (!outcome.file.is_dir || outcome.file.path === '/' && !source.rootConfirmed) { unavailable.push({ source, message: '来源目录不可用或根目录尚未确认' }); return }
      roots.push({ source, file: outcome.file })
    })
    return { roots, unavailable }
  }
  async roots(signal: AbortSignal): Promise<SourceRoots> {
    const ticket = this.ticket(signal), sources = this.snapshot.config.sources
    const outcomes = await this.statMany(sources.map(source => source.nodeId), ticket.signal)
    ticket.check()
    return this.collectRoots(sources, outcomes)
  }
  private requireRoots(roots: SourceRoots) {
    if (!this.snapshot.config.sources.length) throw new LibraryError('no_sources', '请先添加阅读来源')
    if (!roots.roots.length) throw new LibraryError('source_unavailable', '来源目录不可用；不会回退到根目录')
  }
  private stableRoots(before: SourceRoots, after: SourceRoots) {
    for (const root of before.roots) {
      const current = after.roots.find(item => item.source.nodeId === root.source.nodeId)
      if (!current || !sameNode(root.file, current.file)) throw new LibraryError('source_changed', '来源在读取期间发生变化，请刷新后重试')
    }
  }
  async file(nodeId: number, signal: AbortSignal, expectedVersion?: string): Promise<{ file: FileEntry; sourceIds: number[] }> {
    if (!validId(nodeId)) throw new LibraryError('invalid_file', '文件标识无效')
    const ticket = this.ticket(signal), sources = this.snapshot.config.sources
    if (!sources.length) throw new LibraryError('no_sources', '请先添加阅读来源')
    // 来源根与目标文件一次核对，再核对一次确认读取期间没有变化：支持批量时共两次往返。
    const ids = [...sources.map(source => source.nodeId), nodeId]
    const target = (outcomes: StatOutcome[]) => { const outcome = outcomes[sources.length]!; if (outcome.error !== undefined || !outcome.file) throw outcome.error; return outcome.file }
    const first = await this.statMany(ids, ticket.signal)
    ticket.check()
    const before = this.collectRoots(sources, first); this.requireRoots(before)
    const file = target(first)
    const second = await this.statMany(ids, ticket.signal)
    ticket.check(); const after = this.collectRoots(sources, second); this.stableRoots(before, after)
    const current = target(second)
    if (!sameNode(file, current)) throw new LibraryError('file_changed', '文件在读取期间发生变化，请刷新后重试')
    const sourceIds = after.roots.filter(root => within(current.path, root.file.path)).map(root => root.source.nodeId)
    if (!sourceIds.length) throw new LibraryError('outside_sources', '文件已不在当前来源范围内')
    if (expectedVersion !== undefined && current.content_version !== expectedVersion) throw new LibraryError('file_changed', '文件内容版本已变化，不能使用旧位置或旧封面')
    return { file: current, sourceIds }
  }
  /** 文件视图使用原生 SDK 游标，索引超限也仍可继续查找。 */
  async list(directoryId: number, cursor: string | null, signal: AbortSignal) {
    const ticket = this.ticket(signal), before = await this.file(directoryId, ticket.signal)
    if (!before.file.is_dir) throw new LibraryError('invalid_directory', '所选节点不是目录')
    const page = await gate.run(ticket.signal, () => this.drive.files.list({ path: before.file.path, cursor, limit: LIBRARY_LIMITS.batch }, { signal: ticket.signal }))
    ticket.check()
    const after = await this.file(directoryId, ticket.signal)
    ticket.check()
    if (!sameNode(before.file, after.file) || page.path !== after.file.path) throw new LibraryError('directory_changed', '目录在分页期间发生变化，请从第一批重试')
    if (page.entries.length > LIBRARY_LIMITS.batch || page.entries.some(file => !validFile(file) || file.id === directoryId || parentPath(file.path) !== after.file.path)) throw new LibraryError('invalid_page', '目录返回了过多、损坏或超出直属范围的节点')
    if (page.has_more && (!page.next_cursor || page.next_cursor === cursor)) throw new LibraryError('invalid_cursor', '目录分页游标无效')
    return { ...page, directory: after.file, sourceIds: after.sourceIds }
  }
  async search(sourceId: number, params: Pick<Search, 'q' | 'extensions' | 'kind' | 'cursor'>, signal: AbortSignal) {
    if (!this.snapshot.config.sources.some(source => source.nodeId === sourceId)) throw new LibraryError('source_removed', '所选来源已移除')
    const ticket = this.ticket(signal), before = await this.file(sourceId, ticket.signal)
    if (!before.file.is_dir) throw new LibraryError('source_unavailable', '来源不是目录')
    const page = await gate.run(ticket.signal, () => this.drive.files.searchPage({ ...params, under: before.file.path, limit: LIBRARY_LIMITS.batch }, { signal: ticket.signal }))
    ticket.check()
    const after = await this.file(sourceId, ticket.signal)
    ticket.check()
    if (!sameNode(before.file, after.file)) throw new LibraryError('source_changed', '来源在搜索期间发生变化，请重试')
    if (page.results.length > LIBRARY_LIMITS.batch || page.results.some(file => !validFile(file) || !within(file.path, after.file.path))) throw new LibraryError('invalid_page', '搜索返回了过多、损坏或超出来源范围的节点')
    if (page.has_more && (!page.next_cursor || page.next_cursor === params.cursor)) throw new LibraryError('invalid_cursor', '搜索分页游标无效')
    return page
  }
  destroy() { this.generation++; this.controller.abort() }
}
