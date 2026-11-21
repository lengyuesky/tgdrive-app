/** 书库来源锚定目录 ID；路径只作显示和应用取材筛选，授权始终由宿主逐请求核对。 */
import type { FileNode, HostClient, JsonValue, NodeId } from '@tgdrive/page-sdk'
import { kvCondition } from '../records'
import { isAbort } from '../io'
import { fileVersion } from '../files'
import { LIBRARY_LIMITS, LibraryError, errorMessage, filePath, parentPath, validFile, validId, within } from './model'

export const SOURCES_KEY = 'library:sources'
export const SHELVES_KEY = 'library:shelves:v1'
export interface LibrarySource { nodeId: NodeId; path: string; contentVersion: string; addedAt: number; rootConfirmed: boolean; name?: string }
export interface SourcesConfig { schemaVersion: 1; sources: LibrarySource[] }
export interface SourcesSnapshot { config: SourcesConfig; revision: string | null }
export interface ResolvedSource { source: LibrarySource; file: FileNode }
export interface SourceRoots { roots: ResolvedSource[]; unavailable: { source: LibrarySource; message: string }[] }
export interface SearchParameters { q?: string; extensions?: string[]; kind?: 'file' | 'directory' | 'all'; cursor?: string | null }
type StatOutcome = { file: FileNode; error?: undefined } | { error: unknown; file?: undefined }

export function shelfName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 80 || /[\x00-\x1f\x7f]/.test(raw)) throw new LibraryError('invalid_shelf_name', '书库名称须为 1～80 个字符，不能含控制字符')
  return raw.trim()
}
export const sourceLabel = (source: LibrarySource) => source.name ?? (source.path === '/' ? '网盘根目录' : source.path.split('/').pop() || source.path)
export function parseSources(raw: unknown): SourcesConfig {
  const value = raw as SourcesConfig | null
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sources)) throw new LibraryError('unknown_sources', '来源配置损坏或版本未知，未覆盖原配置')
  if (value.sources.length > LIBRARY_LIMITS.sources) throw new LibraryError('source_limit', '每个应用最多添加 16 个来源')
  const seen = new Set<NodeId>()
  const sources = value.sources.map(source => {
    if (!source || !validId(source.nodeId) || seen.has(source.nodeId) || typeof source.path !== 'string'
      || typeof source.contentVersion !== 'string' || !source.contentVersion || source.contentVersion.length > 128
      || !Number.isFinite(source.addedAt) || source.addedAt < 0 || typeof source.rootConfirmed !== 'boolean') throw new LibraryError('invalid_sources', '来源标识无效或重复')
    const path = filePath(source.path), name = source.name === undefined ? undefined : shelfName(source.name)
    if (path === '/' && !source.rootConfirmed) throw new LibraryError('confirm_root', '添加根目录前必须确认包含整个网盘')
    seen.add(source.nodeId)
    return { ...source, path, ...(name === undefined ? {} : { name }) }
  })
  return { schemaVersion: 1, sources }
}
export function filesChangeAffectsSources(sources: readonly LibrarySource[], paths: unknown): boolean {
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) return true
  return paths.some(path => sources.some(source => within(path, source.path) || within(source.path, path)))
}
export function sourcesIdentity(snapshot: SourcesSnapshot): string {
  return JSON.stringify([snapshot.revision, snapshot.config.sources.map(source => [source.nodeId, source.rootConfirmed])])
}
export class SourcesStore {
  readonly key: string
  constructor(private host: HostClient, readonly manualShelves = false) { this.key = manualShelves ? SHELVES_KEY : SOURCES_KEY }
  private parse(raw: unknown) {
    const config = parseSources(raw)
    if (this.manualShelves) {
      const names = config.sources.map(source => source.name)
      if (names.some(name => !name) || new Set(names).size !== names.length) throw new LibraryError('invalid_shelves', '书库名称缺失或重复，未覆盖原配置')
    }
    return config
  }
  async load(signal?: AbortSignal): Promise<SourcesSnapshot> {
    const record = (await this.host.kvGet(this.key, { signal })).record
    signal?.throwIfAborted()
    return { config: record ? this.parse(record.value) : { schemaVersion: 1, sources: [] }, revision: record?.revision ?? null }
  }
  async save(config: SourcesConfig, revision: string | null, signal?: AbortSignal): Promise<SourcesSnapshot> {
    const value = this.parse(config)
    const record = await this.host.kvPut(this.key, { value: value as unknown as JsonValue, condition: kvCondition(revision) }, { signal })
    signal?.throwIfAborted()
    return { config: this.parse(record.value), revision: record.revision }
  }
  async add(base: SourcesSnapshot, path: string, confirmRoot = false, signal?: AbortSignal, name?: string) {
    const config = this.parse(base.config), selected = filePath(path)
    const label = this.manualShelves ? shelfName(name) : name === undefined ? undefined : shelfName(name)
    if (this.manualShelves && config.sources.some(source => source.name === label)) throw new LibraryError('duplicate_shelf_name', '此书库名称已使用，请换一个名称')
    if (selected === '/' && !confirmRoot) throw new LibraryError('confirm_root', '添加根目录前必须确认包含整个网盘')
    if (config.sources.length >= LIBRARY_LIMITS.sources) throw new LibraryError('source_limit', '每个应用最多添加 16 个来源')
    const directory = await this.host.stat({ by: 'path', path: selected }, { signal })
    if (!validFile(directory) || directory.kind !== 'directory' || directory.path !== selected) throw new LibraryError('source_unavailable', '所选来源不是有效目录')
    if (config.sources.some(source => source.nodeId === directory.id)) throw new LibraryError('duplicate_source', '此目录已经添加为来源')
    const current = await this.host.stat({ by: 'id', id: directory.id }, { signal })
    if (!sameNode(directory, current)) throw new LibraryError('source_changed', '所选来源发生变化，请重新选择')
    config.sources.push({ nodeId: current.id, path: current.path, contentVersion: current.revision, addedAt: Date.now(), rootConfirmed: selected === '/' && confirmRoot, ...(label === undefined ? {} : { name: label }) })
    return this.save(config, base.revision, signal)
  }
  rename(base: SourcesSnapshot, nodeId: NodeId, name: string, signal?: AbortSignal) {
    const config = this.parse(base.config), label = shelfName(name)
    if (!config.sources.some(source => source.nodeId === nodeId)) throw new LibraryError('source_removed', '此书库已移除，请重新读取配置')
    if (config.sources.some(source => source.nodeId !== nodeId && source.name === label)) throw new LibraryError('duplicate_shelf_name', '此书库名称已使用，请换一个名称')
    return this.save({ ...config, sources: config.sources.map(source => source.nodeId === nodeId ? { ...source, name: label } : source) }, base.revision, signal)
  }
  remove(base: SourcesSnapshot, nodeId: NodeId, signal?: AbortSignal) {
    const config = this.parse(base.config)
    if (!config.sources.some(source => source.nodeId === nodeId)) throw new LibraryError('source_removed', '此来源已移除，请重新读取配置')
    return this.save({ ...config, sources: config.sources.filter(source => source.nodeId !== nodeId) }, base.revision, signal)
  }
}
function sameNode(a: FileNode, b: FileNode) { return validFile(b) && a.id === b.id && a.path === b.path && a.kind === b.kind && fileVersion(a) === fileVersion(b) }
export class LibraryAccess {
  private snapshot: SourcesSnapshot = { config: { schemaVersion: 1, sources: [] }, revision: null }
  private generation = 0
  private controller = new AbortController()
  private openedSource?: LibrarySource
  private openedId?: NodeId
  constructor(readonly host: HostClient) {}
  setSources(snapshot: SourcesSnapshot) { this.snapshot = { config: parseSources(snapshot.config), revision: snapshot.revision }; this.generation++; this.controller.abort(); this.controller = new AbortController() }
  get identity() { return sourcesIdentity(this.snapshot) }
  get sources() { return structuredClone(this.snapshot.config.sources) }
  get revision() { return this.snapshot.revision }
  isOpenedFile(id: NodeId) { return id === this.openedId }
  /** 启动文件仅建立临时阅读来源，不创建书库、不扫描、不写来源配置。 */
  async setOpenedFile(file: FileNode, signal: AbortSignal) {
    const directory = file.kind === 'directory' ? file : await this.host.stat({ by: 'id', id: file.parent_id! }, { signal })
    if (directory.kind !== 'directory') throw new LibraryError('source_unavailable', '启动文件的目录不可用')
    this.openedId = file.id
    this.openedSource = { nodeId: directory.id, path: directory.path, contentVersion: directory.revision, addedAt: Date.now(), rootConfirmed: directory.path === '/' }
  }
  private ticket(signal: AbortSignal) {
    const generation = this.generation, combined = AbortSignal.any([signal, this.controller.signal])
    return { signal: combined, check: () => { combined.throwIfAborted(); if (generation !== this.generation) throw new LibraryError('source_changed', '来源已变化，请重新加载') } }
  }
  private async stat(id: NodeId, signal: AbortSignal) {
    const file = await this.host.stat({ by: 'id', id }, { signal })
    signal.throwIfAborted()
    if (!validFile(file) || file.id !== id) throw new LibraryError('invalid_file', '节点身份或文件信息无效')
    return file
  }
  private statMany(ids: NodeId[], signal: AbortSignal): Promise<StatOutcome[]> {
    return Promise.all(ids.map(async id => { try { return { file: await this.stat(id, signal) } } catch (error) { if (isAbort(error) || signal.aborted) throw error; return { error } } }))
  }
  private collectRoots(sources: LibrarySource[], outcomes: StatOutcome[]): SourceRoots {
    const roots: ResolvedSource[] = [], unavailable: SourceRoots['unavailable'] = []
    sources.forEach((source, index) => {
      const outcome = outcomes[index]!
      if (outcome.error !== undefined || !outcome.file) { unavailable.push({ source, message: errorMessage(outcome.error) }); return }
      if (outcome.file.kind !== 'directory' || outcome.file.path === '/' && !source.rootConfirmed) { unavailable.push({ source, message: '来源目录不可用或根目录尚未确认' }); return }
      roots.push({ source, file: outcome.file })
    })
    return { roots, unavailable }
  }
  private currentSources() {
    const sources = this.snapshot.config.sources
    return this.openedSource && !sources.some(source => source.nodeId === this.openedSource!.nodeId) ? [...sources, this.openedSource] : sources
  }
  async roots(signal: AbortSignal): Promise<SourceRoots> {
    const ticket = this.ticket(signal), sources = this.currentSources(), outcomes = await this.statMany(sources.map(source => source.nodeId), ticket.signal)
    ticket.check(); return this.collectRoots(sources, outcomes)
  }
  async file(nodeId: NodeId, signal: AbortSignal, expectedVersion?: string | null): Promise<{ file: FileNode; sourceIds: NodeId[] }> {
    if (!validId(nodeId)) throw new LibraryError('invalid_file', '文件标识无效')
    const ticket = this.ticket(signal), sources = this.currentSources()
    if (!sources.length) throw new LibraryError('no_sources', '请先添加阅读来源')
    const roots = await this.roots(ticket.signal)
    if (!roots.roots.length) throw new LibraryError('source_unavailable', '来源目录不可用；不会回退到根目录')
    const file = await this.stat(nodeId, ticket.signal)
    // 宿主只保证逐请求授权；应用的书库取材范围也可能在迟到响应期间移动，发布前重核身份与路径。
    const after = await this.statMany([...sources.map(source => source.nodeId), nodeId], ticket.signal)
    ticket.check()
    const latestRoots = this.collectRoots(sources, after.slice(0, sources.length))
    if (roots.roots.some(root => !latestRoots.roots.some(latest => latest.file.id === root.file.id && latest.file.path === root.file.path))) throw new LibraryError('source_changed', '来源目录在读取期间变化，请重新核对')
    const latest = after.at(-1)!
    if (!latest.file) throw latest.error
    if (!sameNode(file, latest.file) || latest.file.path !== file.path) throw new LibraryError('file_changed', '文件在读取期间变化，请重新打开')
    const sourceIds = latestRoots.roots.filter(root => within(file.path, root.file.path)).map(root => root.source.nodeId)
    if (!sourceIds.length) throw new LibraryError('outside_sources', '文件已不在当前来源范围内')
    if (expectedVersion != null && fileVersion(file) !== expectedVersion) throw new LibraryError('file_changed', '文件内容版本已变化，不能使用旧位置或旧封面')
    return { file, sourceIds }
  }
  async directory(path: string, signal: AbortSignal) {
    const normalized = filePath(path), found = await this.host.stat({ by: 'path', path: normalized }, { signal }), checked = await this.file(found.id, signal)
    if (checked.file.kind !== 'directory' || checked.file.path !== normalized) throw new LibraryError('directory_changed', '目录已移动，请重新刷新')
    return checked.file
  }
  async list(directoryId: NodeId, cursor: string | null, signal: AbortSignal) {
    const ticket = this.ticket(signal), before = await this.file(directoryId, ticket.signal)
    if (before.file.kind !== 'directory') throw new LibraryError('invalid_directory', '所选节点不是目录')
    const page = await this.host.list({ directory: { by: 'id', id: directoryId }, sort: 'name', order: 'asc', cursor, limit: LIBRARY_LIMITS.batch }, { signal: ticket.signal })
    const after = await this.stat(directoryId, ticket.signal)
    ticket.check()
    if (!sameNode(before.file, page.directory) || !sameNode(page.directory, after)) throw new LibraryError('directory_changed', '目录在分页期间发生变化，请从首页刷新')
    if (page.items.some(file => !validFile(file) || file.parent_id !== directoryId || parentPath(file.path) !== page.directory.path)) throw new LibraryError('invalid_page', '目录分页返回了越界或无效节点')
    if (page.next_cursor && page.next_cursor === cursor) throw new LibraryError('invalid_cursor', '目录分页游标没有推进')
    return { ...page, sourceIds: before.sourceIds }
  }
  async search(sourceId: NodeId, params: SearchParameters, signal: AbortSignal) {
    if (!this.snapshot.config.sources.some(source => source.nodeId === sourceId)) throw new LibraryError('source_removed', '所选来源已移除')
    const ticket = this.ticket(signal), before = await this.file(sourceId, ticket.signal)
    if (before.file.kind !== 'directory') throw new LibraryError('source_unavailable', '来源不是目录')
    const page = await this.host.query({ roots: [sourceId], recursive: true, filter: { kind: params.kind ?? 'all', name_contains: params.q || undefined, extensions: params.extensions ?? [], include_hidden: false }, sort: 'name', order: 'asc', limit: LIBRARY_LIMITS.batch, cursor: params.cursor }, { signal: ticket.signal })
    ticket.check()
    if (page.items.some(file => !validFile(file) || !within(file.path, before.file.path))) throw new LibraryError('invalid_page', '查询返回了来源外的节点')
    if (page.next_cursor && page.next_cursor === params.cursor) throw new LibraryError('invalid_cursor', '查询分页游标没有推进')
    return page
  }
  destroy() { this.generation++; this.controller.abort() }
}
