/**
 * 漫画海报封面提取与懒加载调度器
 *
 * 功能特性：
 * 1. 智能封面探测：CBZ/ZIP 归档解压首图/封面图，漫画目录智能探测首图及首个分卷章节首图；
 * 2. 视口懒加载与大边距预热：通过 IntersectionObserver（400px 预加载边距）在进入视口前就绪；
 * 3. 并发提升与平滑调度：最大支持 5 个并发，离开视口不中断在途解压与下载任务，后台完成写入缓存；
 * 4. 三级缓存体系：内存 URL 映射 -> 应用持久化存储（drive.storage） -> 远程按需提取；
 * 5. 客户端轻量缩略图：将提取的归档封面图在客户端降采样为 15~25KB WebP/JPEG，跨会话永久秒开并防止 OOM。
 */
import type { Drive, FileEntry } from '../sdk/types'
import { Archive } from '../reader/archive'
import { LIMITS, MiB, RangeFile, extension, isAbort, isImage, natural } from '../reader/io'
import { imageBlob } from '../reader/image'

export interface CoverLoader {
  observe(container: HTMLElement, file: FileEntry): void
  clear(): void
  destroy(): void
}

export interface ComicCoverCacheRecord {
  version: string
  url?: string
  targetId?: number
  targetVersion?: string
  targetKind?: 'thumbnail' | 'preview'
}

/** 智能封面候选排序：优先 cover/poster/封面等关键词，其次 001/01/1 等首图，兜底自然排序 */
export function sortCoverCandidates(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const aName = a.split('/').pop()?.toLowerCase() ?? ''
    const bName = b.split('/').pop()?.toLowerCase() ?? ''

    const aScore = candidateScore(aName)
    const bScore = candidateScore(bName)

    if (aScore !== bScore) return aScore - bScore
    return natural(a, b)
  })
}

function candidateScore(name: string): number {
  const stem = name.replace(/\.[^.]+$/, '')
  // 1. 显式命名为 cover / poster / folder / 封面
  if (/(cover|poster|folder|封面)/i.test(stem)) return 0
  // 2. 序数为 1 的首图（如 001, 01, 1, p001, page_1 等）
  if (/(^|[^\d])0*1$/i.test(stem)) return 1
  // 3. 其他常规图片
  return 2
}

/** 将封面图在客户端降采样为轻量缩略图（通常 15~25KB WebP/JPEG），以便持久化到 drive.storage 和长期内存缓存 */
export async function downscaleCover(blob: Blob, maxDim = 320): Promise<string> {
  try {
    if (typeof document === 'undefined') return URL.createObjectURL(blob)
    const img = new Image()
    const objectUrl = URL.createObjectURL(blob)
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
      img.src = objectUrl
    })
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) {
      URL.revokeObjectURL(objectUrl)
      return URL.createObjectURL(blob)
    }
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      URL.revokeObjectURL(objectUrl)
      return objectUrl
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(objectUrl)
    let dataUrl = canvas.toDataURL('image/webp', 0.8)
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.8)
    }
    return dataUrl
  } catch {
    return URL.createObjectURL(blob)
  }
}

/** 解析媒体 URL，支持缩略图失败时无缝降级到预览图 */
async function resolveImageMediaUrl(
  drive: Drive,
  entry: { id: number; content_version: string },
  kind: 'thumbnail' | 'preview' = 'thumbnail',
): Promise<string> {
  try {
    return await drive.media.url(
      { id: entry.id, content_version: entry.content_version },
      kind,
    )
  } catch (error) {
    if (kind === 'thumbnail') {
      return await drive.media.url(
        { id: entry.id, content_version: entry.content_version },
        'preview',
      )
    }
    throw error
  }
}

/** 从 CBZ / ZIP 归档文件中按需读取首图/封面，优先使用应用持久化数据缓存 */
export async function extractArchiveCover(
  drive: Drive,
  file: FileEntry,
  signal: AbortSignal,
): Promise<string | null> {
  // 1. 优先尝试从 drive.storage 应用缓存读取
  try {
    if (drive.storage?.get) {
      const record = await drive.storage.get<ComicCoverCacheRecord>(`cover:${file.id}`, { signal })
      if (record?.value && record.value.version === file.content_version && record.value.url) {
        return record.value.url
      }
    }
  } catch {
    /* 忽略缓存异常，继续提取 */
  }

  const rangeFile = new RangeFile(drive, file, signal, LIMITS.archive)
  let archive: Archive | undefined
  try {
    archive = await new Archive(rangeFile).open()
    signal.throwIfAborted()

    const validPaths: string[] = []
    for (const [path, item] of archive.entries) {
      if (
        !item.directory &&
        isImage(path) &&
        !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')
      ) {
        validPaths.push(path)
      }
    }
    if (!validPaths.length) return null

    const sorted = sortCoverCandidates(validPaths)
    const coverPath = sorted[0]!
    const bytes = await archive.read(coverPath, 8 * MiB, signal)
    signal.throwIfAborted()

    const { blob } = imageBlob(bytes)
    const url = await downscaleCover(blob)
    signal.throwIfAborted()

    // 2. 成功生成轻量缩略图后，持久化写入应用数据存储供后续秒开
    if (url.startsWith('data:') && drive.storage?.set) {
      try {
        void Promise.resolve(
          drive.storage.set(`cover:${file.id}`, {
            version: file.content_version,
            url,
          } satisfies ComicCoverCacheRecord),
        ).catch(() => {})
      } catch {
        /* 忽略存储异常 */
      }
    }
    return url
  } catch (error) {
    if (isAbort(error)) throw error
    return null
  } finally {
    archive?.destroy()
  }
}

/** 探测漫画目录封面：优先直属图片，次选直属归档，最后探测第一个分卷子目录；支持应用数据缓存 */
export async function detectDirectoryCover(
  drive: Drive,
  dir: FileEntry,
  signal: AbortSignal,
): Promise<string | null> {
  // 1. 优先尝试从 drive.storage 应用缓存读取已探测的目标
  try {
    if (drive.storage?.get) {
      const cached = await drive.storage.get<ComicCoverCacheRecord>(`cover:${dir.id}`, { signal })
      if (cached?.value && cached.value.version === dir.content_version) {
        if (cached.value.url) return cached.value.url
        if (cached.value.targetId && cached.value.targetVersion) {
          return await resolveImageMediaUrl(
            drive,
            { id: cached.value.targetId, content_version: cached.value.targetVersion },
            cached.value.targetKind ?? 'thumbnail',
          )
        }
      }
    }
  } catch {
    /* 忽略缓存异常 */
  }

  try {
    const page = await drive.files.list({ path: dir.path, limit: 60 }, { signal })
    signal.throwIfAborted()

    // 1. 检查直属图片
    const images = page.entries.filter(
      (e) => !e.is_dir && isImage(e.name) && !e.name.startsWith('.'),
    )
    if (images.length > 0) {
      const sorted = sortCoverCandidates(images.map((e) => e.name))
      const best = images.find((e) => e.name === sorted[0])!
      const targetUrl = await resolveImageMediaUrl(drive, best, 'thumbnail')
      if (drive.storage?.set) {
        try {
          void Promise.resolve(
            drive.storage.set(`cover:${dir.id}`, {
              version: dir.content_version,
              targetId: best.id,
              targetVersion: best.content_version,
              targetKind: 'thumbnail',
            } satisfies ComicCoverCacheRecord),
          ).catch(() => {})
        } catch {
          /* 忽略存储异常 */
        }
      }
      return targetUrl
    }

    // 2. 检查直属归档（如目录内放着《第01卷.cbz》）
    const archives = page.entries
      .filter((e) => !e.is_dir && ['cbz', 'zip'].includes(extension(e.name)) && !e.name.startsWith('.'))
      .sort((a, b) => natural(a.name, b.name))
    if (archives.length > 0) {
      return await extractArchiveCover(drive, archives[0]!, signal)
    }

    // 3. 检查子目录（分卷/章节），取第 1 个子目录探测首图或其内归档
    const subDirs = page.entries
      .filter((e) => e.is_dir && !e.name.startsWith('.'))
      .sort((a, b) => natural(a.name, b.name))
    if (subDirs.length > 0) {
      const firstSub = subDirs[0]!
      const subPage = await drive.files.list({ path: firstSub.path, limit: 60 }, { signal })
      signal.throwIfAborted()

      const subImages = subPage.entries.filter(
        (e) => !e.is_dir && isImage(e.name) && !e.name.startsWith('.'),
      )
      if (subImages.length > 0) {
        const sorted = sortCoverCandidates(subImages.map((e) => e.name))
        const best = subImages.find((e) => e.name === sorted[0])!
        const targetUrl = await resolveImageMediaUrl(drive, best, 'thumbnail')
        if (drive.storage?.set) {
          try {
            void Promise.resolve(
              drive.storage.set(`cover:${dir.id}`, {
                version: dir.content_version,
                targetId: best.id,
                targetVersion: best.content_version,
                targetKind: 'thumbnail',
              } satisfies ComicCoverCacheRecord),
            ).catch(() => {})
          } catch {
            /* 忽略存储异常 */
          }
        }
        return targetUrl
      }

      const subArchives = subPage.entries
        .filter((e) => !e.is_dir && ['cbz', 'zip'].includes(extension(e.name)) && !e.name.startsWith('.'))
        .sort((a, b) => natural(a.name, b.name))
      if (subArchives.length > 0) {
        return await extractArchiveCover(drive, subArchives[0]!, signal)
      }
    }

    return null
  } catch (error) {
    if (isAbort(error)) throw error
    return null
  }
}

interface CoverJob {
  container: HTMLElement
  file: FileEntry
  controller?: AbortController
  running?: boolean
}

/** 漫画封面懒加载器与并发控制器 */
export class ComicCoverLoader implements CoverLoader {
  private jobs = new Map<HTMLElement, CoverJob>()
  private queue: CoverJob[] = []
  private activeJobs = new Set<CoverJob>()
  private maxConcurrency = 5
  private observer: IntersectionObserver
  private urlCache = new Map<number, string>()
  private blobUrls: string[] = []
  private maxBlobCache = 200
  private disposed = false

  constructor(private drive: Drive, private signal: AbortSignal) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement
          const job = this.jobs.get(target)
          if (!job) continue
          if (entry.isIntersecting) {
            this.enqueue(job)
          } else {
            this.dequeue(job)
          }
        }
      },
      { rootMargin: '400px' },
    )
    signal.addEventListener('abort', () => this.destroy(), { once: true })
  }

  observe(container: HTMLElement, file: FileEntry) {
    if (this.disposed) return
    const cached = this.urlCache.get(file.id)
    if (cached) {
      this.applyImage(container, cached)
      return
    }
    const job: CoverJob = { container, file }
    this.jobs.set(container, job)
    this.observer.observe(container)
  }

  private enqueue(job: CoverJob) {
    if (this.disposed || job.container.classList.contains('has-cover') || job.running) return
    if (!this.queue.includes(job)) {
      this.queue.push(job)
    }
    this.pump()
  }

  private dequeue(job: CoverJob) {
    const queueIdx = this.queue.indexOf(job)
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1)
    }
    // 离开视口仅在排队队列中移除；正在执行的任务允许其在后台静默完成并写入缓存，避免打断反复重试。
  }

  private pump() {
    if (this.disposed || this.signal.aborted) return
    while (this.activeJobs.size < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      if (!job.container.isConnected) {
        this.jobs.delete(job.container)
        continue
      }
      this.runJob(job)
    }
  }

  private runJob(job: CoverJob) {
    job.running = true
    job.controller = new AbortController()
    this.activeJobs.add(job)

    const jobSignal = AbortSignal.any([this.signal, job.controller.signal])

    void (async () => {
      try {
        let url: string | null | undefined = this.urlCache.get(job.file.id)

        // 优先检查 drive.storage 应用缓存
        if (!url && this.drive.storage?.get) {
          try {
            const cachedRecord = await this.drive.storage.get<ComicCoverCacheRecord>(`cover:${job.file.id}`, { signal: jobSignal })
            if (cachedRecord?.value && cachedRecord.value.version === job.file.content_version && cachedRecord.value.url) {
              url = cachedRecord.value.url
            }
          } catch {
            /* 忽略缓存读取错误 */
          }
        }

        if (!url) {
          if (job.file.is_dir) {
            url = await detectDirectoryCover(this.drive, job.file, jobSignal)
          } else if (['cbz', 'zip'].includes(extension(job.file.name))) {
            url = await extractArchiveCover(this.drive, job.file, jobSignal)
          } else if (isImage(job.file.name)) {
            url = await resolveImageMediaUrl(this.drive, job.file, 'thumbnail')
          }
        }

        jobSignal.throwIfAborted()

        if (url) {
          this.urlCache.set(job.file.id, url)
          if (url.startsWith('blob:')) {
            this.trackBlob(url)
          }
          this.applyImage(job.container, url)
        }
      } catch (error) {
        if (!isAbort(error)) {
          // 封面非致命，静默降级保留占位
        }
      } finally {
        this.activeJobs.delete(job)
        job.running = false
        job.controller = undefined
        this.pump()
      }
    })()
  }

  private trackBlob(url: string) {
    this.blobUrls.push(url)
    if (this.blobUrls.length > this.maxBlobCache) {
      const removed = this.blobUrls.shift()!
      URL.revokeObjectURL(removed)
      for (const [id, cachedUrl] of this.urlCache) {
        if (cachedUrl === removed) {
          this.urlCache.delete(id)
          break
        }
      }
    }
  }

  private applyImage(container: HTMLElement, url: string) {
    container.style.backgroundImage = `url("${url}")`
    container.classList.add('has-cover')
  }

  clear() {
    for (const job of this.activeJobs) {
      job.controller?.abort()
      job.running = false
    }
    this.activeJobs.clear()
    this.queue = []
    for (const [el] of this.jobs) {
      this.observer.unobserve(el)
    }
    this.jobs.clear()
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    this.observer.disconnect()
    for (const url of this.blobUrls) {
      URL.revokeObjectURL(url)
    }
    this.blobUrls = []
    this.urlCache.clear()
  }
}
