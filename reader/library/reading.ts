/** 阅读状态、想读和收藏相互独立；进度仍以原 fileId 键保存，书签完全不迁移。 */
import type { Drive, FileEntry, Page, RecordValue } from '../../sdk/types'
import { validLocation, type Location } from '../state'
import { LibraryError, timeSlice, validFile, type LibraryProgress, type ReadingStatus, type ReadingSummary, type ReadingUnit, type UnitReading, type UnitState, type Work, type WorkFlags } from './model'
import type { LibraryAccess } from './sources'
import { resolveWork } from './grouping'

export interface ValueSnapshot<T> { value: T; revision: string | null }
export interface ReadingSnapshot { progress: RecordValue<LibraryProgress> | null; state: ValueSnapshot<UnitState>; reading: UnitReading }
export interface CatalogReadingState { readings: Map<number, UnitReading>; flags: Map<string, WorkFlags>; flagSnapshots: Map<string, ValueSnapshot<WorkFlags>> }
export const emptyFlags = (): WorkFlags => ({ schemaVersion: 1, wantToRead: false, favorite: false })
export function parseFlags(raw: unknown): WorkFlags {
  const flags = raw as WorkFlags | null
  if (!flags || flags.schemaVersion !== 1 || typeof flags.wantToRead !== 'boolean' || typeof flags.favorite !== 'boolean') throw new LibraryError('unknown_flags', '想读或收藏记录格式未知，未覆盖原记录')
  return { schemaVersion: 1, wantToRead: flags.wantToRead, favorite: flags.favorite }
}
export function parseUnitState(raw: unknown): UnitState {
  const state = raw as UnitState | null
  if (!state || state.schemaVersion !== 1 || typeof state.contentVersion !== 'string' || !['unread', 'reading', 'read'].includes(state.status)) throw new LibraryError('unknown_reading_state', '阅读状态格式未知，未覆盖原记录')
  return { schemaVersion: 1, contentVersion: state.contentVersion, status: state.status }
}
export function validSummary(raw: unknown): raw is ReadingSummary {
  if (!raw || typeof raw !== 'object') return false
  const summary = raw as ReadingSummary
  for (const [index, count] of [['pageIndex', 'pageCount'], ['sectionIndex', 'sectionCount']] as const) {
    if (summary[index] !== undefined && (!Number.isSafeInteger(summary[index]) || summary[index]! < 0)) return false
    if (summary[count] !== undefined && (!Number.isSafeInteger(summary[count]) || summary[count]! < 1)) return false
    if (summary[index] !== undefined && summary[count] !== undefined && summary[index]! >= summary[count]!) return false
  }
  return (summary.label === undefined || typeof summary.label === 'string' && summary.label.length <= 300)
    && (summary.percent === undefined || Number.isFinite(summary.percent) && summary.percent >= 0 && summary.percent <= 100)
}
export function validProgress(raw: unknown): raw is LibraryProgress {
  const progress = raw as LibraryProgress | null
  return !!progress && validFile(progress.file) && validLocation(progress.location) && typeof progress.title === 'string' && progress.title.length <= 4096
    && (progress.summary === undefined || validSummary(progress.summary))
}
export function readingFrom(file: FileEntry, progress: RecordValue<LibraryProgress> | null, state?: UnitState): UnitReading {
  const usable = !!progress && validProgress(progress.value) && progress.value.file.id === file.id && progress.value.file.content_version === file.content_version
  const savedState = state?.contentVersion === file.content_version ? state.status : undefined
  return { nodeId: file.id, status: savedState ?? (usable ? 'reading' : 'unread'), updatedAt: progress?.updated_at ?? 0,
    versionChanged: !!progress && progress.value.file.content_version !== file.content_version,
    location: usable ? progress!.value.location : undefined, summary: usable ? progress!.value.summary : undefined }
}
export function aggregateReading(members: readonly (UnitReading | undefined)[]): { status: ReadingStatus; percent?: number; updatedAt: number } {
  const states = members.map(member => member?.status ?? 'unread')
  const status = states.length && states.every(state => state === 'read') ? 'read' : states.some(state => state !== 'unread') ? 'reading' : 'unread'
  return { status, updatedAt: Math.max(0, ...members.map(member => member?.updatedAt ?? 0)),
    percent: status === 'read' ? 100 : members.length === 1 ? members[0]?.summary?.percent : undefined }
}
export function workFlagIds(work: Work, works: readonly Work[]): Set<string> {
  const ids = new Set([(resolveWork(works, work.id) ?? work).id])
  let added = true
  while (added) { added = false; for (const item of works) if (item.redirectTo && ids.has(item.redirectTo) && !ids.has(item.id)) { ids.add(item.id); added = true } }
  return ids
}
export function aggregateFlags(work: Work, works: readonly Work[], flags: ReadonlyMap<string, WorkFlags>): WorkFlags {
  const result = emptyFlags()
  for (const id of workFlagIds(work, works)) { const value = flags.get(id); result.favorite ||= value?.favorite ?? false; result.wantToRead ||= value?.wantToRead ?? false }
  return result
}

export class ReadingDataStore {
  constructor(private drive: Drive, private access: LibraryAccess, private saved?: (record: RecordValue<LibraryProgress>) => Promise<void> | void) {}
  async flags(workId: string, signal?: AbortSignal): Promise<ValueSnapshot<WorkFlags>> {
    if (!/^[a-f0-9]{32}$/.test(workId)) throw new LibraryError('invalid_work', '作品标识无效')
    const record = await this.drive.storage.get(`library:flags:${workId}`, { signal }); signal?.throwIfAborted()
    return { value: record ? parseFlags(record.value) : emptyFlags(), revision: record?.revision ?? null }
  }
  async setFlags(workId: string, base: ValueSnapshot<WorkFlags>, patch: Partial<Pick<WorkFlags, 'favorite' | 'wantToRead'>>, signal?: AbortSignal) {
    if (!/^[a-f0-9]{32}$/.test(workId)) throw new LibraryError('invalid_work', '作品标识无效')
    const value = parseFlags({ ...parseFlags(base.value), ...patch })
    signal?.throwIfAborted()
    const record = await this.drive.storage.set(`library:flags:${workId}`, value, base.revision, { signal }); signal?.throwIfAborted()
    return { value: parseFlags(record.value), revision: record.revision }
  }
  /** 合并作品的旧标志仍保留；切换汇总标志时对每个别名使用表单的 CAS 基线。 */
  async setWorkFlags(work: Work, works: readonly Work[], base: ReadonlyMap<string, ValueSnapshot<WorkFlags>>, patch: Partial<Pick<WorkFlags, 'favorite' | 'wantToRead'>>, signal: AbortSignal) {
    const ids = [...workFlagIds(work, works)]
    if (ids.some(id => !base.has(id))) throw new LibraryError('flags_not_loaded', '请先读取作品标志，再修改想读或收藏')
    const saved = new Map<string, ValueSnapshot<WorkFlags>>()
    try {
      for (const id of ids) {
        signal.throwIfAborted()
        const snapshot = base.get(id)!
        const unchanged = (['favorite', 'wantToRead'] as const).every(key => patch[key] === undefined || patch[key] === snapshot.value[key])
        saved.set(id, unchanged ? snapshot : await this.setFlags(id, snapshot, patch, signal))
      }
    }
    catch (error) { throw new LibraryError('flags_not_saved', '想读或收藏未全部保存，已保存项不会回滚；请重新读取后重试', { cause: error }) }
    return saved
  }
  /** 分页读取用户状态，只驻留当前索引的记录；失败整体报错，不把未读到的状态冒充未读。 */
  async loadCatalogState(units: readonly ReadingUnit[], works: readonly Work[], signal: AbortSignal, onProgress?: (records: number) => void): Promise<CatalogReadingState> {
    const identity = this.access.identity, files = new Map(units.map(unit => [String(unit.nodeId), unit.file]))
    const progress = new Map<number, RecordValue<LibraryProgress>>(), states = new Map<number, UnitState>()
    const flags = new Map<string, WorkFlags>(), flagSnapshots = new Map<string, ValueSnapshot<WorkFlags>>()
    if (!units.length) { signal.throwIfAborted(); return { readings: new Map(), flags, flagSnapshots } }
    for (const work of works) if (work.members.some(member => files.has(String(member.unitId)))) for (const id of workFlagIds(work, works)) flagSnapshots.set(id, { value: emptyFlags(), revision: null })
    const check = () => { signal.throwIfAborted(); if (identity !== this.access.identity) throw new LibraryError('source_changed', '来源已变化，旧阅读状态不会发布') }
    let count = 0
    for (const prefix of ['progress:', 'library:reading:', 'library:flags:']) {
      let cursor: string | null = null
      const cursors = new Set<string>()
      do {
        check()
        const page: Page & { records: RecordValue[] } = await this.drive.storage.list({ prefix, cursor, limit: 200 }, { signal }); check()
        for (const record of page.records) {
          count++
          if (!record.key.startsWith(prefix)) throw new LibraryError('invalid_state_page', '用户状态分页范围无效')
          const id = record.key.slice(prefix.length)
          if (prefix === 'library:flags:') {
            if (flagSnapshots.has(id)) { const value = parseFlags(record.value); flags.set(id, value); flagSnapshots.set(id, { value, revision: record.revision }) }
          } else if (files.has(id)) {
            if (prefix === 'library:reading:') states.set(Number(id), parseUnitState(record.value))
            else {
              if (!validProgress(record.value) || record.value.file.id !== Number(id)) throw new LibraryError('unknown_progress', '阅读记录格式无效，未把损坏记录当成未读')
              progress.set(Number(id), record as RecordValue<LibraryProgress>)
            }
          }
        }
        onProgress?.(count)
        if (!page.has_more) break
        if (!page.next_cursor || cursors.has(page.next_cursor)) throw new LibraryError('invalid_cursor', '用户状态分页游标无效')
        cursors.add(page.next_cursor); cursor = page.next_cursor
        await timeSlice(signal)
      } while (cursor)
    }
    check()
    return { readings: new Map(units.map(unit => [unit.nodeId, readingFrom(unit.file, progress.get(unit.nodeId) ?? null, states.get(unit.nodeId))])), flags, flagSnapshots }
  }
  async load(file: FileEntry, signal: AbortSignal): Promise<ReadingSnapshot> {
    const checked = await this.access.file(file.id, signal, file.content_version)
    const [progress, state] = await Promise.all([this.drive.storage.get<LibraryProgress>(`progress:${file.id}`, { signal }), this.drive.storage.get(`library:reading:${file.id}`, { signal })])
    signal.throwIfAborted()
    if (progress && (!validProgress(progress.value) || progress.value.file.id !== file.id)) throw new LibraryError('unknown_progress', '阅读记录格式无效，未覆盖原进度')
    const value = state ? parseUnitState(state.value) : { schemaVersion: 1 as const, contentVersion: checked.file.content_version, status: 'unread' as const }
    await this.access.file(file.id, signal, checked.file.content_version)
    return { progress, state: { value, revision: state?.revision ?? null }, reading: readingFrom(checked.file, progress, state ? value : undefined) }
  }
  async saveProgress(progress: LibraryProgress, revision: string | null, signal: AbortSignal) {
    if (!validProgress(progress)) throw new LibraryError('invalid_progress', '阅读进度或摘要无效')
    await this.access.file(progress.file.id, signal, progress.file.content_version)
    const record = await this.drive.storage.set(`progress:${progress.file.id}`, progress, revision, { signal })
    signal.throwIfAborted()
    // 最近阅读索引是可重建缓存，失败不能把已成功的进度误报成未保存。
    let historyWarning: string | undefined
    try { await this.saved?.(record) } catch { historyWarning = '进度已保存，最近阅读索引尚未更新，可重新整理历史' }
    return { record, historyWarning }
  }
  async setStatus(file: FileEntry, base: ValueSnapshot<UnitState>, status: ReadingStatus, signal: AbortSignal) {
    parseUnitState(base.value)
    await this.access.file(file.id, signal, file.content_version)
    const value = parseUnitState({ schemaVersion: 1, contentVersion: file.content_version, status })
    const record = await this.drive.storage.set(`library:reading:${file.id}`, value, base.revision, { signal }); signal.throwIfAborted()
    return { value, revision: record.revision }
  }
  markRead(file: FileEntry, base: ValueSnapshot<UnitState>, signal: AbortSignal) { return this.setStatus(file, base, 'read', signal) }
  async restart(file: FileEntry, base: ValueSnapshot<UnitState>, format: Location['format'], confirmed: boolean, signal: AbortSignal): Promise<{ state: ValueSnapshot<UnitState>; location: Location }> {
    if (!confirmed) throw new LibraryError('confirm_restart', '从头重读需要确认；原进度和书签尚未改变')
    if (!['txt', 'epub', 'pdf', 'comic'].includes(format)) throw new LibraryError('invalid_progress', '阅读格式无效')
    const state = await this.setStatus(file, base, 'reading', signal)
    // 阅读器成功打开后才保存新位置；打开失败仍保留旧 progress 和所有 bookmark。
    return { state, location: { format, index: 0 } }
  }
}
