/** 历史列表不依赖 storage.list 的键序；分页遍历只保留最新 2000 条时间索引。 */
import type { Drive, RecordValue } from '../../sdk/types'
import { isAbort } from '../io'
import { LIBRARY_LIMITS, LibraryError, errorMessage, sortRecent, timeSlice, type LibraryProgress } from './model'
import { validProgress } from './reading'
import type { LibraryAccess } from './sources'
import { ShardedStore, type ShardedSnapshot } from './snapshot'

export interface HistoryEntry { nodeId: number; progress: LibraryProgress; updatedAt: number; revision: string }
export interface HistoryMeta { schemaVersion: 1; complete: boolean; truncated: boolean; scanned: number; cursor: string | null }
export interface HistoryProgress extends HistoryMeta { retained: number; message?: string }
export type HistorySnapshot = ShardedSnapshot<HistoryEntry, HistoryMeta>
const emptyMeta = (): HistoryMeta => ({ schemaVersion: 1, complete: false, truncated: false, scanned: 0, cursor: null })
const parseMeta = (raw: unknown): HistoryMeta => {
  const meta = raw as HistoryMeta | null
  if (!meta || meta.schemaVersion !== 1 || typeof meta.complete !== 'boolean' || typeof meta.truncated !== 'boolean' || !Number.isSafeInteger(meta.scanned) || meta.scanned < 0 || !(meta.cursor === null || typeof meta.cursor === 'string')) throw new LibraryError('unknown_history', '历史索引格式未知，原阅读记录保留')
  return structuredClone(meta)
}
const parseEntry = (raw: unknown): HistoryEntry => {
  const entry = raw as HistoryEntry | null
  if (!entry || !validProgress(entry.progress) || entry.progress.file.id !== entry.nodeId || !Number.isFinite(entry.updatedAt) || typeof entry.revision !== 'string') throw new LibraryError('invalid_history', '历史索引条目无效')
  return structuredClone(entry)
}
const newest = (entries: readonly HistoryEntry[]) => {
  const map = new Map<number, HistoryEntry>()
  for (const entry of entries) if (!map.has(entry.nodeId) || map.get(entry.nodeId)!.updatedAt <= entry.updatedAt) map.set(entry.nodeId, entry)
  return sortRecent([...map.values()]).slice(0, LIBRARY_LIMITS.history)
}
export class HistoryStore {
  private store: ShardedStore<HistoryEntry, HistoryMeta>
  private current?: HistorySnapshot
  private generation = 0
  private queue = Promise.resolve()
  constructor(private drive: Drive, private access: LibraryAccess) { this.store = new ShardedStore(drive, 'library:cache:history', parseEntry, parseMeta, emptyMeta, LIBRARY_LIMITS.history) }
  async load(signal?: AbortSignal): Promise<HistorySnapshot> {
    const before = this.current, snapshot = await this.store.load(signal)
    snapshot.rows = newest(snapshot.rows)
    this.current = this.current && this.current !== before ? { ...this.current, rows: newest([...snapshot.rows, ...this.current.rows]) } : snapshot
    return structuredClone(this.current)
  }
  get snapshot(): HistorySnapshot { return structuredClone(this.current ?? { rows: [], meta: emptyMeta(), revision: null }) }
  private persist(snapshot: HistorySnapshot, signal?: AbortSignal) {
    const task = this.queue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = await this.store.load(signal)
        const draft = { ...snapshot, revision: base.revision, rows: newest([...base.rows, ...snapshot.rows]) }
        try {
          const saved = await this.store.save(draft, signal)
          this.current = { ...saved, rows: newest([...(this.current?.rows ?? []), ...saved.rows]) }
          return
        } catch (error) {
          if ((error as Error & { cause?: { code?: string } }).cause?.code !== 'storage_conflict' || attempt === 1) throw error
        }
      }
    })
    this.queue = task
    return task
  }
  async record(record: RecordValue<LibraryProgress>, signal?: AbortSignal) {
    if (!validProgress(record.value) || record.key !== `progress:${record.value.file.id}`) throw new LibraryError('invalid_progress', '历史记录格式无效')
    const current = this.current ?? await this.load(signal)
    const row: HistoryEntry = { nodeId: record.value.file.id, progress: record.value, revision: record.revision, updatedAt: record.updated_at }
    const rows = newest([...current.rows, row])
    this.current = { ...current, rows }
    await this.persist(this.current, signal)
  }
  async migrate(options: { signal: AbortSignal; resume?: boolean; onProgress?: (progress: HistoryProgress) => void }): Promise<HistoryProgress> {
    const generation = ++this.generation, base = this.current ?? await this.load(options.signal)
    let rows = options.resume && !base.meta.complete ? [...base.rows] : []
    const meta = options.resume && !base.meta.complete ? { ...base.meta } : emptyMeta()
    const seen = new Set<string>()
    let message: string | undefined
    try {
      do {
        options.signal.throwIfAborted()
        if (generation !== this.generation) throw new LibraryError('history_changed', '历史整理已被新任务替换')
        const page = await this.drive.storage.list<LibraryProgress>({ prefix: 'progress:', cursor: meta.cursor, limit: LIBRARY_LIMITS.batch }, { signal: options.signal })
        options.signal.throwIfAborted()
        if (generation !== this.generation) throw new LibraryError('history_changed', '历史整理已被新任务替换')
        for (const record of page.records) {
          meta.scanned++
          if (validProgress(record.value) && record.key === `progress:${record.value.file.id}` && Number.isFinite(record.updated_at)) rows.push({ nodeId: record.value.file.id, progress: record.value, revision: record.revision, updatedAt: record.updated_at })
        }
        if (rows.length > LIBRARY_LIMITS.history) meta.truncated = true
        rows = newest(rows)
        meta.complete = !page.has_more
        meta.cursor = page.next_cursor
        if (page.has_more && (!meta.cursor || seen.has(meta.cursor))) throw new LibraryError('invalid_cursor', '历史分页游标无效，排序仅限已整理范围')
        if (meta.cursor) seen.add(meta.cursor)
        options.onProgress?.({ ...meta, retained: rows.length })
        if (meta.complete) break
        await timeSlice(options.signal)
      } while (meta.cursor)
    } catch (error) {
      meta.complete = false
      message = options.signal.aborted || isAbort(error) ? '历史整理已取消，排序仅限已整理范围' : errorMessage(error)
    }
    if (generation === this.generation) {
      const combined = newest([...(this.current?.rows ?? base.rows), ...rows])
      this.current = { rows: combined, meta, revision: base.revision }
      if (!options.signal.aborted) {
        try { await this.persist(this.current, options.signal) } catch (error) { message = `历史暂存于会话：${errorMessage(error)}` }
      }
    }
    const result = { ...meta, retained: this.current?.rows.length ?? rows.length, message }
    if (generation === this.generation) options.onProgress?.(result)
    return result
  }
  async page(offset: number, limit: number, signal: AbortSignal) {
    const identity = this.access.identity
    const check = () => { signal.throwIfAborted(); if (identity !== this.access.identity) throw new LibraryError('source_changed', '来源已变化，旧历史页不会发布') }
    const snapshot = this.current ?? await this.load(signal)
    check()
    const start = Math.max(0, Math.floor(offset)), size = Math.max(1, Math.min(200, Math.floor(limit)))
    const selected = snapshot.rows.slice(start, start + size)
    const visible = []
    let failed = 0
    for (const entry of selected) {
      try {
        const current = await this.access.file(entry.nodeId, signal)
        check()
        visible.push({ ...entry, file: current.file, sourceIds: current.sourceIds, location: current.file.content_version === entry.progress.file.content_version ? entry.progress.location : undefined })
      } catch (error) { signal.throwIfAborted(); if (identity !== this.access.identity || isAbort(error)) throw error; if (!['outside_sources', 'no_sources', 'source_unavailable', 'not_found'].includes((error as { code?: string }).code ?? '')) failed++ }
    }
    check()
    return { entries: visible, nextOffset: start + size < snapshot.rows.length ? start + size : null, complete: snapshot.meta.complete,
      limited: snapshot.meta.truncated || !snapshot.meta.complete, failed }
  }
  cancel() { this.generation++ }
}
