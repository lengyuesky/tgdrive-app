/**
 * 服务器封面库客户端：内存一级缓存、同一轮读取合并为批量请求、后台逐张写入。
 * 封面是可再生缓存：旧宿主没有 covers 能力时只用内存；单张写入失败只影响这一张，从不整体降级。
 */
import type { CoverStats, Drive } from '../sdk/types'
import { abortError, isAbort } from './io'

export interface StoredCover<M> { data: string; meta: M | null }
export interface CoverStoreLimits { entries: number; bytes: number }

const BATCH_KEYS = 16
const DEFAULT_LIMITS: CoverStoreLimits = { entries: 300, bytes: 24 * 1024 * 1024 }

interface Waiter<M> { key: string; done: boolean; resolve(value: StoredCover<M> | undefined): void; reject(reason: unknown): void }

/** 32 位双哈希拼成的短摘要；只用于判断封面是否过期，不作安全用途。 */
export function coverHash(text: string) {
  let a = 2166136261, b = 5381
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(index) }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`
}

export class CoverStore<M = unknown> {
  readonly persistent: boolean
  private memory = new Map<string, StoredCover<M>>()
  private memoryBytes = 0
  private waiting: Waiter<M>[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private controller = new AbortController()
  constructor(private drive: Drive, private limits: CoverStoreLimits = DEFAULT_LIMITS) {
    this.persistent = typeof drive.can === 'function' && drive.can('covers') && typeof drive.covers?.get === 'function'
  }
  get mode(): 'persistent' | 'session' { return this.persistent ? 'persistent' : 'session' }
  get memoryStatus() { return { entries: this.memory.size, bytes: this.memoryBytes } }
  private remember(key: string, value: StoredCover<M>) {
    const previous = this.memory.get(key)
    if (previous) { this.memory.delete(key); this.memoryBytes -= previous.data.length }
    if (value.data.length > this.limits.bytes) return
    this.memory.set(key, value); this.memoryBytes += value.data.length
    for (const [oldest, entry] of this.memory) {
      if (this.memory.size <= this.limits.entries && this.memoryBytes <= this.limits.bytes) break
      this.memory.delete(oldest); this.memoryBytes -= entry.data.length
    }
  }
  private copy(value: StoredCover<M>): StoredCover<M> { return { data: value.data, meta: value.meta === null ? null : structuredClone(value.meta) } }
  /** 未命中返回 undefined；宿主读取失败也按未命中处理，由调用方重新生成。 */
  get(key: string, signal?: AbortSignal): Promise<StoredCover<M> | undefined> {
    signal?.throwIfAborted(); this.controller.signal.throwIfAborted()
    const hit = this.memory.get(key)
    if (hit) { this.memory.delete(key); this.memory.set(key, hit); return Promise.resolve(this.copy(hit)) }
    if (!this.persistent) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      const stop = () => { if (!waiter.done) { waiter.done = true; this.waiting = this.waiting.filter(item => item !== waiter); reject(abortError()) } }
      const waiter: Waiter<M> = {
        key, done: false,
        resolve: value => { if (!waiter.done) { waiter.done = true; signal?.removeEventListener('abort', stop); resolve(value && this.copy(value)) } },
        reject: reason => { if (!waiter.done) { waiter.done = true; signal?.removeEventListener('abort', stop); reject(reason) } },
      }
      signal?.addEventListener('abort', stop, { once: true })
      this.waiting.push(waiter)
      // 可见卡片往往在同一批回调里陆续请求：推迟到下一个宏任务再合并发出。
      this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush() }, 0)
    })
  }
  private async flush() {
    const waiters = this.waiting.filter(item => !item.done); this.waiting = []
    const keys = [...new Set(waiters.map(item => item.key))]
    for (let start = 0; start < keys.length; start += BATCH_KEYS) {
      const slice = keys.slice(start, start + BATCH_KEYS), found = new Map<string, StoredCover<M>>()
      try {
        const records = await this.drive.covers.get<M>(slice, { signal: this.controller.signal })
        for (const record of Array.isArray(records) ? records : []) {
          if (record && slice.includes(record.key) && typeof record.data === 'string') found.set(record.key, { data: record.data, meta: record.meta ?? null })
        }
      } catch (error) {
        if (this.controller.signal.aborted || isAbort(error)) { waiters.filter(item => slice.includes(item.key)).forEach(item => item.reject(abortError())); continue }
      }
      for (const [key, value] of found) if (!this.memory.has(key)) this.remember(key, value)
      for (const waiter of waiters) if (slice.includes(waiter.key)) waiter.resolve(found.get(waiter.key))
    }
  }
  /** 先写内存立即可用，再排队写入封面库；返回的 Promise 只表示后台写入是否成功，调用方无需等待。 */
  set(key: string, data: string, meta: M | null = null): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false)
    this.remember(key, { data, meta: meta === null ? null : structuredClone(meta) })
    if (!this.persistent) return Promise.resolve(false)
    const task = this.writes.then(async () => {
      if (this.controller.signal.aborted) return false
      try { await this.drive.covers.put(key, data, meta as object | null, { signal: this.controller.signal }); return true }
      catch { return false }
    })
    this.writes = task
    return task
  }
  delete(key: string): Promise<boolean> {
    const previous = this.memory.get(key)
    if (previous) { this.memory.delete(key); this.memoryBytes -= previous.data.length }
    if (!this.persistent || this.controller.signal.aborted) return Promise.resolve(false)
    const task = this.writes.then(async () => {
      try { await this.drive.covers.delete([key], { signal: this.controller.signal }); return true } catch { return false }
    })
    this.writes = task
    return task
  }
  /** 服务器封面库占用；旧宿主返回 null。 */
  async stats(signal?: AbortSignal): Promise<CoverStats | null> {
    if (!this.persistent) return null
    return this.drive.covers.stats({ signal })
  }
  destroy() {
    this.controller.abort(); clearTimeout(this.timer); this.timer = undefined
    for (const waiter of this.waiting) waiter.reject(abortError())
    this.waiting = []; this.memory.clear(); this.memoryBytes = 0
  }
}
