import type { FileNode } from '@tgdrive/page-sdk/contract'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { CinemaClient } from './client'
import { withinDirectory } from './libraries'
import { isAbort, MiB } from './io'

/** 选集始终只读取一页，跨页连播由后端相邻键查询完成；没有整目录截断。 */
export class Library {
  private root: string | null = null
  private generation = 0
  constructor(private cinema: CinemaClient) {}
  clear() { this.generation++ }
  setScope(root: string | null) { if (root !== this.root) { this.clear(); this.root = root } }
  contains(path: string) { return !!this.root && withinDirectory(path, this.root) }
  async playlist(file: FileNode, libraryId: string, cursor: string | null, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.contains(file.path)) throw new Error('目录不在当前媒体库内')
    const generation = this.generation, page = await this.cinema.playlist(file.id, libraryId, cursor, signal)
    signal.throwIfAborted()
    if (generation !== this.generation) throw new DOMException('选集范围已改变', 'AbortError')
    return page
  }
}

interface ArtJob { file: FileNode; controller?: AbortController; url?: string; running: boolean; visible: boolean }
/** 页面只消费影视后端已生成的封面；所有图像字节直读宿主缓存 API，不扫描图片或再次取帧。 */
export class ArtLoader {
  private static readonly caches = new WeakMap<object, Map<string, Blob>>()
  private cache: Map<string, Blob>
  private jobs = new Map<HTMLElement, ArtJob>()
  private observer: IntersectionObserver
  private lifetime = new AbortController()
  constructor(private cinema: CinemaClient, private signal: AbortSignal) {
    this.cache = ArtLoader.caches.get(cinema.host) ?? new Map()
    ArtLoader.caches.set(cinema.host, this.cache)
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement, job = this.jobs.get(target)
        if (!job) continue
        job.visible = entry.isIntersecting
        if (job.visible) { if (!job.running && !target.querySelector('img')) void this.load(target) }
        else if (!target.querySelector('img')) job.controller?.abort()
      }
    }, { rootMargin: '150px' })
    signal.addEventListener('abort', () => this.clear(), { once: true })
  }
  observe(target: HTMLElement, file: FileNode, _wide = false) {
    if (this.jobs.has(target)) this.release(target)
    this.jobs.set(target, { file, running: false, visible: false }); this.observer.observe(target)
  }
  private release(target: HTMLElement) {
    const job = this.jobs.get(target)
    job?.controller?.abort()
    if (job?.url) { URL.revokeObjectURL(job.url); job.url = undefined }
    target.querySelectorAll('img').forEach(image => { image.removeAttribute('src'); image.remove() })
  }
  private remember(key: string, blob: Blob) {
    this.cache.delete(key); this.cache.set(key, blob)
    let bytes = [...this.cache.values()].reduce((sum, value) => sum + value.size, 0)
    for (const [key, value] of this.cache) {
      if (this.cache.size <= 150 && bytes <= 32 * MiB) break
      this.cache.delete(key); bytes -= value.size
    }
  }
  private async blob(key: string, signal: AbortSignal) {
    const cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached }
    const response = await this.cinema.host.cacheGet(key, { signal })
    if (BigInt(response.entry.size) > BigInt(LIMITS.MAX_CACHE_OBJECT_BYTES) || !response.body || !/^image\/(jpeg|png|webp)$/.test(response.entry.content_type)) {
      await response.body?.cancel(); throw new Error('封面格式或大小超过读取预算')
    }
    const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > LIMITS.MAX_CACHE_OBJECT_BYTES) throw new Error('封面超过读取预算')
        chunks.push(new Uint8Array(part.value))
      }
      signal.throwIfAborted()
      if (BigInt(bytes) !== BigInt(response.entry.size)) throw new Error('封面读取被截断')
      return new Blob(chunks, { type: response.entry.content_type })
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
  }
  private async load(target: HTMLElement) {
    const job = this.jobs.get(target)
    if (!job || job.running || target.querySelector('img')) return
    job.running = true; job.controller = new AbortController()
    const signal = AbortSignal.any([this.signal, this.lifetime.signal, job.controller.signal])
    let url: string | undefined, image: HTMLImageElement | undefined
    try {
      // 内存命中也重新让后端核对媒体库、当前内容与封面来源；命中不是授权凭据。
      const cover = await this.cinema.cover(job.file.id, signal)
      signal.throwIfAborted()
      if (!cover.key) return
      const blob = await this.blob(cover.key, signal)
      signal.throwIfAborted()
      url = URL.createObjectURL(blob); job.url = url
      image = new Image(); image.alt = ''; image.decoding = 'async'; image.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { image!.onload = null; image!.onerror = null; signal.removeEventListener('abort', stop) }
        const stop = () => { cleanup(); image!.removeAttribute('src'); reject(new DOMException('读取已取消', 'AbortError')) }
        image!.onload = () => { cleanup(); resolve() }; image!.onerror = () => { cleanup(); reject(new Error('封面不可用')) }
        signal.addEventListener('abort', stop, { once: true }); image!.src = url!
      })
      signal.throwIfAborted()
      if (typeof image.decode === 'function') await new Promise<void>((resolve, reject) => {
        const stop = () => { signal.removeEventListener('abort', stop); reject(new DOMException('解码已取消', 'AbortError')) }
        signal.addEventListener('abort', stop, { once: true })
        void image!.decode().then(() => { signal.removeEventListener('abort', stop); resolve() }, error => { signal.removeEventListener('abort', stop); reject(error) })
      })
      signal.throwIfAborted()
      if (this.jobs.get(target) !== job) return
      target.append(image); job.url = url; url = undefined
      this.remember(cover.key, blob)
    } catch (error) {
      if (!signal.aborted && (error as { code?: string }).code === 'not_found') await this.cinema.cover(job.file.id, signal).catch(() => {})
      // 缺图和后台任务未就绪保留占位，不影响播放。
    }
    finally {
      if (url) { image?.removeAttribute('src'); if (job.url === url) { URL.revokeObjectURL(url); job.url = undefined } }
      job.running = false; job.controller = undefined
      if (signal.aborted && !this.signal.aborted && !this.lifetime.signal.aborted && job.visible && this.jobs.get(target) === job) void this.load(target)
    }
  }
  clear() { this.lifetime.abort(); this.observer.disconnect(); for (const target of this.jobs.keys()) this.release(target); this.jobs.clear() }
}
