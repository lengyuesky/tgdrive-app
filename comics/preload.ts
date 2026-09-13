/**
 * 漫画连续阅读预加载器
 *
 * 核心策略：
 * 1. 以后台低优先级队列向后预加载 5 页，向前保留 2 页缓存；
 * 2. 严格遵循 LRU 淘汰与最大缓存数（默认 12 页），控制内存消耗；
 * 3. 页面切换或跳转时自动中止超出范围的旧加载任务；
 * 4. 优先复用已有请求和缓存，避免重复网络 I/O。
 */
import type { Drive, FileEntry } from '../sdk/types'
import { LIMITS, RangeFile, isAbort } from '../reader/io'
import type { Archive } from '../reader/archive'

export interface PreloadPage {
  name: string
  entry: string
  file?: FileEntry
}

export interface PreloaderOptions {
  pages: PreloadPage[]
  archive?: Archive
  drive: Drive
  signal: AbortSignal
  ahead?: number
  behind?: number
  maxCache?: number
  concurrency?: number
  error?: (err: unknown) => void
}

export class ComicPreloader {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private inflight = new Map<number, { promise: Promise<Uint8Array<ArrayBuffer>>; controller: AbortController }>()
  private queue: number[] = []
  private center = 0
  private disposed = false
  readonly ahead: number
  readonly behind: number
  readonly maxCache: number
  readonly concurrency: number

  constructor(private options: PreloaderOptions) {
    this.ahead = options.ahead ?? 5
    this.behind = options.behind ?? 2
    this.maxCache = options.maxCache ?? 12
    this.concurrency = options.concurrency ?? 2
  }

  setCenter(index: number) {
    if (this.disposed) return
    this.center = Math.max(0, Math.min(this.options.pages.length - 1, index))
    this.prune()
    this.schedule()
  }

  private desiredSet(): Set<number> {
    const min = Math.max(0, this.center - this.behind)
    const max = Math.min(this.options.pages.length - 1, this.center + this.ahead)
    const set = new Set<number>()
    for (let i = min; i <= max; i++) set.add(i)
    return set
  }

  private prune() {
    const desired = this.desiredSet()

    // 1. 中止不在目标范围内的预加载
    for (const [index, task] of this.inflight) {
      if (!desired.has(index)) {
        task.controller.abort()
        this.inflight.delete(index)
      }
    }

    // 2. 缓存淘汰：超出最大缓存数时淘汰离 center 最远的页面
    if (this.cache.size > this.maxCache) {
      const keys = [...this.cache.keys()].sort((a, b) => Math.abs(b - this.center) - Math.abs(a - this.center))
      while (keys.length && this.cache.size > this.maxCache) {
        const farKey = keys.shift()!
        this.cache.delete(farKey)
      }
    }
  }

  private schedule() {
    if (this.disposed) return
    const min = Math.max(0, this.center - this.behind)
    const max = Math.min(this.options.pages.length - 1, this.center + this.ahead)

    const needed: number[] = []
    for (let i = min; i <= max; i++) {
      if (!this.cache.has(i) && !this.inflight.has(i)) {
        needed.push(i)
      }
    }

    // 优先级排序：离中心越近越优先；同距离时，前进方向（未来页）优先于回看方向
    needed.sort((a, b) => {
      const distA = Math.abs(a - this.center)
      const distB = Math.abs(b - this.center)
      if (distA !== distB) return distA - distB
      return b - a
    })

    this.queue = needed
    this.pump()
  }

  private pump() {
    if (this.disposed) return
    while (this.inflight.size < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!
      if (this.cache.has(next) || this.inflight.has(next)) continue
      void this.load(next).catch(() => {})
    }
  }

  private load(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const existing = this.inflight.get(index)
    if (existing) return existing.promise

    const controller = new AbortController()
    const signal = AbortSignal.any([this.options.signal, controller.signal])
    const page = this.options.pages[index]
    if (!page) return Promise.reject(new Error(`无效页码: ${index}`))

    const promise = (async () => {
      try {
        let bytes: Uint8Array<ArrayBuffer>
        if (this.options.archive) {
          bytes = await this.options.archive.read(page.entry, LIMITS.entry, signal)
        } else {
          const source = new RangeFile(this.options.drive, page.file!, signal, LIMITS.entry)
          try {
            bytes = await source.read(0, page.file!.size, LIMITS.entry, signal)
          } finally {
            source.destroy()
          }
        }
        signal.throwIfAborted()
        this.cache.set(index, bytes)
        this.prune()
        return bytes
      } catch (error) {
        if (!isAbort(error) && !this.disposed && this.options.error) {
          this.options.error(error)
        }
        throw error
      } finally {
        this.inflight.delete(index)
        this.pump()
      }
    })()

    this.inflight.set(index, { promise, controller })
    return promise
  }

  async get(index: number, callerSignal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    callerSignal?.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) return cached

    const inFlight = this.inflight.get(index)
    if (inFlight) {
      if (!callerSignal) return inFlight.promise
      return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        const onAbort = () => reject(callerSignal.reason ?? new DOMException('读取已取消', 'AbortError'))
        callerSignal.addEventListener('abort', onAbort, { once: true })
        inFlight.promise.then(
          (val) => { callerSignal.removeEventListener('abort', onAbort); resolve(val) },
          (err) => { callerSignal.removeEventListener('abort', onAbort); reject(err) }
        )
      })
    }

    this.queue = this.queue.filter((i) => i !== index)
    return this.load(index)
  }

  has(index: number): boolean {
    return this.cache.has(index)
  }

  destroy() {
    this.disposed = true
    this.queue = []
    for (const task of this.inflight.values()) {
      task.controller.abort()
    }
    this.inflight.clear()
    this.cache.clear()
  }
}
