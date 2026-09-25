/** 可回收缓存仅使用自身前缀；配额失败仅降级当前会话，不删除任何用户状态。 */
import type { Drive, Page, RecordValue } from '../../sdk/types'
import { MiB, abortError, isAbort } from '../io'
import { jsonBytes, timeSlice } from './model'

/** 封面缩略图已改存服务器封面库（见 ../cover-store），私有存储只保留元数据缓存。 */
export const CACHE_BUDGETS = { metadata: 4 * MiB } as const
export interface CacheStatus { mode: 'persistent' | 'session'; bytes: number; entries: number; message?: string }
interface CacheValue<T> { schemaVersion: 1; key: string; value: T; touchedAt: number }
interface CacheEntry<T> { value: T; bytes: number; touchedAt: number; record?: RecordValue<CacheValue<T>> }
const cacheHash = (key: string) => {
  let a = 2166136261, b = 5381
  for (let index = 0; index < key.length; index++) { a = Math.imul(a ^ key.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ key.charCodeAt(index) }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`
}
export class BudgetCache<T> {
  private entries = new Map<string, CacheEntry<T>>()
  private bytes = 0
  private ready?: Promise<void>
  private queue = Promise.resolve()
  private sessionOnly = false
  private message?: string
  private controller = new AbortController()
  readonly prefix: string
  constructor(private drive: Drive, name: 'thumbnail' | 'metadata', readonly budget: number, private valid: (raw: unknown) => raw is T, private changed?: (status: CacheStatus) => void) {
    this.prefix = `library:cache:${name}:`
  }
  get status(): CacheStatus { return { mode: this.sessionOnly ? 'session' : 'persistent', bytes: this.bytes, entries: this.entries.size, message: this.message } }
  private notify() { this.changed?.(this.status) }
  private degrade() { this.sessionOnly = true; this.message = '缓存存储不可用，已降级为本次会话；阅读状态和人工整理不受影响'; this.notify() }
  private key(key: string) { return this.prefix + cacheHash(key) }
  private envelope(key: string, value: T, touchedAt: number): CacheValue<T> { return { schemaVersion: 1, key, value, touchedAt } }
  private async initialize() {
    try {
      let cursor: string | null = null
      const seen = new Set<string>()
      do {
        const page: Page & { records: RecordValue<CacheValue<T>>[] } = await this.drive.storage.list<CacheValue<T>>({ prefix: this.prefix, cursor, limit: 32 }, { signal: this.controller.signal })
        this.controller.signal.throwIfAborted()
        for (const record of page.records) {
          const item = record.value
          if (!item || item.schemaVersion !== 1 || typeof item.key !== 'string' || item.key.length > 8192 || record.key !== this.key(item.key)
            || !Number.isFinite(item.touchedAt) || !this.valid(item.value)) { this.degrade(); continue }
          const bytes = jsonBytes(item)
          const entry = { value: structuredClone(item.value), bytes, touchedAt: item.touchedAt, record }
          const previous = this.entries.get(item.key)
          if (previous) this.bytes -= previous.bytes
          this.entries.set(item.key, entry); this.bytes += bytes
          await this.trim()
        }
        if (!page.has_more) break
        if (!page.next_cursor || seen.has(page.next_cursor)) { this.degrade(); break }
        seen.add(page.next_cursor); cursor = page.next_cursor
        await timeSlice(this.controller.signal)
      } while (cursor)
      this.notify()
    } catch (error) { if (isAbort(error) || this.controller.signal.aborted) throw error; this.degrade() }
  }
  private init() { return this.ready ??= this.initialize() }
  private cancellable<R>(pending: Promise<R>, signal?: AbortSignal): Promise<R> {
    const current = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    return new Promise((resolve, reject) => {
      const stop = () => reject(current.reason)
      if (current.aborted) { void pending.catch(() => {}); reject(current.reason); return }
      current.addEventListener('abort', stop, { once: true })
      pending.then(value => { current.removeEventListener('abort', stop); resolve(value) }, error => { current.removeEventListener('abort', stop); reject(error) })
    })
  }
  private async trim() {
    while (this.bytes > this.budget || this.entries.size > 2000) {
      let oldest: [string, CacheEntry<T>] | undefined
      for (const entry of this.entries) if (!oldest || entry[1].touchedAt < oldest[1].touchedAt) oldest = entry
      if (!oldest) break
      this.entries.delete(oldest[0]); this.bytes -= oldest[1].bytes
      if (!this.sessionOnly && oldest[1].record) {
        try { await this.drive.storage.delete(oldest[1].record.key, oldest[1].record.revision, { signal: this.controller.signal }) }
        catch (error) { if (this.controller.signal.aborted) throw error; this.degrade() }
      }
    }
  }
  async get(key: string, signal?: AbortSignal): Promise<T | undefined> {
    signal?.throwIfAborted(); await this.cancellable(this.init(), signal); signal?.throwIfAborted(); this.controller.signal.throwIfAborted()
    const entry = this.entries.get(key)
    if (!entry) return undefined
    entry.touchedAt = Date.now()
    return structuredClone(entry.value)
  }
  async set(key: string, value: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.valid(value)) return
    const task = this.queue.catch(() => {}).then(async () => {
      await this.cancellable(this.init(), signal); signal?.throwIfAborted(); this.controller.signal.throwIfAborted()
      const current = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
      const touchedAt = Date.now(), item = this.envelope(key, structuredClone(value), touchedAt), bytes = jsonBytes(item)
      if (bytes > this.budget) return
      const previous = this.entries.get(key)
      if (previous) this.bytes -= previous.bytes
      const entry: CacheEntry<T> = { value: item.value, bytes, touchedAt, record: previous?.record }
      this.entries.set(key, entry); this.bytes += bytes
      await this.trim()
      // 超过单记录预算的条目只在内存中使用，不把一张异常封面撑成巨型存储记录。
      if (!this.sessionOnly && bytes <= 48 * 1024) {
        try {
          const existing = entry.record ?? await this.drive.storage.get<CacheValue<T>>(this.key(key), { signal: current })
          if (existing && (existing.value?.schemaVersion !== 1 || existing.value.key !== key)) { this.degrade(); return }
          signal?.throwIfAborted()
          entry.record = await this.drive.storage.set(this.key(key), item, existing?.revision ?? null, { signal: current })
        } catch (error) { if (signal?.aborted || this.controller.signal.aborted) throw error; this.degrade() }
      }
      this.notify(); signal?.throwIfAborted()
    })
    this.queue = task
    return this.cancellable(task, signal)
  }
  destroy() { this.controller.abort(); this.entries.clear(); this.bytes = 0 }
}

/** 库任务拥有独立取消队列；底层 Range 仍经过 reader/io 的全局三并发。 */
export class TaskPool {
  private active = 0
  private waiting: { signal: AbortSignal; run(): void; cancel(): void }[] = []
  constructor(readonly concurrency: number) {}
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const job = { signal, run: () => {
        signal.removeEventListener('abort', job.cancel)
        if (signal.aborted) { reject(abortError()); return }
        this.active++
        Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(resolve, reject).finally(() => { this.active--; this.pump() })
      }, cancel: () => { this.waiting = this.waiting.filter(item => item !== job); reject(abortError()) } }
      if (signal.aborted) { reject(abortError()); return }
      signal.addEventListener('abort', job.cancel, { once: true }); this.waiting.push(job); this.pump()
    })
  }
  private pump() { while (this.active < this.concurrency && this.waiting.length) this.waiting.shift()!.run() }
}
export const coverTasks = new TaskPool(2)
export const metadataTasks = new TaskPool(2)
export const pdfPreviewTasks = new TaskPool(1)
