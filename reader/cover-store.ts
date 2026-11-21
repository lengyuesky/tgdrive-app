/** 通用小对象缓存中的封面小图；内存只保存有界热点，文件来源由宿主自动核对失效。 */
import type { ContentRef, DataUsage, HostClient, JsonValue } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { abortError, isAbort } from './io'
export interface StoredCover<M> { data: string; meta: M | null }
export interface CoverStoreLimits { entries: number; bytes: number }
interface Waiter<M> { key: string; done: boolean; resolve(value: StoredCover<M> | undefined): void; reject(reason: unknown): void }
const DEFAULT_LIMITS: CoverStoreLimits = { entries: 300, bytes: 24 * 1024 * 1024 }
/** 非安全摘要仅用于判断应用侧封面元信息是否一致。 */
export function coverHash(text: string) {
  let a = 2166136261, b = 5381
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(index) }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`
}
export class CoverStore<M = unknown> {
  readonly persistent = true
  private memory = new Map<string, { value: StoredCover<M>; expiresAt?: number }>()
  private memoryBytes = 0
  private waiting: Waiter<M>[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private controller = new AbortController()
  constructor(private host: HostClient, private limits: CoverStoreLimits = DEFAULT_LIMITS) {}
  get mode(): 'persistent' { return 'persistent' }
  get memoryStatus() { return { entries: this.memory.size, bytes: this.memoryBytes } }
  private remember(key: string, value: StoredCover<M>, expiresAt?: number) {
    const previous = this.memory.get(key)
    if (previous) { this.memory.delete(key); this.memoryBytes -= previous.value.data.length }
    if (value.data.length > this.limits.bytes) return
    this.memory.set(key, { value, expiresAt }); this.memoryBytes += value.data.length
    for (const [oldest, entry] of this.memory) {
      if (this.memory.size <= this.limits.entries && this.memoryBytes <= this.limits.bytes) break
      this.memory.delete(oldest); this.memoryBytes -= entry.value.data.length
    }
  }
  private copy(value: StoredCover<M>): StoredCover<M> { return { data: value.data, meta: value.meta === null ? null : structuredClone(value.meta) } }
  get(key: string, signal?: AbortSignal): Promise<StoredCover<M> | undefined> {
    signal?.throwIfAborted(); this.controller.signal.throwIfAborted()
    const hit = this.memory.get(key)
    if (hit && (!hit.expiresAt || hit.expiresAt > Date.now() + 5000)) { this.memory.delete(key); this.memory.set(key, hit); return Promise.resolve(this.copy(hit.value)) }
    if (hit) { this.memory.delete(key); this.memoryBytes -= hit.value.data.length }
    return new Promise((resolve, reject) => {
      const stop = () => { if (!waiter.done) { waiter.done = true; this.waiting = this.waiting.filter(item => item !== waiter); reject(abortError()) } }
      const waiter: Waiter<M> = { key, done: false,
        resolve: value => { if (!waiter.done) { waiter.done = true; signal?.removeEventListener('abort', stop); resolve(value && this.copy(value)) } },
        reject: reason => { if (!waiter.done) { waiter.done = true; signal?.removeEventListener('abort', stop); reject(reason) } },
      }
      signal?.addEventListener('abort', stop, { once: true }); this.waiting.push(waiter)
      this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush() }, 0)
    })
  }
  private async flush() {
    const waiters = this.waiting.filter(item => !item.done); this.waiting = []
    const keys = [...new Set(waiters.map(item => item.key))]
    for (let start = 0; start < keys.length; start += LIMITS.MAX_CACHE_LOOKUP_KEYS) {
      const slice = keys.slice(start, start + LIMITS.MAX_CACHE_LOOKUP_KEYS), found = new Map<string, StoredCover<M>>()
      try {
        const result = await this.host.cacheLookup({ keys: slice }, { signal: this.controller.signal })
        for (const hit of result.hits) {
          const value: StoredCover<M> = { data: hit.url, meta: hit.entry.metadata as M | null }
          found.set(hit.entry.key, value); this.remember(hit.entry.key, value, hit.expires_at)
        }
      } catch (error) { if (this.controller.signal.aborted || isAbort(error)) { waiters.filter(item => slice.includes(item.key)).forEach(item => item.reject(abortError())); continue } }
      for (const waiter of waiters) if (slice.includes(waiter.key)) waiter.resolve(found.get(waiter.key))
    }
  }
  /** 显示不等待缓存写入；只存解码后的小图，来源必须是实际参与派生的文件。 */
  set(key: string, data: string, meta: M | null = null, sources: ContentRef[] = []): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false)
    const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data)
    if (!match || !sources.length) return Promise.resolve(false)
    let bytes: Uint8Array<ArrayBuffer>
    try { bytes = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0)) } catch { return Promise.resolve(false) }
    if (!bytes.length || bytes.length > LIMITS.MAX_CACHE_OBJECT_BYTES) return Promise.resolve(false)
    this.remember(key, { data, meta: meta === null ? null : structuredClone(meta) })
    const task = this.writes.then(async () => {
      if (this.controller.signal.aborted) return false
      try { await this.host.cachePut(key, bytes, match[1]!, { metadata: meta as unknown as JsonValue, sources }, { signal: this.controller.signal }); return true }
      catch { return false }
    })
    this.writes = task; return task
  }
  delete(key: string): Promise<boolean> {
    const previous = this.memory.get(key)
    if (previous) { this.memory.delete(key); this.memoryBytes -= previous.value.data.length }
    if (this.controller.signal.aborted) return Promise.resolve(false)
    const task = this.writes.then(async () => { try { await this.host.cacheDelete(key, { signal: this.controller.signal }); return true } catch { return false } })
    this.writes = task; return task
  }
  stats(signal?: AbortSignal): Promise<DataUsage> { return this.host.dataUsage({ signal }) }
  destroy() { this.controller.abort(); clearTimeout(this.timer); this.timer = undefined; for (const waiter of this.waiting) waiter.reject(abortError()); this.waiting = []; this.memory.clear(); this.memoryBytes = 0 }
}
