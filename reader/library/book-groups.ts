/** 图书手动分类独立于书库缓存，以稳定节点标识保存归属。 */
import type { Drive } from '../../sdk/types'
import { LibraryError, newId, validId } from './model'
import { ShardedStore, type ShardedSnapshot } from './snapshot'

export interface BookGroup { id: string; name: string; nodeIds: number[] }
interface GroupsMeta { schemaVersion: 1 }
type GroupRow = { type: 'group'; id: string; name: string } | { type: 'member'; nodeId: number; groupId: string }
export const BOOK_GROUPS_KEY = 'library:book-groups'
export function groupName(value: string): string {
  const name = value.trim()
  if (!name || [...name].length > 40) throw new LibraryError('invalid_group', '分组名称须为 1～40 字')
  return name
}
function parseGroup(raw: unknown): BookGroup {
  const group = raw as BookGroup | null
  if (!group || typeof group.id !== 'string' || !/^[a-f0-9]{32}$/.test(group.id)
    || typeof group.name !== 'string' || groupName(group.name) !== group.name
    || !Array.isArray(group.nodeIds) || !group.nodeIds.every(validId)) throw new LibraryError('invalid_group', '分组记录损坏，未覆盖原数据')
  return structuredClone(group)
}
function validate(rows: BookGroup[]) {
  const ids = new Set<string>(), names = new Set<string>(), nodes = new Set<number>()
  for (const group of rows) {
    if (ids.has(group.id) || names.has(group.name)) throw new LibraryError('duplicate_group', '分组名称或标识重复')
    ids.add(group.id); names.add(group.name)
    for (const id of group.nodeIds) {
      if (nodes.has(id)) throw new LibraryError('duplicate_membership', '每本书只能属于一个分组')
      nodes.add(id)
    }
  }
  return rows
}
function parseRow(raw: unknown): GroupRow {
  const row = raw as GroupRow | null
  if (row?.type === 'group') {
    const group = parseGroup({ ...row, nodeIds: [] })
    return { type: 'group', id: group.id, name: group.name }
  }
  if (row?.type === 'member' && validId(row.nodeId) && typeof row.groupId === 'string' && /^[a-f0-9]{32}$/.test(row.groupId)) return { type: 'member', nodeId: row.nodeId, groupId: row.groupId }
  throw new LibraryError('invalid_group', '分组记录损坏，未覆盖原数据')
}
function decode(rows: GroupRow[]): BookGroup[] {
  const groups = rows.filter((row): row is Extract<GroupRow, { type: 'group' }> => row.type === 'group').map(row => ({ id: row.id, name: row.name, nodeIds: [] as number[] }))
  const byId = new Map(groups.map(group => [group.id, group]))
  for (const row of rows) if (row.type === 'member') {
    const group = byId.get(row.groupId)
    if (!group) throw new LibraryError('invalid_group', '书籍所属分组不存在，未覆盖原数据')
    group.nodeIds.push(row.nodeId)
  }
  return validate(groups)
}
export class BookGroupsStore {
  private store: ShardedStore<GroupRow, GroupsMeta>
  private snapshot?: ShardedSnapshot<BookGroup, GroupsMeta>
  private available = false
  constructor(private drive: Drive) {
    this.store = new ShardedStore(drive, BOOK_GROUPS_KEY, parseRow, raw => {
      if (!raw || (raw as GroupsMeta).schemaVersion !== 1) throw new LibraryError('invalid_groups', '分组版本未知，未覆盖原数据')
      return { schemaVersion: 1 }
    }, () => ({ schemaVersion: 1 }), Infinity, 24 * 1024)
  }
  get ready() { return this.available }
  get groups(): BookGroup[] { return structuredClone(this.snapshot?.rows ?? []) }
  groupFor(nodeId: number) { return this.snapshot?.rows.find(group => group.nodeIds.includes(nodeId))?.id }
  matches(nodeId: number, groupId?: string) {
    if (groupId === undefined) return true
    this.requireReady()
    return groupId === '' ? this.groupFor(nodeId) === undefined : this.groupFor(nodeId) === groupId
  }
  private requireReady() {
    if (!this.available || !this.snapshot) throw new LibraryError('groups_unavailable', '分组读取失败，请重新加载后再试')
    return this.snapshot
  }
  async isCurrent(signal?: AbortSignal) {
    const record = await this.drive.storage.get(BOOK_GROUPS_KEY, { signal })
    return this.available && (record?.revision ?? null) === this.snapshot?.revision
  }
  async load(signal?: AbortSignal) {
    this.available = false
    const snapshot = await this.store.load(signal)
    this.snapshot = { ...snapshot, rows: decode(snapshot.rows) }; this.available = true
    return this.groups
  }
  private async save(rows: BookGroup[], signal?: AbortSignal) {
    const base = this.requireReady()
    validate(rows)
    // 归属逐条分片，避免大分组超过宿主单条记录的 32 KiB 上限。
    const encoded: GroupRow[] = rows.flatMap(group => [
      { type: 'group' as const, id: group.id, name: group.name },
      ...group.nodeIds.map(nodeId => ({ type: 'member' as const, nodeId, groupId: group.id })),
    ])
    const saved = await this.store.save({ ...base, rows: encoded }, signal)
    this.snapshot = { ...saved, rows: decode(saved.rows) }
  }
  async create(name: string, signal?: AbortSignal) {
    const base = this.requireReady(), id = newId()
    await this.save([...base.rows, { id, name: groupName(name), nodeIds: [] }], signal)
    return id
  }
  async rename(id: string, name: string, signal?: AbortSignal) {
    const base = this.requireReady()
    if (!base.rows.some(group => group.id === id)) throw new LibraryError('missing_group', '分组已不存在')
    await this.save(base.rows.map(group => group.id === id ? { ...group, name: groupName(name) } : group), signal)
  }
  async remove(id: string, signal?: AbortSignal) {
    await this.save(this.requireReady().rows.filter(group => group.id !== id), signal)
  }
  async assign(nodeIds: readonly number[], groupId?: string, signal?: AbortSignal) {
    const base = this.requireReady(), selected = new Set(nodeIds)
    if (!nodeIds.every(validId)) throw new LibraryError('invalid_node', '书籍标识无效')
    if (groupId !== undefined && !base.rows.some(group => group.id === groupId)) throw new LibraryError('missing_group', '分组已不存在')
    await this.save(base.rows.map(group => ({ ...group, nodeIds: [...group.nodeIds.filter(id => !selected.has(id)), ...(group.id === groupId ? selected : [])] })), signal)
  }
}
