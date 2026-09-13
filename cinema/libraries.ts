import type { Drive, FileEntry, Page, RecordValue, Search } from '../sdk/types'
import { ReadScheduler, isAbort } from './io'
import { isVideo, validFile, validProgress, type CinemaFavorite, type CinemaProgress } from './model'

export const LIBRARIES_KEY = 'media-libraries'
export const MAX_LIBRARIES = 32
export interface CinemaLibrary { id: string; name: string; directoryId: number; directoryPath: string }
export interface CinemaLibraries { schemaVersion: 1; libraries: CinemaLibrary[] }
export interface LibrariesSnapshot { config: CinemaLibraries; revision: string | null }
export interface LibraryRoots { roots: CinemaLibrary[]; unavailable: { library: CinemaLibrary; message: string }[] }
export interface SavedVideo<T> { record: RecordValue<T>; file: FileEntry; library: CinemaLibrary }

export function directoryPath(raw: string): string {
  if (!raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw) || new TextEncoder().encode(raw).length > 4096) throw new Error('文件夹路径无效')
  const parts = raw.split('/').filter(part => part && part !== '.')
  if (parts.includes('..')) throw new Error('文件夹路径不能包含上级跳转')
  return '/' + parts.join('/')
}
export function withinDirectory(path: string, root: string): boolean {
  try {
    path = directoryPath(path); root = directoryPath(root)
    return root === '/' || path === root || path.startsWith(root + '/')
  } catch { return false }
}
export function requireDirectory(root: string | null, path: string) {
  if (!root || !withinDirectory(path, root)) throw new Error('目录不在当前媒体库内，请返回媒体库重新选择')
}
export function libraryForFile(file: FileEntry, roots: readonly CinemaLibrary[]): CinemaLibrary | undefined {
  if (!validFile(file) || !isVideo(file)) return undefined
  return roots.filter(root => withinDirectory(file.path, root.directoryPath)).sort((a, b) => b.directoryPath.length - a.directoryPath.length)[0]
}

/** 配置损坏必须报错；只有确实不存在的记录才代表尚未建库。 */
export function parseLibraries(raw: unknown): CinemaLibraries {
  const config = raw as Partial<CinemaLibraries> | null
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.libraries)) throw new Error('媒体库配置格式无效，请重试或恢复备份')
  if (config.libraries.length > MAX_LIBRARIES) throw new Error(`最多创建 ${MAX_LIBRARIES} 个媒体库`)
  const ids = new Set<string>(), names = new Set<string>(), directories = new Set<number>()
  const libraries = config.libraries.map((raw: unknown): CinemaLibrary => {
    const item = raw as Partial<CinemaLibrary> | null
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new Error('媒体库标识无效或重复')
    if (typeof item.name !== 'string' || /[\u0000-\u001f\u007f]/.test(item.name)) throw new Error('媒体库名称不能包含控制字符')
    const name = item.name.trim()
    if (!name || [...name].length > 50) throw new Error('媒体库名称需为 1–50 个字符')
    if (names.has(name)) throw new Error('已有同名媒体库，请使用不同名称')
    if (!Number.isSafeInteger(item.directoryId) || item.directoryId! <= 0 || typeof item.directoryPath !== 'string') throw new Error('请先选择有效的文件夹')
    if (directories.has(item.directoryId!)) throw new Error('此文件夹已经绑定媒体库')
    ids.add(item.id); names.add(name); directories.add(item.directoryId!)
    return { id: item.id, name, directoryId: item.directoryId!, directoryPath: directoryPath(item.directoryPath) }
  })
  const result: CinemaLibraries = { schemaVersion: 1, libraries }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32 * 1024) throw new Error('媒体库配置超过 32 KiB，请缩短名称、路径或减少媒体库')
  return result
}
export function newLibraryId() {
  // getRandomValues 在非 HTTPS 的自托管网盘中也可用，不依赖 randomUUID。
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 快照显式携带修订号，表单不会把并发读取的新版本当作自己的编辑基线。 */
export class LibrariesStore {
  constructor(private drive: Drive) {}
  async load(signal?: AbortSignal): Promise<LibrariesSnapshot> {
    signal?.throwIfAborted()
    const record = await this.drive.storage.get<unknown>(LIBRARIES_KEY, { signal })
    signal?.throwIfAborted()
    return { config: record ? parseLibraries(record.value) : { schemaVersion: 1, libraries: [] }, revision: record?.revision ?? null }
  }
  async save(config: CinemaLibraries, revision: string | null, signal?: AbortSignal): Promise<LibrariesSnapshot> {
    const value = parseLibraries(config)
    signal?.throwIfAborted()
    const saved = await this.drive.storage.set(LIBRARIES_KEY, value, revision, { signal })
    signal?.throwIfAborted()
    return { config: parseLibraries(saved.value), revision: saved.revision }
  }
}

/** 元数据查询也共用有界调度；入口页不调用此模块，不会为库卡片遍历目录。 */
export class LibraryAccess {
  constructor(private drive: Drive, private scheduler: ReadScheduler) {}
  async stat(ref: { id: number } | { path: string }, signal: AbortSignal) {
    const file = await this.scheduler.run(() => this.drive.files.stat(ref, { signal }), signal)
    signal.throwIfAborted()
    return file
  }
  async directory(ref: { id: number } | { path: string }, signal: AbortSignal) {
    const file = await this.stat(ref, signal)
    if (!file.is_dir || !Number.isSafeInteger(file.id) || file.id <= 0) throw new Error('绑定的文件夹不可用，请重新选择')
    return { directoryId: file.id, directoryPath: directoryPath(file.path) }
  }
  async roots(config: CinemaLibraries, signal: AbortSignal, requiredId?: string): Promise<LibraryRoots> {
    const definitions = requiredId ? config.libraries.filter(item => item.id === requiredId) : config.libraries
    if (requiredId && !definitions.length) throw new Error('此媒体库已删除，请返回媒体库列表')
    const resolved = await Promise.all(definitions.map(async library => {
      try { return { library: { ...library, ...await this.directory({ id: library.directoryId }, signal) }, message: '' } }
      catch (error) {
        if (isAbort(error) || signal.aborted) throw error
        return { library, message: error instanceof Error ? error.message : '无法读取文件夹' }
      }
    }))
    signal.throwIfAborted()
    return { roots: resolved.filter(item => !item.message).map(item => item.library), unavailable: resolved.filter(item => item.message) }
  }
  async video(config: CinemaLibraries, id: number, signal: AbortSignal, requiredId?: string): Promise<{ file: FileEntry; library: CinemaLibrary }> {
    if (!config.libraries.length) throw new Error('请先创建媒体库，再打开其中的视频')
    const { roots, unavailable } = await this.roots(config, signal, requiredId)
    if (!roots.length) throw new Error(unavailable.length ? '媒体库文件夹不可用，请重新选择文件夹' : '没有可用的媒体库')
    const file = await this.stat({ id }, signal), library = libraryForFile(file, roots)
    if (!library) throw new Error('视频已不在当前媒体库范围内，请刷新或重新配置媒体库')
    return { file, library }
  }
  async search(root: CinemaLibrary | null, params: Pick<Search, 'q' | 'extensions' | 'cursor'>, signal: AbortSignal) {
    if (!root) throw new Error('请先进入一个媒体库')
    const under = directoryPath(root.directoryPath)
    const page = await this.scheduler.run(() => this.drive.files.searchPage({ ...params, under, kind: 'file', limit: 200 }, { signal }), signal)
    signal.throwIfAborted()
    return { ...page, results: page.results.filter(file => isVideo(file) && withinDirectory(file.path, under)) }
  }
  async list(root: CinemaLibrary | null, path: string, cursor: string | null, signal: AbortSignal) {
    requireDirectory(root?.directoryPath ?? null, path)
    const page = await this.scheduler.run(() => this.drive.files.list({ path: directoryPath(path), cursor, limit: 200 }, { signal }), signal)
    signal.throwIfAborted()
    return { ...page, entries: page.entries.filter(file => withinDirectory(file.path, root!.directoryPath) && (file.is_dir || isVideo(file))) }
  }
  async savedPage<T extends CinemaFavorite | CinemaProgress>(roots: readonly CinemaLibrary[], prefix: 'progress:' | 'favorite:', cursor: string | null, limit: number, signal: AbortSignal): Promise<Page & { entries: SavedVideo<T>[]; failed: number }> {
    if (!roots.length) return { entries: [], failed: 0, next_cursor: null, has_more: false }
    const page = await this.drive.storage.list<T>({ prefix, cursor, limit }, { signal })
    signal.throwIfAborted()
    let failed = 0
    const results = await Promise.all(page.records.map(async record => {
      if (!validFile(record.value?.file) || prefix === 'progress:' && !validProgress(record.value) || record.key !== `${prefix}${record.value.file.id}`) return null
      try {
        const file = await this.stat({ id: record.value.file.id }, signal), library = libraryForFile(file, roots)
        return library ? { record, file, library } : null
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw error
        if ((error as { code?: string }).code !== 'not_found') failed++
        return null
      }
    }))
    signal.throwIfAborted()
    return { entries: results.filter((entry): entry is SavedVideo<T> => entry !== null), failed, next_cursor: page.next_cursor, has_more: page.has_more }
  }
}
