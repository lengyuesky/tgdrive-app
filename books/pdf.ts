/** PDF.js 使用主线程解析和自定义 Range，不给沙箱开放网络或嵌套页面。 */
import { getDocument, PDFDataRangeTransport, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist'
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'
import { gate, LIMITS, MiB, RangeFile, isAbort } from '../reader/io'
import { boundedIndex, contentSize, sectionState, type ReaderView, type Section, type ViewContext, type NavigationItem } from '../reader/view'
import type { Location, Preferences } from '../reader/state'
;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler }
export class PdfReader implements ReaderView {
  title: string
  sections: Section[] = []
  navigation: NavigationItem[] = []
  private source: RangeFile
  private document?: PDFDocumentProxy
  private task?: PDFDocumentLoadingTask
  private render?: RenderTask
  private index = 0
  private requestedIndex = 0
  private initialized = false
  private generation = 0
  private canvas?: HTMLCanvasElement
  private resize: ResizeObserver
  private resizeTimer?: ReturnType<typeof setTimeout>
  private width = 0
  constructor(private context: ViewContext) {
    this.title = context.file.name
    context.viewport.dataset.format = 'pdf'
    this.source = new RangeFile(context.drive, context.file, context.signal, LIMITS.pdf)
    this.width = context.viewport.clientWidth
    this.resize = new ResizeObserver(() => {
      const width = context.viewport.clientWidth
      if (width === this.width) return
      this.width = width
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => { if (this.initialized && !context.signal.aborted) void this.go(this.requestedIndex).catch(context.error) }, 180)
    })
    this.resize.observe(context.viewport)
  }
  async open(location?: Location) {
    const source = this.source, owner = this
    class Transport extends PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        void source.read(begin, end - begin).then((bytes) => { if (!source.signal.aborted) this.onDataRange(begin, bytes) }).catch((error) => {
          if (!isAbort(error)) { owner.context.error(error); void owner.task?.destroy() }
        })
      }
      abort() { source.destroy() }
    }
    class Resources {
      async fetch({ kind, filename }: { kind: string; filename: string }) {
        const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
        if (!directory || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) throw new Error('PDF 请求了不允许的资源')
        return gate.run(source.signal, () => owner.context.drive.assets.read(`${directory}/${filename}`, { signal: source.signal }))
      }
    }
    this.task = getDocument({ range: new Transport(source.file.size, new Uint8Array(), true),
      rangeChunkSize: MiB, disableAutoFetch: true, disableStream: true, useWorkerFetch: false, useWasm: false,
      disableFontFace: true, useSystemFonts: false, enableXfa: false, isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false, maxImageSize: LIMITS.pixels, canvasMaxAreaInBytes: 32 * MiB,
      BinaryDataFactory: Resources, stopAtErrors: true,
    })
    try { this.document = await this.task.promise }
    catch (error) { if ((error as Error).name === 'PasswordException') throw new Error('首版不支持密码保护的 PDF'); throw error }
    if (this.document.numPages > 10000) throw new Error('PDF 超过 10000 页')
    this.sections = Array.from({ length: this.document.numPages }, (_, i) => ({ label: `第 ${i + 1} 页` }))
    const metadata = await this.document.getMetadata().catch(() => null)
    const title = (metadata?.info as { Title?: unknown } | undefined)?.Title
    if (typeof title === 'string' && title.trim()) this.title = title.trim().slice(0, 160)
    await this.restore(location?.format === 'pdf' ? location : { format: 'pdf', index: 0 })
    // 目录只解析目标页树，不预取各页的正文和图像。
    const outline = await this.document.getOutline().catch(() => null)
    const walk = async (items: NonNullable<typeof outline>, depth = 0) => {
      if (depth > 16) return
      for (const item of items) {
        if (this.navigation.length >= 1000 || source.signal.aborted) return
        try {
          const dest = typeof item.dest === 'string' ? await this.document!.getDestination(item.dest) : item.dest
          if (dest?.length) {
            const index = typeof dest[0] === 'number' ? dest[0] : await this.document!.getPageIndex(dest[0])
            if (index >= 0 && index < this.sections.length) this.navigation.push({ label: `${'　'.repeat(Math.min(depth, 3))}${item.title.slice(0, 120)}`, location: { format: 'pdf', index } })
          }
        } catch { /* 无效的目录目标不阻止阅读。 */ }
        await walk(item.items, depth + 1)
      }
    }
    if (outline) await walk(outline)
    const expectedWidth = contentSize(this.context.viewport).width * this.context.prefs.zoom
    if (this.canvas && Math.abs(parseFloat(this.canvas.style.width) - expectedWidth) > 1) await this.go(this.requestedIndex)
    this.initialized = true
    this.context.changed()
  }
  current(): Location { return { format: 'pdf', index: this.index } }
  navigationState() { return { ...sectionState(this.index, this.sections.length), pageIndex: this.index, pageCount: this.sections.length } }
  turn(delta: -1 | 1) { return this.go(this.index + delta) }
  async go(index: number) {
    if (!this.document) return
    const active = ++this.generation
    this.render?.cancel()
    // 等旧渲染任务释放，保留已成功显示的页，失败的新页不能覆盖阅读进度。
    await this.render?.promise.catch(() => {})
    this.context.signal.throwIfAborted()
    if (active !== this.generation) return
    const selected = boundedIndex(index, this.sections.length)
    this.requestedIndex = selected
    const page = await this.document.getPage(selected + 1)
    if (active !== this.generation || this.context.signal.aborted) { page.cleanup(); return }
    const natural = page.getViewport({ scale: 1 })
    const width = contentSize(this.context.viewport).width * this.context.prefs.zoom
    const scale = width / natural.width
    const viewport = page.getViewport({ scale })
    if (![viewport.width, viewport.height].every((v) => Number.isFinite(v) && v > 0)) throw new Error('PDF 页面尺寸无效')
    const density = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16 * MiB / (4 * viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width * density)); canvas.height = Math.max(1, Math.floor(viewport.height * density))
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute('aria-label', `PDF 第 ${selected + 1} 页`)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建 PDF 画布')
    let committed = false
    try {
      this.render = page.render({ canvas, canvasContext: context, viewport, transform: [density, 0, 0, density, 0, 0] })
      await this.render.promise
      if (active === this.generation && !this.context.signal.aborted) {
        if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0 }
        this.canvas = canvas; this.index = selected; committed = true
        this.context.viewport.replaceChildren(canvas); this.context.viewport.scrollTop = 0
        this.context.changed()
      }
    } catch (error) { if ((error as Error).name !== 'RenderingCancelledException') throw error }
    finally { page.cleanup(); if (!committed) { canvas.width = 0; canvas.height = 0 } }
  }
  async restore(location: Location) { await this.go(location.index) }
  async configure(prefs: Preferences) { this.context.prefs = prefs; await this.go(this.index) }
  destroy() {
    this.generation++; this.render?.cancel(); this.source.destroy(); this.resize.disconnect(); clearTimeout(this.resizeTimer)
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0 }
    void this.task?.destroy().catch(() => {})
  }
}
