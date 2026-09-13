import type { Drive, FileEntry } from '../sdk/types'
import { imageInfo } from '../reader/image'
import { coverCandidates, isVideo, parentPath } from './model'
import { RangeFile, ReadScheduler, MiB, isAbort, delay } from './io'
import { requireDirectory, withinDirectory } from './libraries'

export class Library {
  private cache = new Map<string, { files: FileEntry[]; complete: boolean }>()
  private pending = new Map<string, Promise<{ files: FileEntry[]; complete: boolean }>>()
  private generation = 0
  constructor(private drive: Drive, private root: string | null = null) {}
  clear() { this.generation++; this.cache.clear(); this.pending.clear() }
  setScope(root: string | null) { if (root !== this.root) { this.clear(); this.root = root } }
  contains(path: string) { return this.root !== null && withinDirectory(path, this.root) }
  async directory(path: string, signal: AbortSignal, full = false): Promise<{ files: FileEntry[]; complete: boolean }> {
    signal.throwIfAborted()
    requireDirectory(this.root, path)
    const generation = this.generation, cached = this.cache.get(path)
    if (cached && (!full || cached.complete)) return cached
    const key = `${path}:${full}`, pending = this.pending.get(key)
    if (pending) {
      try { return await pending }
      catch (error) {
        if (isAbort(error) && !signal.aborted) return this.directory(path, signal, full)
        throw error
      }
    }
    const task = (async () => {
      const files: FileEntry[] = []
      let cursor: string | null = null, complete = false
      do {
        const page = await this.drive.files.list({ path, limit: 200, cursor }, { signal })
        files.push(...page.entries); cursor = page.next_cursor; complete = !page.has_more
        if (!full || complete) break
        await delay(140, signal)
      } while (cursor && files.length < 10000)
      signal.throwIfAborted()
      const value = { files, complete }, current = this.cache.get(path)
      // 旧轮次不能回填刷新后的缓存，封面第一页也不能把完整选集降级为局部结果。
      if (generation === this.generation && (!current || complete || !current.complete && files.length >= current.files.length)) {
        if (!this.cache.has(path) && this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(path, value)
      }
      return value
    })().finally(() => { if (this.pending.get(key) === task) this.pending.delete(key) })
    this.pending.set(key, task)
    return task
  }
}
/** 按可见性加载封面；离开页面立即终止，离开视口保留已成功加载海报并复用缓存。 */
export class ArtLoader {
  private static caches = new WeakMap<Drive, Map<string, string | Blob>>()
  private static readonly MAX_CACHE = 150
  private static readonly MAX_CACHE_BYTES = 32 * MiB
  private cache: Map<string, string | Blob>
  private jobs = new Map<HTMLElement, { file: FileEntry; controller?: AbortController; url?: string; wide: boolean; running?: boolean; visible?: boolean }>()
  private observer: IntersectionObserver
  private active = 0
  constructor(private drive: Drive, private library: Library, private scheduler: ReadScheduler, private signal: AbortSignal, private thumbnailsOnly = false, private thumbnailRoots: readonly string[] = []) {
    this.cache = ArtLoader.caches.get(drive) ?? new Map()
    ArtLoader.caches.set(drive, this.cache)
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement, job = this.jobs.get(target)
        if (!job) continue
        job.visible = entry.isIntersecting
        if (entry.isIntersecting) {
          if (!job.running && !target.querySelector('img')) void this.load(target)
        } else if (!target.querySelector('img')) {
          // 只取消未完成的加载；旧任务自行收尾后才能重试，不能提前清除运行标记。
          job.controller?.abort()
        }
      }
    }, { rootMargin: '150px' })
    signal.addEventListener('abort', () => this.clear(), { once: true })
  }
  private cacheKey(file: FileEntry, wide: boolean): string {
    return JSON.stringify([file.id, file.content_version, file.path, wide, this.thumbnailsOnly])
  }
  private getCached(file: FileEntry, wide: boolean) {
    const key = this.cacheKey(file, wide), entry = this.cache.get(key)
    if (entry) {
      // 最近使用的封面放到尾部，优先淘汰旧缓存。
      this.cache.delete(key); this.cache.set(key, entry)
    }
    return entry
  }
  private setCache(file: FileEntry, wide: boolean, source: string | Blob) {
    const key = this.cacheKey(file, wide)
    this.cache.delete(key); this.cache.set(key, source)
    let bytes = 0
    for (const entry of this.cache.values()) if (typeof entry !== 'string') bytes += entry.size
    for (const [oldKey, entry] of this.cache) {
      if (this.cache.size <= ArtLoader.MAX_CACHE && bytes <= ArtLoader.MAX_CACHE_BYTES) break
      this.cache.delete(oldKey)
      if (typeof entry !== 'string') bytes -= entry.size
    }
  }
  private inScope(path: string) {
    return this.thumbnailsOnly ? this.thumbnailRoots.some(root => withinDirectory(path, root)) : this.library.contains(path)
  }
  private thumbnail(file: FileEntry, signal: AbortSignal, cached?: string) {
    return this.scheduler.run(async () => {
      // 命中缓存也重新核对范围，防止排队期间移出的文件绕过校验。
      const current = await this.drive.files.stat({ id: file.id }, { signal })
      signal.throwIfAborted()
      if (!this.inScope(current.path) || !isVideo(current) || current.content_version !== file.content_version) throw new Error('视频已移出范围或内容改变')
      return cached ?? this.drive.media.url(current, 'thumbnail')
    }, signal)
  }
  observe(target: HTMLElement, file: FileEntry, wide = false) {
    if (this.jobs.has(target)) this.release(target)
    this.jobs.set(target, { file, wide }); this.observer.observe(target)
  }
  private release(target: HTMLElement) {
    const job = this.jobs.get(target)
    job?.controller?.abort()
    if (job?.url) URL.revokeObjectURL(job.url)
    if (job) job.url = undefined
    target.querySelectorAll('img').forEach(image => { image.removeAttribute('src'); image.remove() })
  }
  private async load(target: HTMLElement) {
    const job = this.jobs.get(target)
    if (!job || job.running || target.querySelector('img')) return
    // 缓存解码也必须进入同一套去重、取消和并发控制。
    job.running = true; job.controller = new AbortController()
    const signal = AbortSignal.any([this.signal, job.controller.signal])
    let entered = false
    try {
      while (this.active >= 4) await delay(50, signal)
      signal.throwIfAborted(); this.active++; entered = true
      if (!this.inScope(job.file.path)) return
      const cached = this.getCached(job.file, job.wide)
      if (cached) {
        try {
          const source = typeof cached === 'string' ? await this.thumbnail(job.file, signal, cached) : cached
          await this.image(target, source, signal)
          return
        } catch (error) {
          if (isAbort(error)) throw error
          const key = this.cacheKey(job.file, job.wide)
          if (this.cache.get(key) === cached) this.cache.delete(key)
        }
      }
      // 收藏和历史只取已有缩略图，不为每条记录枚举不同媒体库的目录。
      const files = this.thumbnailsOnly ? [] : (await this.library.directory(parentPath(job.file.path), signal)).files
      for (const file of coverCandidates(job.file, files, job.wide)) {
        if (file.size > 8 * MiB) continue
        try {
          const source = new RangeFile(this.drive, file, signal, this.scheduler)
          const bytes = await source.read(0, file.size); source.clear()
          const info = imageInfo(bytes)
          if (info.width * info.height > 16_000_000) continue
          const blob = new Blob([bytes], { type: info.mime })
          await this.image(target, blob, signal)
          this.setCache(job.file, job.wide, blob)
          return
        } catch (error) { if (isAbort(error)) throw error }
      }
      const url = await this.thumbnail(job.file, signal)
      await this.image(target, url, signal)
      this.setCache(job.file, job.wide, url)
    } catch { /* 无封面、超限或取消均保留不读取原视频的占位。 */ }
    finally {
      if (entered) this.active--
      job.running = false; job.controller = undefined
      // 快速划出再划入时旧任务可能仍在取消；可见的新任务必须补上，不能永远停留占位。
      if (signal.aborted && !this.signal.aborted && job.visible && this.jobs.get(target) === job) void this.load(target)
    }
  }
  private async image(target: HTMLElement, source: string | Blob, signal: AbortSignal) {
    signal.throwIfAborted()
    // 缓存保存字节，每个图片节点独立持有对象地址；淘汰缓存或关闭详情不影响列表封面。
    const isBlob = typeof source !== 'string', url = typeof source === 'string' ? source : URL.createObjectURL(source)
    const image = new Image(); image.alt = ''; image.decoding = 'async'; image.crossOrigin = 'anonymous'
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', stop) }
        const stop = () => { cleanup(); image.removeAttribute('src'); reject(new DOMException('读取已取消', 'AbortError')) }
        image.onload = () => { cleanup(); resolve() }; image.onerror = () => { cleanup(); reject(new Error('封面不可用')) }
        signal.addEventListener('abort', stop, { once: true }); image.src = url
      })
      signal.throwIfAborted(); target.append(image)
      if (isBlob) this.jobs.get(target)!.url = url
    } catch (error) {
      image.removeAttribute('src')
      if (isBlob) URL.revokeObjectURL(url)
      throw error
    }
  }
  clear() { this.observer.disconnect(); for (const target of this.jobs.keys()) this.release(target); this.jobs.clear() }
}
