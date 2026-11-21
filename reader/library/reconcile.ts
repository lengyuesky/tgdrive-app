/** 弱一致扫描完成后消费持久变更游标；SSE 只提示核对，不作为删除或保存回执。 */
import type { FileNode, NodeId } from '@tgdrive/page-sdk'
import { isImage } from '../io'
import { discoverPage, discoveryFilter, type DiscoveryCursor } from './discovery'
import { imageExtensions } from '../io'
import { LIBRARY_LIMITS, LibraryError, unitFormat, within, type LibraryScope, type ReadingUnit } from './model'
import type { LibraryAccess, SourceRoots } from './sources'

const hidden = (file: FileNode) => file.path.split('/').some(part => part.startsWith('.'))
export async function reconcileUnits(access: LibraryAccess, roots: SourceRoots, kind: LibraryScope, previous: readonly ReadingUnit[], cursor: string, signal: AbortSignal): Promise<{ units: ReadingUnit[]; cursor: string }> {
  const units = new Map(previous.map(unit => [unit.nodeId, unit]))
  const firstIndexed = new Map(previous.map(unit => [unit.nodeId, unit.firstIndexedAt]))
  const sources = (file: FileNode) => roots.roots.filter(root => within(file.path, root.file.path)).map(root => root.source.nodeId)
  const add = (file: FileNode) => {
    const format = unitFormat(file, kind), sourceIds = sources(file)
    if (!format || !sourceIds.length || hidden(file)) { units.delete(file.id); return }
    units.set(file.id, { nodeId: file.id, file, format, sourceIds, firstIndexedAt: firstIndexed.get(file.id) ?? Date.now() })
  }
  const directory = async (id: NodeId) => {
    let file: FileNode
    try { file = await access.host.stat({ by: 'id', id }, { signal }) }
    catch (error) { if (['not_found', 'scope_denied'].includes((error as { code?: string }).code ?? '')) { units.delete(id); return }; throw error }
    if (kind === 'books' || file.kind !== 'directory' || !sources(file).length || hidden(file)) { units.delete(id); return }
    const page = await access.host.query({ roots: [id], recursive: false, filter: discoveryFilter(imageExtensions), sort: 'id', order: 'asc', limit: 1, cursor: null }, { signal })
    if (page.items.length) add(file)
    else units.delete(id)
  }
  const subtree = async (root: FileNode) => {
    if (root.kind !== 'directory' || !sources(root).length) return
    let position: DiscoveryCursor | null = null
    do {
      const page = await discoverPage(access.host, { roots: [root.id], kind, sort: 'name', limit: LIBRARY_LIMITS.batch, cursor: position }, signal)
      for (const file of page.items) add(file)
      position = page.next_cursor
    } while (position)
  }
  let checkpoint = cursor, refreshImageDirectories = false
  const affectedDirectories = new Set<NodeId>(), cursors = new Set<string>()
  for (;;) {
    const page = await access.host.changes({ cursor: checkpoint, limit: LIBRARY_LIMITS.batch }, { signal })
    signal.throwIfAborted()
    if (page.reset_required) throw new LibraryError('cursor_expired', '变更日志需要重置，请完整核对书库')
    for (const change of page.changes) {
      if (change.type === 'removed') {
        const known = units.has(change.id)
        units.delete(change.id)
        if (!known && kind !== 'books') refreshImageDirectories = true
      } else if (change.type === 'upsert') {
        const file = change.node
        if (file.kind === 'directory') affectedDirectories.add(file.id)
        else {
          add(file)
          // upsert 不携带旧父目录或旧后缀；移动图片及改成非图片时也要核对目录命中索引。
          if (kind !== 'books') refreshImageDirectories = true
          if (kind !== 'books' && isImage(file.name) && file.parent_id) affectedDirectories.add(file.parent_id)
        }
      } else if (change.type === 'subtree_invalidated') {
        const oldPath = change.previous_path ?? units.get(change.id)?.file.path
        for (const [id, unit] of units) if (id === change.id || oldPath && within(unit.file.path, oldPath)) units.delete(id)
        if (change.current) await subtree(change.current)
      }
    }
    checkpoint = page.next_cursor
    if (!page.has_more) break
    if (cursors.has(checkpoint) || checkpoint === cursor) throw new LibraryError('invalid_cursor', '变更检查点没有推进')
    cursors.add(checkpoint)
  }
  for (const id of affectedDirectories) await directory(id)
  if (refreshImageDirectories) {
    // removed 不带未授权路径；未收录的图片删除时只重查图片目录索引，不遍历原文件树。
    const found = new Set<NodeId>()
    let position: DiscoveryCursor | null = null
    do {
      const page = await discoverPage(access.host, { roots: roots.roots.map(root => root.file.id), kind: 'comics', format: 'images', sort: 'name', limit: LIBRARY_LIMITS.batch, cursor: position }, signal)
      for (const file of page.items) { found.add(file.id); add(file) }
      position = page.next_cursor
    } while (position)
    for (const [id, unit] of units) if (unit.format === 'images' && !found.has(id)) units.delete(id)
  }
  return { units: [...units.values()], cursor: checkpoint }
}
