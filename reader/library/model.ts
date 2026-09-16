/** 阅读馆的持久标识与数据契约；页图列表和正文不进入书库索引。 */
import type { FileEntry } from '../../sdk/types'
import { extension, natural } from '../io'
import type { Location, Progress } from '../state'

export type LibraryKind = 'books' | 'comics'
export type UnitFormat = 'txt' | 'epub' | 'pdf' | 'cbz' | 'zip' | 'images'
export interface ReadingUnit {
  nodeId: number
  file: FileEntry
  format: UnitFormat
  sourceIds: number[]
  firstIndexedAt: number
}
export interface BibliographicMetadata {
  title?: string
  authors?: string[]
  description?: string
  series?: string
  volume?: number
  number?: number
  language?: string
  publisher?: string
  year?: number
}
export interface WorkMember { unitId: number; role: 'main' | 'extra'; firstIndexedAt?: number }
export interface Work {
  id: string
  kind: LibraryKind
  members: WorkMember[]
  firstIndexedAt: number
  grouping: 'single' | 'automatic' | 'manual'
  seriesKey?: string
  orderConfirmed: boolean
  reviewReason?: string
  overrides: BibliographicMetadata
  /** 合并保留旧作品标识，想读和收藏可沿此指针汇总。 */
  redirectTo?: string
}
export type ReadingStatus = 'unread' | 'reading' | 'read'
export interface ReadingSummary {
  label?: string
  sectionIndex?: number
  sectionCount?: number
  pageIndex?: number
  pageCount?: number
  /** 只有阅读实现确知整本比例时才提供；本节页数不能代替全书百分比。 */
  percent?: number
}
export interface LibraryProgress extends Progress { summary?: ReadingSummary }
export interface WorkFlags { schemaVersion: 1; wantToRead: boolean; favorite: boolean }
export interface UnitState { schemaVersion: 1; contentVersion: string; status: ReadingStatus }
export interface UnitReading {
  nodeId: number
  status: ReadingStatus
  updatedAt: number
  location?: Location
  summary?: ReadingSummary
  versionChanged: boolean
}
export interface LibraryIssue { code: string; message: string; nodeId?: number }
export const LIBRARY_LIMITS = { sources: 16, batch: 200, units: 2000, directories: 10000, history: 2000 } as const
export class LibraryError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'LibraryError' }
}
export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /[\u3400-\u9fff]/.test(message) ? message : `读取失败：${message}`
}
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
export const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) >= 0
export function filePath(raw: string): string {
  if (!raw.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(raw) || new TextEncoder().encode(raw).length > 4096) throw new LibraryError('invalid_path', '文件路径无效')
  const parts = raw.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) throw new LibraryError('invalid_path', '文件路径不能包含上级跳转')
  return '/' + parts.join('/')
}
export const parentPath = (path: string) => filePath(path).split('/').slice(0, -1).join('/') || '/'
export function within(path: string, root: string) {
  try { path = filePath(path); root = filePath(root); return root === '/' || path === root || path.startsWith(`${root}/`) } catch { return false }
}
export function validFile(raw: unknown): raw is FileEntry {
  if (!raw || typeof raw !== 'object') return false
  const f = raw as FileEntry
  try {
    return validId(f.id) && typeof f.name === 'string' && f.name.length <= 4096 && typeof f.path === 'string' && filePath(f.path) === f.path
      && typeof f.content_version === 'string' && f.content_version.length > 0 && f.content_version.length <= 256
      && typeof f.is_dir === 'boolean' && Number.isSafeInteger(f.size) && f.size >= 0
      && Number.isFinite(f.created_at) && Number.isFinite(f.modified_at) && typeof f.favorite === 'boolean'
  } catch { return false }
}
export function unitFormat(file: FileEntry, kind: LibraryKind): UnitFormat | undefined {
  if (file.is_dir) return kind === 'comics' ? 'images' : undefined
  const ext = extension(file.name)
  return (kind === 'books' ? ['txt', 'epub', 'pdf'] : ['cbz', 'zip']).includes(ext) ? ext as UnitFormat : undefined
}
export function parseUnit(raw: unknown): ReadingUnit {
  const unit = raw as ReadingUnit | null
  if (!unit || !validFile(unit.file) || unit.nodeId !== unit.file.id || !Array.isArray(unit.sourceIds) || !unit.sourceIds.length
    || unit.sourceIds.length > LIBRARY_LIMITS.sources || !unit.sourceIds.every(validId) || new Set(unit.sourceIds).size !== unit.sourceIds.length
    || !Number.isFinite(unit.firstIndexedAt) || unit.firstIndexedAt < 0
    || unitFormat(unit.file, ['cbz', 'zip', 'images'].includes(unit.format) ? 'comics' : 'books') !== unit.format) throw new LibraryError('invalid_index', '阅读单元索引损坏')
  return structuredClone(unit)
}
export function uniqueUnits(units: readonly ReadingUnit[]) {
  if (new Set(units.map(unit => unit.nodeId)).size !== units.length) throw new LibraryError('invalid_index', '阅读单元标识重复')
}
export function sortRecent<T extends { updatedAt: number; nodeId: number }>(entries: T[]): T[] {
  return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.nodeId - b.nodeId)
}
export const sortTitle = (a: string, b: string) => natural(a, b)

/** 每批让出一次主线程，同时让取消不必等待下一次 SDK 请求。 */
export function timeSlice(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 0)
    signal.addEventListener('abort', stop, { once: true })
  })
}
