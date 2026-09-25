/** 应用层只需持有一个 ReadingLibrary；初始化不枚举正文，退出时显式销毁。 */
import type { Drive } from '../../sdk/types'
import { isAbort } from '../io'
import { BudgetCache, CACHE_BUDGETS, type CacheStatus } from './cache'
import { CoverStore } from '../cover-store'
import { CoverService, ThumbnailCache } from './covers'
import { queryLibrary, type LibraryQuery } from './catalog'
import { reconcileWorks } from './grouping'
import { HistoryStore } from './history'
import { MetadataService, metadataKey, validMetadataResult, type PdfOpener } from './metadata'
import { LibraryError, errorMessage, parseUnit, unitFormat, uniqueUnits, within, type BibliographicMetadata, type LibraryIssue, type LibraryKind, type ReadingUnit, type UnitReading, type WorkFlags } from './model'
import { ReadingDataStore } from './reading'
import { LibraryScanner, mergeScan, type ScanHandle, type ScanProgress, type ScanResult } from './scanner'
import { ShardedStore, type ShardedSnapshot } from './snapshot'
import { LibraryAccess, SourcesStore, sourcesIdentity, type SourceRoots, type SourcesMigration, type SourcesSnapshot } from './sources'
import { WorksStore, type WorksSnapshot } from './works'

interface IndexMeta { schemaVersion: 1; sourceIdentity: string; roots: { nodeId: number; path: string; contentVersion: string }[]; complete: boolean; indexedAt: number }
const rootVersions = (resolved: SourceRoots) => resolved.roots.map(root => ({ nodeId: root.source.nodeId, path: root.file.path, contentVersion: root.file.content_version }))
const indexMeta = (raw: unknown): IndexMeta => {
  const meta = raw as IndexMeta | null
  if (!meta || meta.schemaVersion !== 1 || typeof meta.sourceIdentity !== 'string' || typeof meta.complete !== 'boolean' || !Number.isFinite(meta.indexedAt)
    || !Array.isArray(meta.roots) || meta.roots.length > 16 || !meta.roots.every(root => root && Number.isSafeInteger(root.nodeId) && typeof root.path === 'string' && typeof root.contentVersion === 'string')) throw new LibraryError('invalid_index', '书库缓存格式无效，可以显式刷新重新整理')
  return { ...meta }
}
export interface LibrarySnapshot {
  sources: SourcesSnapshot
  migration: SourcesMigration['migration']
  units: ReadingUnit[]
  works: WorksSnapshot
  complete: boolean
  fromCache: boolean
  issues: LibraryIssue[]
  progress?: ScanProgress
}
export interface LibraryCallbacks {
  changed?: (snapshot: LibrarySnapshot) => void
  progress?: (progress: ScanProgress) => void
  cacheStatus?: (kind: 'metadata', status: CacheStatus) => void
}
export class ReadingLibrary {
  readonly sources: SourcesStore
  readonly access: LibraryAccess
  readonly works: WorksStore
  readonly metadata: MetadataService
  readonly covers: CoverService
  readonly history: HistoryStore
  readonly reading: ReadingDataStore
  private scanner: LibraryScanner
  private index: ShardedStore<ReadingUnit, IndexMeta>
  private indexSnapshot: ShardedSnapshot<ReadingUnit, IndexMeta>
  private state: LibrarySnapshot
  private roots: SourceRoots = { roots: [], unavailable: [] }
  private names = new Map<number, BibliographicMetadata>()
  private controller = new AbortController()
  private scan?: ScanHandle
  private workQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private initialized = false
  private paused = false
  constructor(readonly drive: Drive, readonly kind: LibraryKind, private callbacks: LibraryCallbacks = {}, private openPdf?: PdfOpener) {
    this.sources = new SourcesStore(drive); this.access = new LibraryAccess(drive); this.works = new WorksStore(drive)
    this.metadata = new MetadataService(drive, this.access, new BudgetCache(drive, 'metadata', CACHE_BUDGETS.metadata, validMetadataResult, status => callbacks.cacheStatus?.('metadata', status)), this.openPdf)
    this.covers = new CoverService(drive, this.access, new ThumbnailCache(new CoverStore(drive)), this.openPdf)
    this.history = new HistoryStore(drive, this.access); this.reading = new ReadingDataStore(drive, this.access, record => this.history.record(record, this.controller.signal))
    this.scanner = new LibraryScanner(this.access, kind)
    const empty = (): IndexMeta => ({ schemaVersion: 1, sourceIdentity: '', roots: [], complete: false, indexedAt: 0 })
    this.index = new ShardedStore(drive, 'library:cache:index', parseUnit, indexMeta, empty, 2000)
    this.indexSnapshot = { rows: [], meta: empty(), revision: null }
    this.state = { sources: { config: { schemaVersion: 1, sources: [] }, revision: null }, migration: 'none', units: [], works: { rows: [], meta: { schemaVersion: 1 }, revision: null }, complete: false, fromCache: false, issues: [] }
  }
  get snapshot(): LibrarySnapshot { return structuredClone(this.state) }
  private emit() { this.callbacks.changed?.(this.snapshot) }
  private current(generation: number, signal: AbortSignal) { signal.throwIfAborted(); this.controller.signal.throwIfAborted(); if (generation !== this.generation) throw new LibraryError('source_changed', '旧代阅读馆任务已停止') }
  private visible(units: readonly ReadingUnit[]) {
    return units.filter(unit => this.roots.roots.some(root => unit.sourceIds.includes(root.source.nodeId) || within(unit.file.path, root.file.path)))
      .map(unit => ({ ...unit, sourceIds: this.roots.roots.filter(root => unit.sourceIds.includes(root.source.nodeId) || within(unit.file.path, root.file.path)).map(root => root.source.nodeId) }))
  }
  async initialize(signal = this.controller.signal): Promise<LibrarySnapshot> {
    const current = AbortSignal.any([signal, this.controller.signal]), generation = ++this.generation
    this.initialized = false; this.scanner.cancel()
    const migrated = await this.sources.migrate(current)
    this.current(generation, current)
    this.state.sources = migrated.snapshot; this.state.migration = migrated.migration; this.access.setSources(migrated.snapshot)
    const roots = await this.access.roots(current); this.current(generation, current); this.roots = roots
    this.state.issues = this.roots.unavailable.map(item => ({ code: 'source_unavailable', nodeId: item.source.nodeId, message: item.message }))
    const works = await this.works.load(current); this.current(generation, current); this.state.works = works
    let indexHealthy = true
    try {
      const index = await this.index.load(current); uniqueUnits(index.rows); this.current(generation, current); this.indexSnapshot = index
    } catch (error) { this.current(generation, current); indexHealthy = false; this.state.issues.push({ code: 'index_unavailable', message: errorMessage(error) }) }
    this.current(generation, current)
    this.state.units = this.visible(this.indexSnapshot.rows)
    this.state.complete = indexHealthy && this.indexSnapshot.meta.complete && this.indexSnapshot.meta.sourceIdentity === this.access.identity
      && JSON.stringify(this.indexSnapshot.meta.roots) === JSON.stringify(rootVersions(this.roots)) && !this.roots.unavailable.length
    this.state.fromCache = this.state.units.length > 0
    for (const unit of this.state.units) {
      const cached = await this.metadata.cache.get(metadataKey(unit.file), current)
      if (cached) this.rememberName(unit.nodeId, cached.metadata)
    }
    this.current(generation, current); this.initialized = true; this.emit()
    return this.snapshot
  }
  private requireReady() { if (!this.initialized) throw new LibraryError('not_initialized', '请先初始化阅读馆；读取失败时不能用空配置覆盖原数据'); this.controller.signal.throwIfAborted() }
  private async changeSources(snapshot: SourcesSnapshot, signal: AbortSignal) {
    this.scanner.cancel(); this.metadata.pause(); this.covers.pause(); const generation = ++this.generation
    this.access.setSources(snapshot); this.state.sources = snapshot; this.state.complete = false; this.state.migration = 'existing'
    const roots = await this.access.roots(signal); this.current(generation, signal); this.roots = roots
    this.state.units = this.visible(this.indexSnapshot.rows)
    this.state.issues = this.roots.unavailable.map(item => ({ code: 'source_unavailable', nodeId: item.source.nodeId, message: item.message }))
    if (!this.paused) { this.metadata.resume(); this.covers.resume() }
    this.emit()
  }
  async addSource(path: string, options: { confirmedRoot?: boolean; base?: SourcesSnapshot; signal?: AbortSignal } = {}) {
    this.requireReady()
    const signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal
    const saved = await this.sources.add(options.base ?? this.state.sources, path, options.confirmedRoot ?? false, signal)
    await this.changeSources(saved, signal)
    // 添加立即开始轻量扫描；调用方可显示 result 和进度，也可在进入阅读时暂停。
    const scan = this.refresh(signal)
    return { sources: saved, scan }
  }
  async removeSource(nodeId: number, base = this.state.sources, signal = this.controller.signal) {
    this.requireReady()
    const saved = await this.sources.remove(base, nodeId, signal)
    await this.changeSources(saved, signal)
    return this.snapshot
  }
  refresh(signal = this.controller.signal): Promise<ScanResult> {
    this.requireReady()
    const generation = ++this.generation, sourceIdentity = this.access.identity
    const previous = this.indexSnapshot.rows, current = AbortSignal.any([signal, this.controller.signal])
    const check = () => { this.current(generation, current); if (sourceIdentity !== this.access.identity) throw new LibraryError('source_changed', '来源已变化，旧索引不会发布') }
    const firstIndexedAt = new Map(this.state.works.rows.flatMap(work => work.members.map(member => [member.unitId, member.firstIndexedAt ?? work.firstIndexedAt] as const)))
    const handle = this.scanner.start({ signal: current, previous, firstIndexedAt,
      onProgress: progress => {
        if (generation !== this.generation) return
        this.state.progress = progress
        if (!progress.complete) this.state.complete = false
        this.callbacks.progress?.(progress); this.emit()
      },
      onBatch: units => {
        if (generation !== this.generation) return
        const merged = new Map(this.state.units.map(unit => [unit.nodeId, unit]))
        for (const unit of units) if (merged.has(unit.nodeId) || merged.size < 2000) merged.set(unit.nodeId, unit)
        this.state.units = this.visible([...merged.values()]); this.state.fromCache = false
      },
    })
    this.scan = handle
    if (this.paused) handle.pause()
    return (async () => {
      const scan = await handle.result
      check()
      const roots = await this.access.roots(current); check(); this.roots = roots
      if (roots.unavailable.length || JSON.stringify(scan.sourceRoots) !== JSON.stringify(rootVersions(roots))) {
        scan.complete = false; scan.phase = 'incomplete'; scan.end = 'failed'
        scan.issues.push(...roots.unavailable.map(item => ({ code: 'source_unavailable', nodeId: item.source.nodeId, message: item.message })))
        if (!roots.unavailable.length) scan.issues.push({ code: 'source_changed', message: '来源在扫描结束后变化，旧索引保留，请重新刷新' })
      }
      const merged = mergeScan(previous, scan)
      this.state.units = this.visible(merged.units); this.state.complete = merged.complete
      this.state.issues = [...scan.issues]; this.state.fromCache = false
      await this.updateWorks(generation, current); check()
      const draft = { rows: merged.units, meta: { schemaVersion: 1 as const, sourceIdentity, roots: rootVersions(roots), complete: this.state.complete, indexedAt: Date.now() }, revision: this.indexSnapshot.revision }
      try { const index = await this.index.save(draft, current, check); check(); this.indexSnapshot = index }
      catch (error) { check(); this.indexSnapshot = draft; this.state.issues.push({ code: 'index_session_only', message: `索引暂存于本次会话：${errorMessage(error)}` }) }
      this.emit()
      return scan
    })()
  }
  private updateWorks(generation: number, signal: AbortSignal) {
    const task = this.workQueue.catch(() => {}).then(async () => {
      const check = () => this.current(generation, signal)
      check()
      const rows = reconcileWorks(this.state.works.rows, this.state.units, this.kind, this.names)
      if (JSON.stringify(rows) === JSON.stringify(this.state.works.rows)) return
      const works = await this.works.save({ ...this.state.works, rows }, signal, check)
      check(); this.state.works = works
    })
    this.workQueue = task
    return task
  }
  async publishWorks(draft: WorksSnapshot, signal = this.controller.signal) {
    this.requireReady(); this.scanner.cancel()
    const generation = ++this.generation, current = AbortSignal.any([signal, this.controller.signal])
    const check = () => this.current(generation, current)
    const saved = await this.works.save(draft, current, check)
    check(); this.state.works = saved; this.emit()
    return saved
  }
  private rememberName(nodeId: number, metadata: BibliographicMetadata) {
    const { description: _description, ...searchable } = metadata
    this.names.set(nodeId, searchable)
    while (this.names.size > 2000) this.names.delete(this.names.keys().next().value!)
  }
  async getMetadata(unit: ReadingUnit, signal = this.controller.signal) {
    this.requireReady()
    const generation = this.generation, result = await this.metadata.get(unit, signal)
    this.current(generation, signal); this.rememberName(unit.nodeId, result.metadata)
    await this.updateWorks(generation, signal); this.current(generation, signal); this.emit()
    return result
  }
  async loadReadingState(signal = this.controller.signal, onProgress?: (records: number) => void) {
    this.requireReady()
    const generation = this.generation, current = AbortSignal.any([signal, this.controller.signal])
    const state = await this.reading.loadCatalogState(this.state.units, this.state.works.rows, current, count => { if (generation === this.generation) onProgress?.(count) })
    this.current(generation, current)
    return state
  }
  query(query: LibraryQuery = {}, readings?: ReadonlyMap<number, UnitReading>, flags?: ReadonlyMap<string, WorkFlags>) {
    return queryLibrary({ units: this.state.units, works: this.state.works.rows, metadata: this.names, readings, flags, complete: this.state.complete }, query)
  }
  async openUnit(nodeId: number, signal = this.controller.signal) {
    this.requireReady()
    const checked = await this.access.file(nodeId, signal), format = unitFormat(checked.file, this.kind)
    if (!format) throw new LibraryError('unsupported_file', '文件不再是此应用支持的阅读格式')
    return { ...checked, format }
  }
  /**
   * 旧版把封面缩略图存在应用私有存储（与进度、书签共用 8 MiB 配额），漫画更早的版本还写过 `cover:` 记录。
   * 新版改存服务器封面库、不再写这些键：后台按修订号回收，每次会话最多一轮；失败或冲突只是留待下次。
   */
  async purgeLegacyCovers(signal = this.controller.signal) {
    const prefixes = ['library:cache:thumbnail:', ...(this.kind === 'comics' ? ['cover:'] : [])]
    const batch = typeof this.drive.can === 'function' && this.drive.can('rpc.batch') && typeof this.drive.batch === 'function'
    let removed = 0
    for (const prefix of prefixes) {
      for (let round = 0; round < 50; round++) {
        const page = await this.drive.storage.list({ prefix, limit: 64 }, { signal })
        signal.throwIfAborted()
        const records = page.records.filter(record => record.key.startsWith(prefix))
        if (!records.length) break
        let deleted = 0
        for (let start = 0; start < records.length; start += 16) {
          const slice = records.slice(start, start + 16)
          if (batch) {
            const results = await this.drive.batch(slice.map(record => ({ method: 'storage.delete', params: { key: record.key, expected_revision: record.revision } })), { signal })
            deleted += results.filter(item => !item.error).length
          } else {
            for (const record of slice) {
              try { await this.drive.storage.delete(record.key, record.revision, { signal }); deleted++ } catch (error) { if (isAbort(error)) throw error }
            }
          }
          signal.throwIfAborted()
        }
        removed += deleted
        if (!deleted || !page.has_more) break
      }
    }
    return removed
  }
  pause() { this.paused = true; this.scanner.pause(); this.metadata.pause(); this.covers.pause() }
  resume() { this.requireReady(); this.paused = false; this.metadata.resume(); this.covers.resume(); this.scanner.resume() }
  cancelScan() { this.scan?.cancel() }
  destroy() { this.generation++; this.controller.abort(); this.scanner.cancel(); this.history.cancel(); this.metadata.destroy(); this.covers.destroy(); this.access.destroy() }
}

/** 与页面生命周期绑定；进入阅读时由界面另行调用 library.pause()，离开阅读再 resume()。 */
export function bindLibraryLifecycle(library: ReadingLibrary, targetDocument = document, targetWindow = window) {
  const visibility = () => { if (targetDocument.hidden) library.pause() }
  const exit = () => library.destroy()
  targetDocument.addEventListener('visibilitychange', visibility); targetWindow.addEventListener('pagehide', exit, { once: true })
  return () => { targetDocument.removeEventListener('visibilitychange', visibility); targetWindow.removeEventListener('pagehide', exit) }
}
export const isLibraryAbort = (error: unknown) => isAbort(error) || (error as { name?: string })?.name === 'AbortError' || (error as { code?: string })?.code === 'source_changed'
export { sourcesIdentity }
