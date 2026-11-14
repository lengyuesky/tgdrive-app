import { vi } from 'vitest'
import type { RecordValue } from '../../sdk/types'

/** 按宿主的 JSON、CAS、分页与容量约束执行，不把同引用对象当成已经落盘。 */
export function memoryStorage() {
  const rows = new Map<string, RecordValue<unknown>>()
  let sequence = 0
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const api = {
    get: vi.fn(async (key: string) => copy(rows.get(key) ?? null)),
    set: vi.fn(async (key: string, value: unknown, revision?: string | null) => {
      if ((rows.get(key)?.revision ?? null) !== (revision ?? null)) throw Object.assign(new Error('revision 冲突'), { status: 409 })
      if (new TextEncoder().encode(JSON.stringify(value)).length > 32768) throw new Error('超过单条记录上限')
      const row = { key, value: copy(value), revision: String(++sequence), updated_at: sequence }
      rows.set(key, row); return copy(row)
    }),
    delete: vi.fn(async (key: string, revision: string) => {
      if (rows.get(key)?.revision !== revision) throw new Error('revision 冲突')
      rows.delete(key); return { ok: true as const }
    }),
    list: vi.fn(async ({ prefix = '', cursor, limit = 200 }: { prefix?: string; cursor?: string | null; limit?: number } = {}) => {
      const all = [...rows.values()].filter(row => row.key.startsWith(prefix)).sort((a, b) => b.updated_at - a.updated_at)
      const at = cursor ? Number(cursor) : 0, records = all.slice(at, at + limit), more = at + limit < all.length
      return copy({ records, has_more: more, next_cursor: more ? String(at + limit) : null })
    }),
  }
  return { rows, api }
}
