/**
 * 漫画连续阅读预加载器
 *
 * 核心策略：
 * 1. 以后台低优先级队列向后预加载 5 页，向前保留 2 页缓存；
 * 2. 严格遵循 LRU 淘汰与最大缓存数（默认 12 页），控制内存消耗；
 * 3. 页面切换或跳转时自动中止超出范围的旧加载任务；
 * 4. 优先复用已有请求和缓存，避免重复网络 I/O。
 *
 * 头部尺寸探测（probe）：只读每页开头少量字节解析真实宽高，让连续滚动的
 * 占位高度在图片加载前就与真实内容一致；避免快滚穿越未加载区时页码映射
 * 虚高，以及估高偏低把一次甩动换算成几十页的跳跃。
 */
import type { Drive, FileEntry } from '../sdk/types'
import { LIMITS, RangeFile, createTransport, isAbort, type RangeTransport } from '../reader/io'
import { imageInfo } from '../reader/image'
import type { Archive } from '../reader/archive'

export interface ProbeDimensions { width: number; height: number }

export interface ProbeOptions {
  /** 单页头部读取的字节数，默认 64 KiB；JPEG/AVIF 的尺寸标记几乎总在前 64 KiB 内。 */
  headBytes?: number
  /** 探测环半径（页），跟随阅读中心；默认 12。 */
  ring?: number
  /** 探测并发，默认 2；头部字节小，不与整图预读抢占过多配额。 */
  concurrency?: number
  /** 结果回调；解析失败（损坏或未知格式）为 null，同页不重复探测。 */
  onDimensions?: (index: number, dimensions: ProbeDimensions | null) => void
}

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
  /** 头部尺寸探测；缺省时不探测（旧调用方行为不变）。 */
  probe?: ProbeOptions
}

export class ComicPreloader {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private inflight = new Map<number, { promise: Promise<Uint8Array<ArrayBuffer>>; controller: AbortController }>()
  private queue: number[] = []
  private center = 0
  private disposed = false
  private controller = new AbortController()
  readonly ahead: number
  readonly behind: number
  readonly maxCache: number
  readonly concurrency: number
  // —— 头部尺寸探测 ——
  private readonly probe: Required<Pick<ProbeOptions, 'headBytes' | 'ring' | 'concurrency'>> & ProbeOptions
  private probeSizes = new Map<number, ProbeDimensions | null>()
  private probeQueue: number[] = []
  private probeActive = new Map<number, AbortController>()
  private probeTransport?: RangeTransport

  constructor(private options: PreloaderOptions) {
    this.ahead = options.ahead ?? 5
    this.behind = options.behind ?? 2
    this.maxCache = options.maxCache ?? 12
    this.concurrency = options.concurrency ?? 2
    const probe = options.probe
    this.probe = {
      headBytes: Math.min(LIMITS.entry, Math.max(1024, probe?.headBytes ?? 64 * 1024)),
      ring: Math.min(64, Math.max(2, probe?.ring ?? 12)),
      concurrency: Math.min(4, Math.max(1, probe?.concurrency ?? 2)),
      onDimensions: probe?.onDimensions,
    }
  }

  setCenter(index: number) {
    if (this.disposed) return
    this.center = Math.max(0, Math.min(this.options.pages.length - 1, index))
    this.prune()
    this.schedule()
    this.scheduleProbes()
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

  /** 探测环跟随阅读中心：环外任务中止，环内未知页按距离排序补齐。 */
  private scheduleProbes() {
    if (this.disposed || !this.probe.onDimensions) return
    const count = this.options.pages.length
    // 压缩包页与整图读取共享 1 MiB 分块：探测环收窄到预读窗口，不为远页预取新分块，
    // 保住“只浏览少量页面不下载整个归档”的有界读取；窗口内分块与预读共享、不额外下载。
    // 目录页的头部探测是独立的小范围请求，保持完整探测环。
    const behind = this.options.archive ? this.behind : this.probe.ring
    const ahead = this.options.archive ? this.ahead : this.probe.ring
    const low = Math.max(0, this.center - behind), high = Math.min(count - 1, this.center + ahead)
    for (const [index, controller] of this.probeActive) {
      if (index < low || index > high) { controller.abort(); this.probeActive.delete(index) }
    }
    const wanted: number[] = []
    for (let i = low; i <= high; i++) {
      // 只跳过已探测和正在探测的页面；正在整图读取的页面也要探测——
      // 快滚恰好穿越这些页，尺寸必须尽早精确，不能等完整字节到齐。
      if (this.probeSizes.has(i) || this.probeActive.has(i)) continue

      if (!wanted.includes(i)) wanted.push(i)
    }
    wanted.sort((a, b) => Math.abs(a - this.center) - Math.abs(b - this.center) || b - a)
    this.probeQueue = wanted
    this.pumpProbes()
  }

  private pumpProbes() {
    if (this.disposed || !this.probe.onDimensions) return
    while (this.probeActive.size < this.probe.concurrency && this.probeQueue.length > 0) {
      const next = this.probeQueue.shift()!
      if (this.probeSizes.has(next) || this.probeActive.has(next)) continue
      const controller = new AbortController()
      this.probeActive.set(next, controller)
      void this.probeOne(next, AbortSignal.any([this.options.signal, this.controller.signal, controller.signal]))
        .catch(() => {})
        .finally(() => { if (this.probeActive.get(next) === controller) this.probeActive.delete(next); this.pumpProbes() })
    }
  }

  private async probeOne(index: number, signal: AbortSignal): Promise<void> {
    const page = this.options.pages[index]
    // 瞬时错误（限流、网络抖动）在任务内部有限重试，仍失败则记为无尺寸并回退估高。
    for (let attempt = 0; ; attempt++) {
      try {
        if (!page) throw new Error('探测页码无效')
        const bytes = this.cache.get(index)
        // 已有整图字节时直接解码头部，不再发起新的网络请求；压缩包页没有缓存时
        // 通过 readHead 只解压条目头部（读够即中止底层流，约一个 1 MiB 分块）。
        if (!bytes || bytes.length === 0) {
          const head = await this.readHead(page, signal)
          signal.throwIfAborted()
          let size: ProbeDimensions | null = null
          try { const info = imageInfo(head); size = { width: info.width, height: info.height } } catch { size = null }
          this.probeSizes.set(index, size)
          this.probe.onDimensions?.(index, size)
          return
        }
        signal.throwIfAborted()
        let size: ProbeDimensions | null = null
        try { const info = imageInfo(bytes); size = { width: info.width, height: info.height } } catch { size = null }
        this.probeSizes.set(index, size)
        this.probe.onDimensions?.(index, size)
        return
      } catch (error) {
        if (this.disposed || isAbort(error) || signal.aborted) return
        if (attempt + 1 >= 3) {
          this.probeSizes.set(index, null)
          this.probe.onDimensions?.(index, null)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)))
      }
    }
  }

  /** 只读每页开头小段字节解析真实宽高：目录页走独立小范围请求，
   *  压缩包页只解压条目头部（约一个共享 1 MiB 分块，读够即中止）。 */
  private async readHead(page: PreloadPage, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted()
    if (this.options.archive) return await this.options.archive.readHead(page.entry, this.probe.headBytes, signal)
    if (!page.file) throw new Error('目录页缺少文件引用')
    this.probeTransport ??= createTransport(this.options.drive)
    const length = Math.min(this.probe.headBytes, page.file.size)
    if (length < 1) throw new Error('页面文件为空')
    return await this.probeTransport.read({ id: page.file.id, content_version: page.file.content_version }, 0, length, signal)
  }

  private load(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const existing = this.inflight.get(index)
    if (existing) return existing.promise

    const controller = new AbortController()
    const signal = AbortSignal.any([this.options.signal, this.controller.signal, controller.signal])
    // readPage 将同步错误也转为异步拒绝；迟到的旧 finally 不能删掉同页的新任务。
    const promise = (async () => {
      try {
        const bytes = await this.readPage(index, signal)
        signal.throwIfAborted()
        this.cache.set(index, bytes)
        this.prune()
        return bytes
      } catch (error) {
        if (!isAbort(error) && !signal.aborted && !this.disposed && this.options.error) this.options.error(error)
        throw error
      } finally {
        if (this.inflight.get(index)?.controller === controller) this.inflight.delete(index)
        this.pump()
      }
    })()

    this.inflight.set(index, { promise, controller })
    return promise
  }

  private async readPage(index: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted()
    const page = this.options.pages[index]
    if (!Number.isSafeInteger(index) || !page) throw new Error(`无效页码：${index}`)
    if (this.options.archive) return this.options.archive.read(page.entry, LIMITS.entry, signal)
    const source = new RangeFile(this.options.drive, page.file!, signal, LIMITS.entry)
    try { return await source.read(0, page.file!.size, LIMITS.entry, signal) }
    finally { source.destroy() }
  }

  /** 缩略图只借用已完成的缓存；未命中时独立取消，不移动预读中心或挤掉正文缓存。 */
  async readIndependent(index: number, callerSignal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const signal = AbortSignal.any([this.options.signal, this.controller.signal, callerSignal])
    signal.throwIfAborted()
    const bytes = this.cache.get(index) ?? await this.readPage(index, signal)
    signal.throwIfAborted()
    return bytes
  }

  async get(index: number, callerSignal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.options.signal.throwIfAborted(); this.controller.signal.throwIfAborted(); callerSignal?.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) return cached
    this.queue = this.queue.filter(i => i !== index)
    const pending = this.inflight.get(index)?.promise ?? this.load(index)
    if (!callerSignal) return pending
    return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const onAbort = () => reject(callerSignal.reason ?? new DOMException('读取已取消', 'AbortError'))
      callerSignal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        value => { callerSignal.removeEventListener('abort', onAbort); resolve(value) },
        error => { callerSignal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
  }

  has(index: number): boolean {
    return this.cache.has(index)
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
    this.queue = []
    this.probeQueue = []
    for (const task of this.inflight.values()) {
      task.controller.abort()
    }
    for (const controller of this.probeActive.values()) {
      controller.abort()
    }
    this.inflight.clear()
    this.cache.clear()
    this.probeActive.clear()
    this.probeSizes.clear()
  }
}
