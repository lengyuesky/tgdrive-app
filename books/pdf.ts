/** PDF 正文与缩略图复用受控 legacy 文档适配器，不开放网络、文字层或嵌套页面。 */
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { MiB, isAbort } from '../reader/io'
import { openPdfDocument, type PdfDocumentHandle } from '../reader/library/pdf-document'
import { pdfPreviewTasks } from '../reader/library/cache'
import { boundedIndex, canvasThumbnail, contentSize, sectionState, type ReaderView, type Section, type ViewContext, type NavigationItem, type ReaderThumbnail } from '../reader/view'
import { preferences, zoomLevels, type Location, type Preferences } from '../reader/state'

export class PdfReader implements ReaderView {
  title: string
  sections: Section[] = []
  navigation: NavigationItem[] = []
  readonly capabilities = { fits: ['width', 'page'], zoomLevels, pan: true, thumbnails: true } as const
  private handle?: PdfDocumentHandle
  private preparation?: Promise<void>
  private outline?: Promise<void>
  private render?: RenderTask
  private index = 0
  private requestedIndex = 0
  private initialized = false
  private generation = 0
  private busy = false
  private stopped = false
  private canvas?: HTMLCanvasElement
  private resize: ResizeObserver
  private resizeTimer?: ReturnType<typeof setTimeout>
  private width: number
  private height: number
  private lifetime = new AbortController()
  private signal: AbortSignal
  constructor(private context: ViewContext) {
    this.title = context.file.name
    this.signal = AbortSignal.any([context.signal, this.lifetime.signal])
    context.viewport.dataset.format = 'pdf'
    this.width = context.viewport.clientWidth; this.height = context.viewport.clientHeight
    this.resize = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = context.viewport
      if (width === this.width && height === this.height) return
      this.width = width; this.height = height
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        if (this.initialized && !this.signal.aborted) void this.renderPage(this.requestedIndex, true).catch(error => this.report(error))
      }, 180)
    })
    this.resize.observe(context.viewport)
    context.viewport.addEventListener('scroll', this.onScroll, { passive: true })
    context.signal.addEventListener('abort', this.onAbort, { once: true })
  }
  private prepareOnce() {
    return this.preparation ??= (async () => {
      this.signal.throwIfAborted()
      const handle = await openPdfDocument(this.context.drive, this.context.file, this.signal)
      if (this.signal.aborted) { await handle.destroy(); this.signal.throwIfAborted() }
      this.handle = handle
      this.sections = Array.from({ length: handle.document.numPages }, (_, i) => ({ label: `第 ${i + 1} 页` }))
      const metadata = await handle.document.getMetadata().catch(() => null)
      this.signal.throwIfAborted()
      const title = (metadata?.info as { Title?: unknown } | undefined)?.Title
      if (typeof title === 'string' && title.trim()) this.title = title.trim().slice(0, 160)
    })().catch(error => { this.destroy(); throw error })
  }
  async loadNavigation(): Promise<NavigationItem[]> {
    await this.prepareOnce(); this.signal.throwIfAborted()
    this.outline ??= (async () => {
      const document = this.handle!.document, outline = await document.getOutline().catch(() => null)
      this.signal.throwIfAborted()
      const navigation: NavigationItem[] = []
      // 只解析目录目标页树，不调用 getPage，也不读取页面正文和图像。
      const walk = async (items: NonNullable<typeof outline>, depth = 0) => {
        if (depth > 16) return
        for (const item of items) {
          this.signal.throwIfAborted()
          if (navigation.length >= 1000) return
          try {
            const dest = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
            this.signal.throwIfAborted()
            if (dest?.length) {
              const index = typeof dest[0] === 'number' ? dest[0] : await document.getPageIndex(dest[0])
              this.signal.throwIfAborted()
              if (Number.isSafeInteger(index) && index >= 0 && index < this.sections.length) navigation.push({ label: item.title.slice(0, 120), depth, location: { format: 'pdf', index } })
            }
          } catch (error) { if (this.signal.aborted || isAbort(error)) throw error }
          await walk(item.items, depth + 1)
        }
      }
      if (outline) await walk(outline)
      this.signal.throwIfAborted(); this.navigation = navigation
    })().catch(error => { this.destroy(); throw error })
    await this.outline; this.signal.throwIfAborted()
    return structuredClone(this.navigation.length ? this.navigation : this.sections.map((section, index) => ({ label: section.label, depth: 0, location: { format: 'pdf' as const, index } })))
  }
  async open(location?: Location) {
    await this.loadNavigation()
    await this.restore(location?.format === 'pdf' ? location : { format: 'pdf', index: 0 })
    this.signal.throwIfAborted(); this.initialized = true
  }
  current(): Location { return { format: 'pdf', index: this.index } }
  navigationState() {
    const viewport = this.context.viewport, box = viewport.getBoundingClientRect()
    const bottom = box.bottom - (parseFloat(getComputedStyle(viewport).paddingBottom) || 0)
    const atEnd = !this.stopped && !this.busy && !!this.canvas && this.index === this.sections.length - 1 && this.canvas.getBoundingClientRect().bottom <= bottom + 1
    return { ...sectionState(this.index, this.sections.length), pageIndex: this.index, pageCount: this.sections.length, atEnd }
  }
  turn(delta: -1 | 1) { return this.go(this.index + delta) }
  go(index: number) { return this.renderPage(index, false) }
  private async renderPage(index: number, preservePan: boolean) {
    if (!this.handle || this.stopped) return
    const active = ++this.generation, previous = this.render
    this.busy = true; previous?.cancel()
    await previous?.promise.catch(() => {})
    this.signal.throwIfAborted()
    if (active !== this.generation) return
    const selected = boundedIndex(index, this.sections.length), viewportElement = this.context.viewport
    this.requestedIndex = selected
    const pan = preservePan && selected === this.index ? {
      x: viewportElement.scrollLeft / Math.max(1, viewportElement.scrollWidth - viewportElement.clientWidth),
      y: viewportElement.scrollTop / Math.max(1, viewportElement.scrollHeight - viewportElement.clientHeight),
    } : { x: 0, y: 0 }
    let page: PDFPageProxy | undefined, canvas: HTMLCanvasElement | undefined, task: RenderTask | undefined, committed = false
    try {
      page = await this.handle.document.getPage(selected + 1)
      this.signal.throwIfAborted()
      if (active !== this.generation) return
      const natural = page.getViewport({ scale: 1 }), available = contentSize(viewportElement), prefs = preferences(this.context.prefs)
      if (![natural.width, natural.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('PDF 页面尺寸无效')
      const fit = this.context.prefs.fit === 'page' ? Math.min(available.width / natural.width, available.height / natural.height) : available.width / natural.width
      const viewport = page.getViewport({ scale: fit * prefs.zoom })
      if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('PDF 页面尺寸无效')
      const density = Math.min(globalThis.devicePixelRatio || 1, 2, Math.sqrt(16 * MiB / (4 * viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height)
      canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width * density)); canvas.height = Math.max(1, Math.floor(viewport.height * density))
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute('aria-label', `PDF 第 ${selected + 1} 页`)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法创建 PDF 画布')
      this.render = task = page.render({ canvas, canvasContext: context, viewport, transform: [density, 0, 0, density, 0, 0] })
      await task.promise; this.signal.throwIfAborted()
      if (active === this.generation) {
        if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0 }
        this.canvas = canvas; this.index = selected; committed = true
        viewportElement.replaceChildren(canvas)
        viewportElement.scrollTop = pan.y * Math.max(0, viewportElement.scrollHeight - viewportElement.clientHeight)
        viewportElement.scrollLeft = pan.x * Math.max(0, viewportElement.scrollWidth - viewportElement.clientWidth)
      }
    } catch (error) {
      if (this.signal.aborted) this.signal.throwIfAborted()
      if ((error as Error).name !== 'RenderingCancelledException') throw error
    } finally {
      page?.cleanup()
      if (!committed && canvas) { canvas.width = 0; canvas.height = 0 }
      if (this.render === task) this.render = undefined
      if (active === this.generation) {
        if (!committed) this.requestedIndex = this.index
        this.busy = false; if (!this.signal.aborted) this.context.changed()
      }
    }
  }
  async thumbnail(index: number, caller: AbortSignal): Promise<ReaderThumbnail> {
    const signal = AbortSignal.any([this.signal, caller])
    signal.throwIfAborted()
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.sections.length) throw new Error('PDF 缩略图页码无效，请先读取目录')
    return pdfPreviewTasks.run(signal, async () => {
      // 独立文档避免 thumbnail 的 page.cleanup 或取消干扰正文渲染；全局仅一个 PDF 预览。
      const handle = await openPdfDocument(this.context.drive, this.context.file, signal)
      let page: PDFPageProxy | undefined, render: RenderTask | undefined, result: ReaderThumbnail | undefined
      const canvas = document.createElement('canvas'), abort = () => render?.cancel()
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted(); page = await handle.document.getPage(index + 1); signal.throwIfAborted()
        const natural = page.getViewport({ scale: 1 })
        if (![natural.width, natural.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('PDF 缩略图尺寸无效')
        const viewport = page.getViewport({ scale: Math.min(1, 320 / natural.width, 320 / natural.height) })
        canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建 PDF 缩略图画布')
        render = page.render({ canvas, canvasContext: context, viewport })
        await render.promise; signal.throwIfAborted()
        result = await canvasThumbnail(canvas, signal)
      } catch (error) { if (signal.aborted) signal.throwIfAborted(); throw error }
      finally {
        signal.removeEventListener('abort', abort); page?.cleanup(); canvas.width = 0; canvas.height = 0; await handle.destroy()
      }
      signal.throwIfAborted()
      return result!
    })
  }
  pan(x: number, y: number) {
    if (this.stopped || !Number.isFinite(x) || !Number.isFinite(y)) return
    const viewport = this.context.viewport
    viewport.scrollLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + x))
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + y))
    this.onScroll()
  }
  private onScroll = () => { if (this.initialized && !this.busy && !this.signal.aborted) this.context.changed() }
  private onAbort = () => this.destroy()
  async restore(location: Location) { await this.go(location.index) }
  async configure(prefs: Preferences) { this.context.prefs = prefs; await this.renderPage(this.requestedIndex, true) }
  private report(error: unknown) { if (!isAbort(error) && !this.signal.aborted) this.context.error(error) }
  destroy() {
    if (this.stopped) return
    this.stopped = true; this.generation++; this.render?.cancel(); this.lifetime.abort(); this.resize.disconnect(); clearTimeout(this.resizeTimer)
    this.context.viewport.removeEventListener('scroll', this.onScroll); this.context.signal.removeEventListener('abort', this.onAbort)
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0 }
    void this.handle?.destroy()
  }
}
