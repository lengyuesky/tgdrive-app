import type { FileNode, NodeReference } from '@tgdrive/page-sdk/contract'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { CinemaClient, type CinemaLibrary, type CinemaRecord } from './client'
import { isVideo, validProgress, type CinemaFavorite, type CinemaProgress } from './model'

export type { CinemaLibrary } from './client'
export const MAX_LIBRARIES = 32
export interface CinemaLibraries { libraries: CinemaLibrary[] }
export interface LibrariesSnapshot { config: CinemaLibraries; revision: string }
export type AvailableLibrary = CinemaLibrary & { path: string; authorized: true }
export interface LibraryRoots { roots: AvailableLibrary[]; unavailable: Array<{ library: CinemaLibrary; message: string }> }
export interface SavedVideo<T> { record: CinemaRecord<T>; file: FileNode; library: CinemaLibrary }

export function directoryPath(raw: string): string {
  if (!raw.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(raw) || new TextEncoder().encode(raw).length > LIMITS.MAX_DRIVE_PATH_BYTES || raw !== '/' && (raw.endsWith('/') || raw.includes('//')) || raw.split('/').some(part => part === '.' || part === '..')) throw new Error('文件夹路径无效')
  return raw
}
/** 只用于页面取材和提示，绝不代替后端和宿主按目录 ID 的授权核对。 */
export function withinDirectory(path: string, root: string): boolean {
  try { directoryPath(path); directoryPath(root); return root === '/' || path === root || path.startsWith(root + '/') } catch { return false }
}
export function requireDirectory(root: string | null, path: string) {
  if (!root || !withinDirectory(path, root)) throw new Error('目录不在当前媒体库内，请返回媒体库重新选择')
}
export function libraryForFile(file: FileNode, roots: readonly CinemaLibrary[]): CinemaLibrary | undefined {
  if (!isVideo(file)) return undefined
  return roots.filter(root => root.authorized && root.path && withinDirectory(file.path, root.path)).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0]
}
export function parseLibraries(raw: unknown): CinemaLibraries {
  const config = raw as Partial<CinemaLibraries> | null
  if (!config || !Array.isArray(config.libraries)) throw new Error('媒体库配置格式无效，请重试或恢复备份')
  if (config.libraries.length > MAX_LIBRARIES) throw new Error(`最多创建 ${MAX_LIBRARIES} 个媒体库`)
  const ids = new Set<string>(), names = new Set<string>(), directories = new Set<string>()
  const libraries = config.libraries.map((raw: unknown): CinemaLibrary => {
    const item = raw as Partial<CinemaLibrary> | null
    if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) || ids.has(item.id)) throw new Error('媒体库标识无效或重复')
    if (typeof item.name !== 'string' || /[\u0000-\u001f\u007f]/.test(item.name)) throw new Error('媒体库名称不能包含控制字符')
    const name = item.name.trim()
    if (!name || new TextEncoder().encode(name).length > 160) throw new Error('媒体库名称需为 1–160 字节')
    if (names.has(name)) throw new Error('已有同名媒体库，请使用不同名称')
    if (typeof item.root_id !== 'string' || !/^[1-9][0-9]*$/.test(item.root_id) || BigInt(item.root_id) > BigInt(LIMITS.MAX_NODE_ID)) throw new Error('请先选择有效的文件夹')
    if (directories.has(item.root_id)) throw new Error('此文件夹已经绑定媒体库')
    if (item.kind !== 'movie' && item.kind !== 'tv') throw new Error('媒体库类型无效')
    if (item.path !== null && typeof item.path !== 'string') throw new Error('媒体库路径无效')
    const path = item.path === null ? null : directoryPath(item.path)
    ids.add(item.id); names.add(name); directories.add(item.root_id)
    return { id: item.id, name, kind: item.kind, root_id: item.root_id, path, authorized: item.authorized === true }
  })
  return { libraries }
}
export function newLibraryId() { return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('') }

/** SQLite 配置与账号共用一个修订；表单保留其编辑时的基线，冲突必须再次确认。 */
export class LibrariesStore {
  constructor(private cinema: CinemaClient) {}
  async load(signal?: AbortSignal): Promise<LibrariesSnapshot> {
    const config = await this.cinema.configuration(signal)
    signal?.throwIfAborted()
    return { config: parseLibraries(config), revision: config.revision }
  }
  async save(config: CinemaLibraries, revision: string, signal?: AbortSignal): Promise<LibrariesSnapshot> {
    const parsed = parseLibraries(config)
    const saved = await this.cinema.libraries(revision, parsed.libraries.map(({ id, name, kind, root_id }) => ({ id, name, kind, root_id })), signal)
    signal?.throwIfAborted()
    return { config: parseLibraries(saved), revision: saved.revision }
  }
}

/** 页面只取一页业务数据；索引、记录验证和同目录资料选择统一归自己的后端。 */
export class LibraryAccess {
  constructor(private cinema: CinemaClient) {}
  async stat(reference: NodeReference, signal: AbortSignal) { const file = await this.cinema.stat(reference, signal); signal.throwIfAborted(); return file }
  async directory(reference: NodeReference, signal: AbortSignal) {
    const file = await this.stat(reference, signal)
    if (file.kind !== 'directory') throw new Error('绑定的文件夹不可用，请重新选择')
    return { root_id: file.id, path: directoryPath(file.path), authorized: true }
  }
  async roots(config: CinemaLibraries, signal: AbortSignal, requiredId?: string): Promise<LibraryRoots> {
    signal.throwIfAborted()
    const definitions = requiredId ? config.libraries.filter(item => item.id === requiredId) : config.libraries
    if (requiredId && !definitions.length) throw new Error('此媒体库已删除，请返回媒体库列表')
    return { roots: definitions.filter((item): item is AvailableLibrary => item.authorized && typeof item.path === 'string'), unavailable: definitions.filter(item => !item.authorized || !item.path).map(library => ({ library, message: '媒体库文件夹未授权或不可用，请重新选择' })) }
  }
  async video(config: CinemaLibraries, id: string, signal: AbortSignal, requiredId?: string): Promise<{ file: FileNode; library: CinemaLibrary }> {
    if (!config.libraries.length) throw new Error('请先创建媒体库，再打开其中的视频')
    const { roots } = await this.roots(config, signal, requiredId)
    if (!roots.length) throw new Error('媒体库文件夹不可用，请重新选择文件夹')
    const file = await this.stat({ by: 'id', id }, signal), library = libraryForFile(file, roots)
    if (!library) throw new Error('视频已不在当前媒体库范围内，请刷新或重新配置媒体库')
    return { file, library }
  }
  async search(root: CinemaLibrary | null, params: { q?: string; extensions?: string[]; cursor?: string | null }, signal: AbortSignal) {
    if (!root) throw new Error('请先进入一个媒体库')
    const page = await this.cinema.catalog({ ...params, ancestor: root.id, raw_files: true, limit: 48 }, signal)
    signal.throwIfAborted(); return page
  }
  async list(root: CinemaLibrary | null, path: string, cursor: string | null, signal: AbortSignal) {
    requireDirectory(root?.path ?? null, path)
    const page = await this.cinema.directory(path, root!.id, cursor, signal)
    signal.throwIfAborted(); return page
  }
  async savedPage<T extends CinemaFavorite | CinemaProgress>(roots: readonly CinemaLibrary[], prefix: 'progress:' | 'favorite:', cursor: string | null, limit: number, signal: AbortSignal) {
    if (!roots.length) return { entries: [] as SavedVideo<T>[], next_cursor: null, failed: 0, total: 0 }
    const page = await this.cinema.records<T>(prefix, roots.length === 1 ? roots[0].id : '', cursor, limit, signal)
    signal.throwIfAborted()
    const entries = page.records.flatMap(record => {
      const file = record.value.file, library = libraryForFile(file, roots)
      if (!library || prefix === 'progress:' && !validProgress(record.value)) return []
      return [{ record, file, library }]
    })
    return { entries, next_cursor: page.next_cursor, total: page.total, failed: 0 }
  }
}
