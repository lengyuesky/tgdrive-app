/** 仅用于 Vitest 的内存 SDK；键序分页故意不按更新时间排序。 */
import { vi } from 'vitest'
import type { CallOptions, Drive, FileEntry, RecordValue, Search } from '../../sdk/types'
import { parentPath, unitFormat, within, type ReadingUnit } from './model'
import type { SourcesSnapshot } from './sources'

export const signal = () => new AbortController().signal
export const file = (id: number, path: string, is_dir = false, content_version = 'v1', size = 0): FileEntry => ({ id, path, name: path.split('/').pop() || '根目录', is_dir, content_version, size, created_at: 1, modified_at: 1, favorite: false })
export function unit(entry: FileEntry, sources = [1], firstIndexedAt = 10): ReadingUnit {
  return { nodeId: entry.id, file: entry, format: unitFormat(entry, 'books') ?? unitFormat(entry, 'comics')!, sourceIds: sources, firstIndexedAt }
}
export function sources(...directories: FileEntry[]): SourcesSnapshot {
  return { revision: 'sources-1', config: { schemaVersion: 1, sources: directories.map(dir => ({ nodeId: dir.id, path: dir.path, contentVersion: dir.content_version, addedAt: 1, rootConfirmed: dir.path === '/' })) } }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function memoryDrive(initial: FileEntry[] = [], legacy: Record<string, string | boolean | number> = {}) {
  const nodes = new Map(initial.map(entry => [entry.id, structuredClone(entry)])), records = new Map<string, RecordValue>(), data = new Map<number, Uint8Array>()
  let revision = 0, clock = 1
  const get = vi.fn(async (key: string, options?: CallOptions) => { options?.signal?.throwIfAborted(); return structuredClone(records.get(key) ?? null) })
  const set = vi.fn(async (key: string, value: unknown, expected: string | null = null, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    if ((records.get(key)?.revision ?? null) !== expected) throw Object.assign(new Error('存储冲突'), { code: 'storage_conflict' })
    const record = { key, value: structuredClone(value), revision: String(++revision), updated_at: ++clock }
    records.set(key, record)
    return structuredClone(record)
  })
  const remove = vi.fn(async (key: string, expected: string, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    if (records.get(key)?.revision !== expected) throw Object.assign(new Error('存储冲突'), { code: 'storage_conflict' })
    records.delete(key); return { ok: true as const }
  })
  const storageList = vi.fn(async ({ prefix = '', cursor = null, limit = 200 }: { prefix?: string; cursor?: string | null; limit?: number } = {}, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    const keys = [...records.keys()].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort(), selected = keys.slice(0, limit)
    return { records: selected.map(key => structuredClone(records.get(key)!)), has_more: keys.length > selected.length, next_cursor: keys.length > selected.length ? selected.at(-1)! : null }
  })
  const stat = vi.fn(async (ref: { id: number; content_version?: string } | { path: string }, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    const entry = 'id' in ref ? nodes.get(ref.id) : [...nodes.values()].find(entry => entry.path === ref.path)
    if (!entry) throw Object.assign(new Error('节点不存在'), { code: 'not_found' })
    if ('content_version' in ref && ref.content_version !== undefined && entry.content_version !== ref.content_version) throw Object.assign(new Error('版本变化'), { code: 'version_changed' })
    return structuredClone(entry)
  })
  const list = vi.fn(async ({ path, cursor = null, limit = 200 }: { path: string; cursor?: string | null; limit?: number }, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    const entries = [...nodes.values()].filter(entry => entry.path !== path && parentPath(entry.path) === path).sort((a, b) => a.id - b.id)
    const start = Number(cursor ?? 0), selected = entries.slice(start, start + limit), has_more = start + selected.length < entries.length
    return { path, entries: structuredClone(selected), has_more, next_cursor: has_more ? String(start + selected.length) : null }
  })
  const searchPage = vi.fn(async ({ under = '/', q = '', extensions, kind = 'all', cursor = null, limit = 200 }: Search = {}, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    const results = [...nodes.values()].filter(entry => within(entry.path, under) && entry.path !== under && entry.name.includes(q) && (kind === 'all' || entry.is_dir === (kind === 'dir')) && (!extensions || entry.is_dir || extensions.includes(entry.name.split('.').pop()!)))
    const start = Number(cursor ?? 0), selected = results.slice(start, start + limit), has_more = start + selected.length < results.length
    return { results: structuredClone(selected), has_more, next_cursor: has_more ? String(start + selected.length) : null }
  })
  const readRange = vi.fn(async (ref: { id: number; content_version: string }, offset: number, length: number, options?: CallOptions) => {
    options?.signal?.throwIfAborted()
    if (nodes.get(ref.id)?.content_version !== ref.content_version) throw new Error('内容版本变化')
    const bytes = data.get(ref.id)
    if (!bytes || length > 1024 * 1024 || offset < 0 || offset + length > bytes.length) throw new Error('Range 越界')
    return new Uint8Array(bytes.subarray(offset, offset + length))
  })
  const drive = { files: { stat, list, searchPage, readRange }, storage: { get, set, delete: remove, list: storageList },
    settings: { get: vi.fn(async () => structuredClone(legacy)), patch: vi.fn(), open: vi.fn() },
    assets: { read: vi.fn(async () => { throw new Error('未提供合成 PDF 字体资源') }) }, media: { url: vi.fn() },
  } as unknown as Drive
  const seed = (key: string, value: unknown, updated_at = ++clock) => { const record = { key, value: structuredClone(value), revision: String(++revision), updated_at }; records.set(key, record); return structuredClone(record) }
  const binary = (entry: FileEntry, bytes: Uint8Array) => { nodes.set(entry.id, { ...entry, size: bytes.length }); data.set(entry.id, bytes); return nodes.get(entry.id)! }
  return { drive, nodes, records, data, get, set, remove, storageList, stat, list, searchPage, readRange, seed, binary }
}
