/** 封面只由可见卡片或详情显式请求；不签发原文件 URL，不改变阅读位置。 */
import type { Drive, FileEntry } from '../../sdk/types'
import { Archive } from '../archive'
import { imageBlob, imageInfo } from '../image'
import { LIMITS, MiB, RangeFile, isAbort, isImage, natural } from '../io'
import { CoverStore, coverHash } from '../cover-store'
import { coverTasks, pdfPreviewTasks } from './cache'
import { downscaleCover, isThumbnailUrl, sortCoverCandidates } from './cover-image'
import { epubArchiveMetadata, type PdfOpener } from './metadata'
import { LibraryError, errorMessage, parentPath, unitFormat, type ReadingUnit } from './model'
import type { LibraryAccess } from './sources'

export type CoverOrigin = 'same-name' | 'directory' | 'embedded' | 'first-image' | 'pdf' | 'placeholder'
export interface CoverResource { url: string | null; origin: CoverOrigin; warnings: string[]; release(): void }
export interface ThumbnailRecord { url: string; origin: Exclude<CoverOrigin, 'placeholder'>; target?: { id: number; contentVersion: string; path: string } }
export function validThumbnailRecord(raw: unknown): raw is ThumbnailRecord {
  const value = raw as ThumbnailRecord | null
  if (!value || !isThumbnailUrl(value.url) || value.url.length > MiB || !['same-name', 'directory', 'embedded', 'first-image', 'pdf'].includes(value.origin)
    || value.target !== undefined && (!Number.isSafeInteger(value.target.id) || typeof value.target.contentVersion !== 'string' || typeof value.target.path !== 'string')) return false
  try {
    const binary = atob(value.url.slice(value.url.indexOf(',') + 1)), bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), info = imageInfo(bytes)
    return info.width <= 320 && info.height <= 320 && value.url.startsWith(`data:${info.mime};`)
  } catch { return false }
}
interface ThumbnailMeta { schemaVersion: 1; check: string; origin: ThumbnailRecord['origin']; target?: ThumbnailRecord['target'] }
/**
 * 封面缩略图按作品节点存进服务器封面库（每部作品一条，变化时原地覆盖）。
 * 完整核验键（节点、内容版本、路径、父目录与来源身份）取摘要放进附加信息，不一致即视为未命中。
 */
export class ThumbnailCache {
  constructor(readonly store: CoverStore<ThumbnailMeta>) {}
  async get(slot: string, check: string, signal?: AbortSignal): Promise<ThumbnailRecord | undefined> {
    const hit = await this.store.get(slot, signal), meta = hit?.meta
    if (!hit || !meta || meta.schemaVersion !== 1 || meta.check !== coverHash(check)) return undefined
    const record: ThumbnailRecord = { url: hit.data, origin: meta.origin, ...(meta.target ? { target: meta.target } : {}) }
    return validThumbnailRecord(record) ? record : undefined
  }
  set(slot: string, check: string, record: ThumbnailRecord) {
    if (!validThumbnailRecord(record)) return Promise.resolve(false)
    return this.store.set(slot, record.url, { schemaVersion: 1, check: coverHash(check), origin: record.origin, ...(record.target ? { target: record.target } : {}) })
  }
  destroy() { this.store.destroy() }
}
const lease = (url: string | null, origin: CoverOrigin, warnings: string[] = []): CoverResource => {
  let released = false
  return { url, origin, warnings, release: () => { if (!released && url?.startsWith('blob:')) URL.revokeObjectURL(url); released = true } }
}
const hidden = (path: string) => path.split('/').some(part => part.startsWith('.') || part === '__MACOSX')

export class CoverService {
  readonly cache: ThumbnailCache
  private controller = new AbortController()
  private paused = false
  constructor(private drive: Drive, private access: LibraryAccess, cache?: ThumbnailCache, private openPdf?: PdfOpener) {
    this.cache = cache ?? new ThumbnailCache(new CoverStore(drive))
  }
  private async image(file: FileEntry, signal: AbortSignal) {
    const checked = await this.access.file(file.id, signal, file.content_version)
    if (!isImage(checked.file.name) || checked.file.is_dir) throw new LibraryError('invalid_cover', '封面不再是有效位图')
    const source = new RangeFile(this.drive, checked.file, signal, 8 * MiB)
    try { return await downscaleCover(imageBlob(await source.read(0, checked.file.size, 8 * MiB)).blob, 320, signal) }
    finally { source.destroy() }
  }
  private async nearby(unit: ReadingUnit, directory: FileEntry, signal: AbortSignal): Promise<{ file: FileEntry; origin: 'same-name' | 'directory' | 'first-image' } | undefined> {
    const stem = unit.file.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase()
    let same: FileEntry | undefined, generic: FileEntry | undefined, first: FileEntry | undefined, readable = 0, dirs = 0, count = 0, complete = false, cursor: string | null = null
    const cursors = new Set<string>()
    do {
      const page = await this.access.list(directory.id, cursor, signal)
      if (page.directory.path !== directory.path || page.directory.content_version !== directory.content_version) throw new LibraryError('directory_changed', '封面目录在查找期间变化，请重试')
      for (const file of page.entries) {
        count++
        if (hidden(file.name)) continue
        if (file.is_dir) { dirs++; continue }
        if (unitFormat(file, 'books') || unitFormat(file, 'comics')) readable++
        if (!isImage(file.name)) continue
        const name = file.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase()
        if (name === stem || name === `${stem}.cover`) if (!same || natural(file.name, same.name) < 0) same = file
        if (/^(cover|poster|folder|封面)$/.test(name)) if (!generic || natural(file.name, generic.name) < 0) generic = file
        if (!first || sortCoverCandidates([file.name, first.name])[0] === file.name) first = file
      }
      if (!page.has_more) { complete = true; break }
      if (!page.next_cursor || cursors.has(page.next_cursor)) throw new LibraryError('invalid_cursor', '封面目录分页游标无效')
      cursors.add(page.next_cursor); cursor = page.next_cursor
    } while (count < 10000)
    if (unit.file.is_dir) return generic ? { file: generic, origin: 'directory' } : first ? { file: first, origin: 'first-image' } : undefined
    if (same) return { file: same, origin: 'same-name' }
    // 混放目录的通用 cover 不能套给所有作品；未读完目录也不能推断独立作品。
    if (complete && readable === 1 && dirs === 0 && generic) return { file: generic, origin: 'directory' }
    return undefined
  }
  private async archive(unit: ReadingUnit, signal: AbortSignal): Promise<ThumbnailRecord | undefined> {
    const archive = new Archive(new RangeFile(this.drive, unit.file, signal, unit.format === 'epub' ? LIMITS.epub : LIMITS.archive))
    try {
      await archive.open()
      const metadata = unit.format === 'epub' ? await epubArchiveMetadata(archive, signal) : undefined
      const paths = [...archive.entries].filter(([path, item]) => !item.directory && isImage(path) && !hidden(path)).map(([path]) => path)
      const path = metadata?.coverPath ?? sortCoverCandidates(paths)[0]
      if (!path) return undefined
      const bytes = await archive.read(path, 8 * MiB, signal)
      const url = await downscaleCover(imageBlob(bytes).blob, 320, signal)
      return { url, origin: metadata?.coverPath ? 'embedded' : 'first-image' }
    } finally { archive.destroy() }
  }
  private async pdf(file: FileEntry, signal: AbortSignal): Promise<ThumbnailRecord> {
    if (!this.openPdf) throw new LibraryError('pdf_unsupported', '当前应用不支持 PDF 格式')
    return pdfPreviewTasks.run(signal, async () => {
      const handle = await this.openPdf!(this.drive, file, signal)
      let canvas: HTMLCanvasElement | undefined
      try {
        const page = await handle.document.getPage(1)
        let render: ReturnType<typeof page.render> | undefined
        const stop = () => render?.cancel()
        signal.addEventListener('abort', stop, { once: true })
        try {
          signal.throwIfAborted()
          const size = page.getViewport({ scale: 1 })
          if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) throw new LibraryError('pdf_size', 'PDF 页面尺寸无效')
          const viewport = page.getViewport({ scale: Math.min(1, 320 / Math.max(size.width, size.height)) })
          canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height))
          const context = canvas.getContext('2d')
          if (!context) throw new LibraryError('pdf_canvas', '浏览器无法创建 PDF 封面画布')
          render = page.render({ canvas, canvasContext: context, viewport })
          await render.promise; signal.throwIfAborted()
          const url = canvas.toDataURL('image/jpeg', 0.8)
          if (!isThumbnailUrl(url)) throw new LibraryError('pdf_cover', 'PDF 封面生成失败')
          return { url, origin: 'pdf' }
        } finally { signal.removeEventListener('abort', stop); render?.cancel(); page.cleanup() }
      } finally { if (canvas) { canvas.width = 0; canvas.height = 0 } await handle.destroy() }
    })
  }
  async get(unit: ReadingUnit, signal: AbortSignal): Promise<CoverResource> {
    if (this.paused) throw new LibraryError('library_paused', '阅读馆后台任务已暂停')
    const current = AbortSignal.any([signal, this.controller.signal])
    return coverTasks.run(current, async () => {
      const checked = await this.access.file(unit.nodeId, current, unit.file.content_version), fresh = { ...unit, file: checked.file }
      const directory = fresh.file.is_dir ? fresh.file : await this.drive.files.stat({ path: parentPath(fresh.file.path) }, { signal: current })
      const parent = await this.access.file(directory.id, current, directory.content_version)
      if (!parent.file.is_dir || parent.file.path !== (fresh.file.is_dir ? fresh.file.path : parentPath(fresh.file.path))) throw new LibraryError('directory_changed', '封面目录已变化')
      const key = JSON.stringify(['cover', unit.nodeId, fresh.file.content_version, fresh.file.path, parent.file.id, parent.file.content_version, this.access.identity]), slot = `unit:${unit.nodeId}`
      const verify = async () => {
        const directory = await this.access.file(parent.file.id, current, parent.file.content_version)
        const file = await this.access.file(unit.nodeId, current, fresh.file.content_version)
        if (directory.file.path !== parent.file.path || file.file.path !== fresh.file.path) throw new LibraryError('directory_changed', '封面归属在异步读取期间变化，请重试')
      }
      const cached = await this.cache.get(slot, key, current)
      if (cached) {
        try {
          if (cached.target) {
            const image = await this.access.file(cached.target.id, current, cached.target.contentVersion)
            if (image.file.path !== cached.target.path) throw new LibraryError('cover_changed', '封面位置已改变')
          }
          await verify()
          return lease(cached.url, cached.origin)
        } catch (error) { current.throwIfAborted(); if (isAbort(error)) throw error }
      }
      const warnings: string[] = []
      let result: ThumbnailRecord | undefined
      try {
        const candidate = await this.nearby(fresh, parent.file, current)
        if (candidate) result = { url: await this.image(candidate.file, current), origin: candidate.origin, target: { id: candidate.file.id, contentVersion: candidate.file.content_version, path: candidate.file.path } }
      } catch (error) { current.throwIfAborted(); if (isAbort(error)) throw error; warnings.push(errorMessage(error)) }
      if (!result) {
        try {
          if (['epub', 'cbz', 'zip'].includes(unit.format)) result = await this.archive(fresh, current)
          else if (unit.format === 'pdf') result = await this.pdf(fresh.file, current)
        } catch (error) { current.throwIfAborted(); if (isAbort(error)) throw error; warnings.push(errorMessage(error)) }
      }
      try {
        current.throwIfAborted(); await verify()
        // 先显示，封面库在后台写入；写入失败只是下次重新生成。
        if (result) { void this.cache.set(slot, key, result); return lease(result.url, result.origin, warnings) }
        return lease(null, 'placeholder', warnings)
      } catch (error) { if (result?.url.startsWith('blob:')) URL.revokeObjectURL(result.url); throw error }
    })
  }
  pause() { this.paused = true; this.controller.abort() }
  resume() { if (this.paused) { this.paused = false; this.controller = new AbortController() } }
  destroy() { this.pause(); this.cache.destroy() }
}

export interface LibraryCoverLoader { observe(container: HTMLElement, unit: ReadingUnit): void; clear(): void; destroy(): void }
/** 卡片离开视口即取消；快速重新进入会在旧任务释放并发槽后补发。 */
export class ViewportCoverLoader implements LibraryCoverLoader {
  private jobs = new Map<HTMLElement, { unit: ReadingUnit; visible: boolean; running: boolean; controller?: AbortController; cover?: CoverResource }>()
  private observer: IntersectionObserver
  private disposed = false
  constructor(private service: CoverService, private signal: AbortSignal) {
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement, job = this.jobs.get(target)
        if (!job) continue
        job.visible = entry.isIntersecting
        if (job.visible) void this.load(target)
        else job.controller?.abort()
      }
    }, { rootMargin: '0px' })
    signal.addEventListener('abort', this.stop, { once: true })
  }
  private stop = () => this.destroy()
  observe(container: HTMLElement, unit: ReadingUnit) {
    if (this.disposed || this.signal.aborted) return
    const previous = this.jobs.get(container)
    previous?.controller?.abort(); previous?.cover?.release()
    container.style.backgroundImage = ''; container.classList.remove('has-cover')
    this.jobs.set(container, { unit, visible: false, running: false }); this.observer.observe(container)
  }
  private async load(container: HTMLElement) {
    const job = this.jobs.get(container)
    if (!job || job.running || job.cover || !job.visible || this.disposed || this.signal.aborted) return
    job.running = true; job.controller = new AbortController()
    const signal = AbortSignal.any([this.signal, job.controller.signal])
    try {
      const cover = await this.service.get(job.unit, signal)
      if (signal.aborted || this.jobs.get(container) !== job) { cover.release(); return }
      job.cover = cover
      if (cover.url) { container.style.backgroundImage = `url("${cover.url}")`; container.classList.add('has-cover') }
    } catch { /* 损坏封面保留文字占位；详情可以显式显示同一服务返回的告警。 */ }
    finally {
      job.running = false
      if (signal.aborted && job.visible && this.jobs.get(container) === job && !this.disposed) void this.load(container)
    }
  }
  clear() { this.observer.disconnect(); for (const [container, job] of this.jobs) { job.controller?.abort(); job.cover?.release(); container.style.backgroundImage = ''; container.classList.remove('has-cover') } this.jobs.clear() }
  destroy() { if (this.disposed) return; this.disposed = true; this.clear(); this.signal.removeEventListener('abort', this.stop) }
}
