import type { Drive, FileEntry } from '../sdk/types'
import { CoverStore, coverHash } from '../reader/cover-store'
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
/** 封面库附加信息：视频内容版本与路径、生成时的本地海报候选摘要及来源；任一不符即重新生成。 */
export interface CinemaArtMeta { v: string; p: string; c: string; s: 'local' | 'thumbnail' }
const MAX_STORED_COVER = 256 * 1024
const storedCover = (raw: unknown): raw is string => typeof raw === 'string' && /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)
function posterBlob(canvas: HTMLCanvasElement, type: string, quality: number, signal: AbortSignal): Promise<Blob | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const finish = (blob: Blob | null) => { signal.removeEventListener('abort', stop); resolve(blob) }
    const stop = () => finish(null)
    signal.addEventListener('abort', stop, { once: true })
    try { canvas.toBlob(finish, type, quality) } catch { finish(null) }
  })
}
/** 异步编码封面，避免同步 WebP 压缩阻塞滚动；取消后不再读取编码结果。 */
export async function encodePoster(image: HTMLImageElement, maxDim: number, signal: AbortSignal): Promise<string | undefined> {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height
  if (!width || !height || signal.aborted) return undefined
  const scale = Math.min(1, maxDim / Math.max(width, height)), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  try {
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.8, 0.6]) {
      let blob = await posterBlob(canvas, 'image/webp', quality, signal)
      if (signal.aborted) return undefined
      if (blob?.type !== 'image/webp') blob = await posterBlob(canvas, 'image/jpeg', quality, signal)
      if (signal.aborted || !blob) return undefined
      if (blob.size > MAX_STORED_COVER) continue
      return await new Promise<string | undefined>(resolve => {
        const reader = new FileReader()
        const finish = (data?: string) => { signal.removeEventListener('abort', stop); resolve(data) }
        const stop = () => { reader.abort(); finish() }
        reader.onload = () => finish(!signal.aborted && storedCover(reader.result) ? reader.result : undefined)
        reader.onerror = () => finish()
        signal.addEventListener('abort', stop, { once: true })
        reader.readAsDataURL(blob)
      })
    }
    return undefined
  } catch { return undefined /* 跨源污染或编码失败只是不写封面库。 */ }
  finally { canvas.width = 0; canvas.height = 0 }
}
/** 按可见性加载封面；离开页面立即终止，离开视口保留已成功加载海报并复用缓存。 */
export class ArtLoader {
  private static caches = new WeakMap<Drive, Map<string, string | Blob>>()
  /** 服务器封面库：每个网盘会话一份，跨页面复用内存一级缓存与批量读取。 */
  private static stores = new WeakMap<Drive, CoverStore<CinemaArtMeta>>()
  private static readonly MAX_CACHE = 150
  private static readonly MAX_CACHE_BYTES = 32 * MiB
  private cache: Map<string, string | Blob>
  private store: CoverStore<CinemaArtMeta>
  private jobs = new Map<HTMLElement, { file: FileEntry; controller?: AbortController; url?: string; wide: boolean; running?: boolean; visible?: boolean }>()
  private observer: IntersectionObserver
  private active = 0
  private lifetime = new AbortController()
  private lastScroll = 0
  private encoding = false
  private pendingCovers: Array<() => Promise<void>> = []
  private onScroll = () => { this.lastScroll = Date.now() }
  constructor(private drive: Drive, private library: Library, private scheduler: ReadScheduler, private signal: AbortSignal, private thumbnailsOnly = false, private thumbnailRoots: readonly string[] = []) {
    this.cache = ArtLoader.caches.get(drive) ?? new Map()
    ArtLoader.caches.set(drive, this.cache)
    this.store = ArtLoader.stores.get(drive) ?? new CoverStore(drive)
    ArtLoader.stores.set(drive, this.store)
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
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
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
  private slot(file: FileEntry, kind: 'poster' | 'wide' | 'thumb') { return `video:${file.id}:${kind}` }
  /** 封面库命中需视频内容版本与路径一致；海报墙另核对当前本地海报候选，收藏历史复用已有海报或缩略图。 */
  private async stored(file: FileEntry, wide: boolean, candidates: string, signal: AbortSignal): Promise<string | undefined> {
    const valid = (hit: { data: string; meta: CinemaArtMeta | null } | undefined, checkCandidates: boolean) =>
      !!hit?.meta && storedCover(hit.data) && hit.meta.v === file.content_version && hit.meta.p === file.path && (!checkCandidates || hit.meta.c === candidates)
    if (this.thumbnailsOnly) {
      const [poster, thumb] = await Promise.all([this.store.get(this.slot(file, 'poster'), signal), this.store.get(this.slot(file, 'thumb'), signal)])
      return valid(poster, false) ? poster!.data : valid(thumb, false) ? thumb!.data : undefined
    }
    const hit = await this.store.get(this.slot(file, wide ? 'wide' : 'poster'), signal)
    return valid(hit, true) ? hit!.data : undefined
  }
  private persist(file: FileEntry, wide: boolean, image: HTMLImageElement, candidates: string, source: CinemaArtMeta['s']) {
    if (!this.store.persistent || this.lifetime.signal.aborted) return
    this.pendingCovers.push(async () => {
      const data = await encodePoster(image, wide ? 1280 : 480, this.lifetime.signal)
      if (data && !this.lifetime.signal.aborted) await this.store.set(this.slot(file, this.thumbnailsOnly ? 'thumb' : wide ? 'wide' : 'poster'), data, { v: file.content_version, p: file.path, c: candidates, s: source })
    })
    void this.drainCovers()
  }
  /** 缓存写入串行执行，滚动停止后再缩放、编码；退出页面立即丢弃待处理任务。 */
  private async drainCovers() {
    if (this.encoding) return
    this.encoding = true
    try {
      while (this.pendingCovers.length) {
        await delay(180, this.lifetime.signal)
        while (Date.now() - this.lastScroll < 180) await delay(180, this.lifetime.signal)
        await this.pendingCovers.shift()!()
      }
    } catch { /* 缓存失败或页面退出不影响已显示海报。 */ }
    finally { this.encoding = false }
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
    const signal = AbortSignal.any([this.signal, this.lifetime.signal, job.controller.signal])
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
      const candidates = coverCandidates(job.file, files, job.wide).filter(file => file.size <= 8 * MiB)
      const signature = coverHash(JSON.stringify(candidates.map(file => [file.id, file.content_version])))
      if (this.store.persistent) {
        // 封面库命中：不再下载原图或申请缩略图票据，只核对视频仍在范围内。
        const stored = await this.stored(job.file, job.wide, signature, signal)
        if (stored) {
          const checked = await this.thumbnail(job.file, signal, stored)
          await this.image(target, checked, signal)
          this.setCache(job.file, job.wide, checked)
          return
        }
      }
      for (const file of candidates) {
        try {
          const source = new RangeFile(this.drive, file, signal, this.scheduler)
          const bytes = await source.read(0, file.size); source.clear()
          const info = imageInfo(bytes)
          if (info.width * info.height > 16_000_000) continue
          const blob = new Blob([bytes], { type: info.mime })
          const image = await this.image(target, blob, signal)
          this.setCache(job.file, job.wide, blob)
          this.persist(job.file, job.wide, image, signature, 'local')
          return
        } catch (error) { if (isAbort(error)) throw error }
      }
      const url = await this.thumbnail(job.file, signal)
      const image = await this.image(target, url, signal)
      this.setCache(job.file, job.wide, url)
      this.persist(job.file, job.wide, image, signature, 'thumbnail')
    } catch { /* 无封面、超限或取消均保留不读取原视频的占位。 */ }
    finally {
      if (entered) this.active--
      job.running = false; job.controller = undefined
      // 快速划出再划入时旧任务可能仍在取消；可见的新任务必须补上，不能永远停留占位。
      if (signal.aborted && !this.signal.aborted && job.visible && this.jobs.get(target) === job) void this.load(target)
    }
  }
  private async image(target: HTMLElement, source: string | Blob, signal: AbortSignal): Promise<HTMLImageElement> {
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
      if (typeof image.decode === 'function') await image.decode()
      signal.throwIfAborted(); target.append(image)
      if (isBlob) this.jobs.get(target)!.url = url
      return image
    } catch (error) {
      image.removeAttribute('src')
      if (isBlob) URL.revokeObjectURL(url)
      throw error
    }
  }
  clear() {
    this.lifetime.abort(); this.pendingCovers.length = 0
    document.removeEventListener('scroll', this.onScroll, true)
    this.observer.disconnect(); for (const target of this.jobs.keys()) this.release(target); this.jobs.clear()
  }
}
