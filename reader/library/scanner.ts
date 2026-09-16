/** 流式轻索引：每批 200 节点，只记直属图片目录，不保存全库页图。 */
import { isAbort, isImage } from '../io'
import { LibraryAccess, type SourceRoots } from './sources'
import { LIBRARY_LIMITS, LibraryError, errorMessage, timeSlice, unitFormat, within, type LibraryIssue, type LibraryKind, type ReadingUnit } from './model'

export type ScanPhase = 'scanning' | 'paused' | 'complete' | 'incomplete'
export type ScanEnd = 'complete' | 'cancelled' | 'unit-limit' | 'directory-limit' | 'failed'
export interface ScanProgress { phase: ScanPhase; nodes: number; directories: number; units: number; complete: boolean; issues: LibraryIssue[] }
export interface ScanResult extends ScanProgress { unitsFound: ReadingUnit[]; sourceIdentity: string; sourceRoots: { nodeId: number; path: string; contentVersion: string }[]; end: ScanEnd }
export interface ScanOptions {
  signal?: AbortSignal
  previous?: readonly ReadingUnit[]
  firstIndexedAt?: ReadonlyMap<number, number>
  onProgress?: (progress: ScanProgress) => void
  onBatch?: (units: readonly ReadingUnit[], progress: ScanProgress) => void
}
export interface ScanHandle { result: Promise<ScanResult>; pause(): void; resume(): void; cancel(): void }

export class LibraryScanner {
  private active?: ScanHandle
  constructor(private access: LibraryAccess, private kind: LibraryKind) {}
  start(options: ScanOptions = {}): ScanHandle {
    this.active?.cancel()
    const lifetime = new AbortController()
    let request = new AbortController(), paused = false, wake: (() => void) | undefined
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
    const sourceIdentity = this.access.identity
    const units = new Map<number, ReadingUnit>(), directories = new Set<number>(), queue: { id: number; cursor: string | null; cursors: Set<string>; version?: string; path?: string }[] = []
    const old = new Map((options.previous ?? []).map(unit => [unit.nodeId, unit]))
    let roots: SourceRoots = { roots: [], unavailable: [] }, nodes = 0, end: ScanEnd = 'complete'
    const issues: LibraryIssue[] = []
    const progress = (phase: ScanPhase): ScanProgress => ({ phase, nodes, directories: directories.size, units: units.size, complete: phase === 'complete', issues: [...issues] })
    const notify = (phase: ScanPhase) => options.onProgress?.(progress(phase))
    const stop = () => { request.abort(); wake?.(); wake = undefined }
    signal.addEventListener('abort', stop, { once: true })
    const checkpoint = async () => {
      signal.throwIfAborted()
      while (paused) { await new Promise<void>(resolve => { wake = resolve }); signal.throwIfAborted() }
      if (sourceIdentity !== this.access.identity) throw new LibraryError('source_changed', '来源已变化，旧扫描已停止')
      request = new AbortController()
      return AbortSignal.any([signal, request.signal])
    }
    const readRoots = async () => {
      while (true) {
        const requestSignal = await checkpoint()
        try { const value = await this.access.roots(requestSignal); requestSignal.throwIfAborted(); return value }
        catch (error) { signal.throwIfAborted(); if (requestSignal.aborted) continue; throw error }
      }
    }
    const enqueue = (id: number) => {
      if (directories.has(id)) return true
      if (directories.size >= LIBRARY_LIMITS.directories) { end = 'directory-limit'; return false }
      directories.add(id); queue.push({ id, cursor: null, cursors: new Set() }); return true
    }
    const result = (async (): Promise<ScanResult> => {
      try {
        roots = await readRoots()
        for (const item of roots.unavailable) issues.push({ code: 'source_unavailable', nodeId: item.source.nodeId, message: item.message })
        for (const root of roots.roots) enqueue(root.file.id)
        notify('scanning')
        while (queue.length && end === 'complete') {
          const directory = queue[0]!
          let requestSignal: AbortSignal | undefined
          try {
            requestSignal = await checkpoint()
            const page = await this.access.list(directory.id, directory.cursor, requestSignal)
            requestSignal.throwIfAborted()
            if (directory.version !== undefined && (directory.version !== page.directory.content_version || directory.path !== page.directory.path)) throw new LibraryError('directory_changed', '目录分页期间已改变，保留旧索引并等待刷新')
            directory.version = page.directory.content_version; directory.path = page.directory.path
            const batch: ReadingUnit[] = []
            const add = (file: typeof page.directory, format: ReadingUnit['format']) => {
              if (units.has(file.id)) return
              if (units.size >= LIBRARY_LIMITS.units) { end = 'unit-limit'; return }
              const sourceIds = roots.roots.filter(root => within(file.path, root.file.path)).map(root => root.source.nodeId)
              if (!sourceIds.length) throw new LibraryError('source_changed', '来源范围在扫描期间变化')
              const unit: ReadingUnit = { nodeId: file.id, file, format, sourceIds, firstIndexedAt: options.firstIndexedAt?.get(file.id) ?? old.get(file.id)?.firstIndexedAt ?? Date.now() }
              units.set(file.id, unit); batch.push(unit)
              if (units.size === LIBRARY_LIMITS.units) end = 'unit-limit'
            }
            for (const file of page.entries) {
              nodes++
              if (file.is_dir) enqueue(file.id)
              else {
                const format = unitFormat(file, this.kind)
                if (format) add(file, format)
                else if (this.kind === 'comics' && isImage(file.name) && !file.name.startsWith('.')) add(page.directory, 'images')
              }
              if (end !== 'complete') break
            }
            if (page.has_more) {
              if (!page.next_cursor || directory.cursors.has(page.next_cursor)) throw new LibraryError('invalid_cursor', '目录分页游标无效，索引尚未完整')
              directory.cursors.add(page.next_cursor); directory.cursor = page.next_cursor
            } else queue.shift()
            options.onBatch?.(batch, progress('scanning')); notify('scanning')
            await timeSlice(signal)
          } catch (error) {
            if (signal.aborted) throw error
            if (requestSignal?.aborted) { if (paused) notify('paused'); continue }
            if (isAbort(error)) throw error
            issues.push({ code: (error as { code?: string }).code ?? 'scan_failed', nodeId: directory.id, message: errorMessage(error) })
            queue.shift()
          }
        }
        if (end === 'complete') {
          const latest = await readRoots()
          for (const root of roots.roots) {
            const current = latest.roots.find(item => item.source.nodeId === root.source.nodeId)
            if (!current || current.file.path !== root.file.path || current.file.content_version !== root.file.content_version) issues.push({ code: 'source_changed', nodeId: root.source.nodeId, message: '来源在扫描期间变化，旧索引保留，请重新刷新' })
          }
        }
        if (issues.length && end === 'complete') end = 'failed'
      } catch (error) {
        if (signal.aborted || isAbort(error)) end = 'cancelled'
        else { end = 'failed'; issues.push({ code: 'scan_failed', message: errorMessage(error) }) }
      } finally { signal.removeEventListener('abort', stop) }
      // add/enqueue 回调也会更新截止原因，不能仅按外层分支推断类型。
      const outcome = end as ScanEnd
      if (outcome === 'unit-limit') issues.push({ code: outcome, message: '已达到 2000 个阅读单元，仅展示已整理范围；可在文件视图继续分页查找' })
      if (outcome === 'directory-limit') issues.push({ code: outcome, message: '已达到 10000 个目录，仅展示已整理范围' })
      if (outcome === 'cancelled') issues.push({ code: outcome, message: '扫描已取消，旧记录保留，索引尚未完整' })
      const state = progress(outcome === 'complete' ? 'complete' : 'incomplete')
      options.onProgress?.(state)
      return { ...state, unitsFound: [...units.values()], sourceIdentity, sourceRoots: roots.roots.map(root => ({ nodeId: root.source.nodeId, path: root.file.path, contentVersion: root.file.content_version })), end: outcome }
    })()
    const handle: ScanHandle = { result,
      pause: () => { if (!paused) { paused = true; request.abort(); notify('paused') } },
      resume: () => { if (paused) { paused = false; wake?.(); wake = undefined } },
      cancel: () => lifetime.abort(),
    }
    this.active = handle
    void result.finally(() => { if (this.active === handle) this.active = undefined })
    return handle
  }
  pause() { this.active?.pause() }
  resume() { this.active?.resume() }
  cancel() { this.active?.cancel() }
}

/** 只有全扫描成功才核对消失项；局部扫描永远不能把旧缓存误当成空库清除。 */
export function mergeScan(previous: readonly ReadingUnit[], scan: ScanResult): { units: ReadingUnit[]; complete: boolean } {
  if (scan.complete) return { units: scan.unitsFound, complete: true }
  const units = new Map(previous.map(unit => [unit.nodeId, unit]))
  for (const unit of scan.unitsFound) if (units.has(unit.nodeId) || units.size < LIBRARY_LIMITS.units) units.set(unit.nodeId, unit)
  return { units: [...units.values()].slice(0, LIBRARY_LIMITS.units), complete: false }
}
