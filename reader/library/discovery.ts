/** 阅读文件与直属图片目录两路键集归并；只驻留两页，不枚举全盘文件树。 */
import type { Cursor, DirectorySort, FileFilter, FileNode, FilePage, HostClient, NodeId } from '@tgdrive/page-sdk'
import { compareNodeIds } from '../files'
import { imageExtensions } from '../io'
import { LIBRARY_LIMITS, LibraryError, scopeFormats, type LibraryScope, type UnitFormat } from './model'

export interface DiscoveryMark { cursor: Cursor | null; skipped: number; done: boolean }
/** 此对象是应用自己的双路分页位置，不解码或改写任何宿主游标。 */
export interface DiscoveryCursor { schemaVersion: 1; files: DiscoveryMark; directories: DiscoveryMark; scanCursor: Cursor; scopeRevision: string }
export interface DiscoveryQuery { roots: NodeId[]; kind: LibraryScope; q?: string; format?: UnitFormat; sort: DirectorySort; limit: number; cursor?: DiscoveryCursor | null }
export interface DiscoveryPage { items: FileNode[]; next_cursor: DiscoveryCursor | null; scan_cursor: Cursor; scope_revision: string }
export const emptyMark = (): DiscoveryMark => ({ cursor: null, skipped: 0, done: false })
const fold = (name: string) => name.replace(/[A-Z]/g, letter => letter.toLowerCase())
function binary(left: string, right: string): number {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!
  return a.length - b.length
}
export function discoveryOrder(sort: DirectorySort, left: FileNode, right: FileNode): number {
  if (sort === 'name') return binary(fold(left.name), fold(right.name)) || binary(left.name, right.name) || compareNodeIds(left.id, right.id)
  if (sort === 'id') return compareNodeIds(left.id, right.id)
  return left[sort] - right[sort] || compareNodeIds(left.id, right.id)
}
export function discoveryFilter(extensions: string[], name?: string): FileFilter { return { kind: 'file', extensions, name_contains: name || undefined, include_hidden: false } }
export function validDiscoveryCursor(raw: unknown): raw is DiscoveryCursor {
  const value = raw as DiscoveryCursor | null
  const mark = (raw: DiscoveryMark) => raw && (raw.cursor === null || typeof raw.cursor === 'string' && raw.cursor.length <= 4096) && Number.isSafeInteger(raw.skipped) && raw.skipped >= 0 && raw.skipped <= LIBRARY_LIMITS.batch && typeof raw.done === 'boolean'
  return !!value && value.schemaVersion === 1 && mark(value.files) && mark(value.directories) && typeof value.scanCursor === 'string' && typeof value.scopeRevision === 'string'
}
class Stream {
  private items: FileNode[] = []
  private loaded = false
  private next: Cursor | null = null
  constructor(readonly mark: DiscoveryMark, private fetchPage: (cursor: Cursor | null) => Promise<FilePage>, private observe: (page: FilePage) => void) {}
  async peek(): Promise<FileNode | undefined> {
    while (!this.mark.done) {
      if (!this.loaded) {
        const page = await this.fetchPage(this.mark.cursor)
        this.observe(page)
        if (page.items.length > LIBRARY_LIMITS.batch || new Set(page.items.map(file => file.id)).size !== page.items.length) throw new LibraryError('invalid_page', '宿主分页包含重复节点或超出本次请求上限')
        if (this.mark.skipped > page.items.length) throw new LibraryError('page_changed', '分页位置已变化，请从首页刷新')
        if (page.next_cursor && page.next_cursor === this.mark.cursor) throw new LibraryError('invalid_cursor', '宿主游标没有推进')
        this.items = page.items; this.next = page.next_cursor; this.loaded = true
      }
      const item = this.items[this.mark.skipped]
      if (item) return item
      this.mark.cursor = this.next; this.mark.skipped = 0; this.mark.done = this.next === null; this.loaded = false; this.items = []
    }
  }
  take() { this.mark.skipped++ }
}
export async function discoverPage(host: HostClient, query: DiscoveryQuery, signal: AbortSignal): Promise<DiscoveryPage> {
  signal.throwIfAborted()
  const formats = query.format ? [query.format] : scopeFormats(query.kind)
  const extensions = formats.filter(format => format !== 'images')
  const hasDirectories = formats.includes('images')
  const previous = query.cursor
  if (previous && !validDiscoveryCursor(previous)) throw new LibraryError('invalid_cursor', '应用分页位置无效')
  const files = structuredClone(previous?.files ?? emptyMark()), directories = structuredClone(previous?.directories ?? emptyMark())
  if (!extensions.length) files.done = true
  if (!hasDirectories) directories.done = true
  let scanCursor = previous?.scanCursor ?? '', scopeRevision = previous?.scopeRevision ?? ''
  const observe = (page: FilePage) => {
    signal.throwIfAborted()
    if (!scanCursor) scanCursor = page.scan_cursor
    if (scopeRevision && page.scope_revision !== scopeRevision) throw new LibraryError('scope_changed', '目录授权已变化，请重新加载')
    scopeRevision = page.scope_revision
  }
  const fileStream = new Stream(files, cursor => host.query({ roots: query.roots, recursive: true, filter: discoveryFilter(extensions, query.q), sort: query.sort, order: 'asc', limit: LIBRARY_LIMITS.batch, cursor }, { signal }), observe)
  const directoryStream = new Stream(directories, cursor => host.directoriesWithFiles({ roots: query.roots, file_filter: discoveryFilter(imageExtensions), directory_name_contains: query.q || undefined, sort: query.sort, order: 'asc', limit: LIBRARY_LIMITS.batch, cursor }, { signal }), observe)
  const items: FileNode[] = [], seen = new Set<NodeId>()
  for (;;) {
    // 第一路先取得 scan_cursor，第二路和所有续页都在此检查点之后核对变化。
    const left = await fileStream.peek(), right = await directoryStream.peek()
    if (!left && !right || items.length >= query.limit) break
    const stream = !right || left && discoveryOrder(query.sort, left, right) <= 0 ? fileStream : directoryStream
    const item = stream === fileStream ? left! : right!
    stream.take()
    if (!seen.has(item.id)) { seen.add(item.id); items.push(item) }
  }
  if (!scanCursor) {
    const checkpoint = await host.changes({ cursor: null, limit: LIBRARY_LIMITS.batch }, { signal })
    scanCursor = checkpoint.next_cursor; scopeRevision = checkpoint.scope_revision
  }
  return { items, next_cursor: files.done && directories.done ? null : { schemaVersion: 1, files, directories, scanCursor, scopeRevision }, scan_cursor: scanCursor, scope_revision: scopeRevision }
}
