/** 通用索引流式发现阅读单元；不递归列全盘、不设全库条数截断，结束后增量核对。 */
import type { NodeId } from '@tgdrive/page-sdk'
import { isAbort } from '../io'
import { discoverPage, type DiscoveryCursor } from './discovery'
import { reconcileUnits } from './reconcile'
import { LibraryAccess, type SourceRoots } from './sources'
import { LIBRARY_LIMITS, LibraryError, errorMessage, timeSlice, unitFormat, within, type LibraryIssue, type LibraryScope, type ReadingUnit } from './model'

export type ScanPhase = 'scanning' | 'paused' | 'complete' | 'incomplete'
export type ScanEnd = 'complete' | 'cancelled' | 'failed'
export interface ScanProgress { phase: ScanPhase; nodes: number; directories: number; units: number; complete: boolean; issues: LibraryIssue[] }
export interface ScanResult extends ScanProgress { unitsFound: ReadingUnit[]; sourceIdentity: string; sourceRoots: { nodeId: NodeId; path: string; contentVersion: string }[]; end: ScanEnd; scannedPaths?: string[]; changeCursor?: string }
export interface ScanOptions { signal?: AbortSignal; sourceId?: NodeId; changedPaths?: readonly string[]; previous?: readonly ReadingUnit[]; firstIndexedAt?: ReadonlyMap<NodeId, number>; onProgress?: (progress: ScanProgress) => void; onBatch?: (units: readonly ReadingUnit[], progress: ScanProgress) => void }
export interface ScanHandle { result: Promise<ScanResult>; pause(): void; resume(): void; cancel(): void }
export class LibraryScanner {
  private active?: ScanHandle
  constructor(private access: LibraryAccess, private kind: LibraryScope) {}
  start(options: ScanOptions = {}): ScanHandle {
    this.active?.cancel()
    const lifetime = new AbortController(), signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
    let request = new AbortController(), paused = false, wake: (() => void) | undefined
    const sourceIdentity = this.access.identity, units = new Map<NodeId, ReadingUnit>(), directories = new Set<NodeId>()
    const old = new Map((options.previous ?? []).map(unit => [unit.nodeId, unit]))
    let roots: SourceRoots = { roots: [], unavailable: [] }, nodes = 0, end: ScanEnd = 'complete', changeCursor: string | undefined
    let scannedPaths: string[] | undefined
    const issues: LibraryIssue[] = []
    const progress = (phase: ScanPhase): ScanProgress => ({ phase, nodes, directories: directories.size, units: units.size, complete: phase === 'complete', issues: [...issues] })
    const notify = (phase: ScanPhase) => options.onProgress?.(progress(phase))
    const stop = () => { request.abort(); wake?.(); wake = undefined }
    signal.addEventListener('abort', stop, { once: true })
    const checkpoint = async () => {
      signal.throwIfAborted()
      while (paused) { await new Promise<void>(resolve => { wake = resolve }); signal.throwIfAborted() }
      if (sourceIdentity !== this.access.identity) throw new LibraryError('source_changed', '来源已变化，旧扫描已停止')
      request = new AbortController(); return AbortSignal.any([signal, request.signal])
    }
    const resumable = async <T>(work: (requestSignal: AbortSignal) => Promise<T>): Promise<T> => {
      for (;;) {
        const requestSignal = await checkpoint()
        try { const value = await work(requestSignal); requestSignal.throwIfAborted(); return value }
        catch (error) { signal.throwIfAborted(); if (requestSignal.aborted) continue; throw error }
      }
    }
    const result = (async (): Promise<ScanResult> => {
      try {
        const available = await resumable(requestSignal => this.access.roots(requestSignal))
        const configured = new Set(this.access.sources.map(source => source.nodeId))
        roots = { roots: available.roots.filter(root => configured.has(root.source.nodeId) && (options.sourceId === undefined || root.source.nodeId === options.sourceId)), unavailable: available.unavailable.filter(item => options.sourceId === undefined || item.source.nodeId === options.sourceId) }
        for (const item of roots.unavailable) issues.push({ code: 'source_unavailable', nodeId: item.source.nodeId, message: item.message })
        if (!roots.roots.length) throw new LibraryError('source_unavailable', '没有可用书库目录，不会回退到全盘')
        let scanRoots = roots.roots.map(root => root.file)
        if (options.changedPaths) {
          scannedPaths = []
          const selected = scanRoots.filter(root => options.changedPaths!.some(path => within(path, root.path) || within(root.path, path)))
          const narrowed = []
          for (const root of selected) {
            const paths = options.changedPaths.filter(path => within(path, root.path))
            if (!paths.length || options.changedPaths.some(path => within(root.path, path))) { narrowed.push(root); scannedPaths.push(root.path); continue }
            for (const path of paths.filter(path => !paths.some(other => other !== path && within(path, other)))) {
              try { const folder = await this.access.directory(path, signal); narrowed.push(folder); scannedPaths.push(folder.path) }
              catch (error) { signal.throwIfAborted(); narrowed.push(root); scannedPaths.push(root.path) }
            }
          }
          scanRoots = narrowed
        } else if (options.sourceId !== undefined) scannedPaths = scanRoots.map(root => root.path)
        for (const root of scanRoots) directories.add(root.id)
        let cursor: DiscoveryCursor | null = null
        let scopeRevision: string | undefined
        notify('scanning')
        if (scanRoots.length) do {
          const requestSignal = await checkpoint()
          try {
            const page = await discoverPage(this.access.host, { roots: scanRoots.map(root => root.id), kind: this.kind, sort: 'name', limit: LIBRARY_LIMITS.batch, cursor }, requestSignal)
            requestSignal.throwIfAborted()
            changeCursor ??= page.scan_cursor
            if (scopeRevision && scopeRevision !== page.scope_revision) throw new LibraryError('scope_changed', '扫描期间目录授权已变化')
            scopeRevision = page.scope_revision
            const batch: ReadingUnit[] = []
            for (const file of page.items) {
              nodes++
              if (file.kind === 'directory') directories.add(file.id)
              const format = unitFormat(file, this.kind), sourceIds = roots.roots.filter(root => within(file.path, root.file.path)).map(root => root.source.nodeId)
              if (!format || !sourceIds.length) throw new LibraryError('invalid_page', '通用索引返回了书库外或不支持的节点')
              const unit = { nodeId: file.id, file, format, sourceIds, firstIndexedAt: options.firstIndexedAt?.get(file.id) ?? old.get(file.id)?.firstIndexedAt ?? Date.now() }
              if (!units.has(file.id)) batch.push(unit)
              units.set(file.id, unit)
            }
            cursor = page.next_cursor
            options.onBatch?.(batch, progress('scanning')); notify('scanning')
            await timeSlice(signal)
          } catch (error) { signal.throwIfAborted(); if (requestSignal.aborted) { notify('paused'); continue }; throw error }
        } while (cursor)
        if (changeCursor) {
          const reconciled = await resumable(requestSignal => reconcileUnits(this.access, roots, this.kind, [...units.values()], changeCursor!, requestSignal))
          units.clear(); for (const unit of reconciled.units) units.set(unit.nodeId, unit)
          changeCursor = reconciled.cursor
        }
        const latest = await resumable(requestSignal => this.access.roots(requestSignal))
        for (const root of roots.roots) {
          const current = latest.roots.find(item => item.source.nodeId === root.source.nodeId)
          if (!current || current.file.path !== root.file.path) throw new LibraryError('source_changed', '来源目录在扫描期间移动，旧索引保留，请重新核对')
        }
        roots = { roots: latest.roots.filter(root => roots.roots.some(old => old.source.nodeId === root.source.nodeId)), unavailable: roots.unavailable }
        if (issues.length) end = 'failed'
      } catch (error) {
        if (signal.aborted || isAbort(error)) end = 'cancelled'
        else { end = 'failed'; issues.push({ code: (error as { code?: string }).code ?? 'scan_failed', message: errorMessage(error) }) }
      } finally { signal.removeEventListener('abort', stop) }
      if (end === 'cancelled') issues.push({ code: end, message: '扫描已取消，旧记录保留，索引尚未完整' })
      const state = progress(end === 'complete' ? 'complete' : 'incomplete')
      options.onProgress?.(state)
      return { ...state, unitsFound: [...units.values()], sourceIdentity, sourceRoots: roots.roots.map(root => ({ nodeId: root.source.nodeId, path: root.file.path, contentVersion: root.file.revision })), end, scannedPaths, changeCursor }
    })()
    const handle: ScanHandle = { result, pause: () => { if (!paused) { paused = true; request.abort(); notify('paused') } }, resume: () => { if (paused) { paused = false; wake?.(); wake = undefined } }, cancel: () => lifetime.abort() }
    this.active = handle
    void result.finally(() => { if (this.active === handle) this.active = undefined })
    return handle
  }
  pause() { this.active?.pause() }
  resume() { this.active?.resume() }
  cancel() { this.active?.cancel() }
}
/** 失败、取消或局部核对不删除未核实的旧项；完整扫描才移除消失记录。 */
export function mergeScan(previous: readonly ReadingUnit[], scan: ScanResult): { units: ReadingUnit[]; complete: boolean } {
  const preserved = scan.complete ? scan.scannedPaths ? previous.filter(unit => !scan.scannedPaths!.some(path => within(unit.file.path, path))) : [] : previous
  const units = new Map(preserved.map(unit => [unit.nodeId, unit]))
  for (const unit of scan.unitsFound) units.set(unit.nodeId, unit)
  return { units: [...units.values()], complete: scan.complete }
}
