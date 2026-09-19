/** 漫画只挂载相邻五页，滚动轨道限定在相邻四十一页以避免超长 CSS 溢出。 */
import { Archive } from '../reader/archive'
import { LIMITS, RangeFile, isAbort, isImage, natural } from '../reader/io'
import { imageBlob, imageInfo } from '../reader/image'
import { coverTasks } from '../reader/library/cache'
import { PictureWindow, PICTURE_COST_LIMIT, pictureCost } from '../reader/pictures'
import { ComicPreloader } from './preload'
import { boundedIndex, canvasThumbnail, contentSize, frame, sectionState, type ReaderView, type ReaderThumbnail, type Section, type ViewContext } from '../reader/view'
import { zoomLevels, type Location, type Preferences } from '../reader/state'
import type { FileEntry } from '../sdk/types'
interface ComicPage { name: string; entry: string; file?: FileEntry }
interface Dimensions { width: number; height: number }
interface ScrollAnchor { location: Location; offset: number; proportional: boolean }
type ComicMode = 'scroll' | 'single' | 'double'
const spreadCandidates = (index: number, count: number, prefs: Pick<Preferences, 'coverAlone' | 'spreadOffset'>) => {
  const selected = boundedIndex(index, count), start = (prefs.coverAlone !== false ? 1 : 0) + (prefs.spreadOffset === 1 ? 1 : 0)
  const first = selected < start ? selected : start + Math.floor((selected - start) / 2) * 2
  return first < start || first + 1 >= count ? [first] : [first, first + 1]
}
/** 固定物理配对；横图使候选两页分别独立，不顺延后续奇偶，也不预扫整章。 */
export function comicSpread(index: number, count: number, prefs: Pick<Preferences, 'coverAlone' | 'spreadOffset'>, dimensions: ReadonlyMap<number, Dimensions>): number[] {
  const candidates = spreadCandidates(index, count, prefs)
  const cost = candidates.reduce((total, page) => { const size = dimensions.get(page); return total + (size ? pictureCost(size.width, size.height) : 0) }, 0)
  return cost <= PICTURE_COST_LIMIT && candidates.every(page => { const size = dimensions.get(page); return size && size.width <= size.height }) ? candidates : [boundedIndex(index, count)]
}
export class ComicReader implements ReaderView {
  title: string
  sections: Section[] = []
  readonly capabilities = { modes: ['scroll', 'single', 'double'], fits: ['width', 'page'], zoomLevels, pan: true, direction: true, spreads: true, thumbnails: true } as const
  private pages: ComicPage[] = []
  private archive?: Archive
  private heights: number[] = []
  private dimensions = new Map<number, Dimensions>()
  private index = 0
  private trackFirst = 0
  private trackEnd = 0
  private root = document.createElement('div')
  private before = document.createElement('div')
  private after = document.createElement('div')
  private nodes = new Map<number, HTMLElement>()
  private pictures?: PictureWindow
  private preloader?: ComicPreloader
  private observer: ResizeObserver
  private rendering = false
  private stopped = false
  private generation = 0
  private width = 0
  private height = 0
  private layoutWidth = 0
  private anchor: Location = { format: 'comic', index: 0, ratio: 0 }
  private restoreTarget?: Location
  private scrollPosition = 0
  private scrollFrame?: number
  private progressTimer?: ReturnType<typeof setTimeout>
  private renderedMode: ComicMode = 'scroll'
  private spread: number[] = []
  private layoutNotice?: string
  private pageRatio = 0
  private layoutFit: 'width' | 'page' = 'width'
  private layoutZoom = 1
  private layoutHeight = 0
  private lifetime = new AbortController()
  private navigationController = new AbortController()
  private pendingWindow?: { location: Location; mode: ComicMode }
  private signal: AbortSignal
  constructor(private context: ViewContext) {
    this.title = context.file.name
    this.signal = AbortSignal.any([context.signal, this.lifetime.signal])
    this.root.className = 'comic-track'
    this.root.addEventListener('load', this.publish, true)
    context.signal.addEventListener('abort', this.onAbort, { once: true })
    context.viewport.addEventListener('scroll', this.onScroll, { passive: true })
    this.width = context.viewport.clientWidth; this.height = context.viewport.clientHeight
    this.observer = new ResizeObserver(() => this.measure())
    this.observer.observe(context.viewport)
  }
  private get requestedMode(): ComicMode { return this.context.prefs.mode === 'double' ? 'double' : this.context.prefs.mode === 'page' || this.context.prefs.mode === 'single' ? 'single' : 'scroll' }
  private get effectiveMode(): ComicMode { return this.requestedMode === 'double' && this.context.viewport.clientWidth <= this.context.viewport.clientHeight ? 'single' : this.requestedMode }
  private get continuous() { return this.renderedMode === 'scroll' }
  private get fit() { return this.context.prefs.fit ?? (this.context.prefs.mode === 'page' ? 'page' : 'width') }
  private get zoom() { return Math.max(.5, Math.min(3, Number.isFinite(this.context.prefs.zoom) ? this.context.prefs.zoom : 1)) }
  async open(location?: Location) {
    const { drive, file } = this.context, signal = this.signal
    signal.throwIfAborted()
    if (file.is_dir) {
      let cursor: string | null = null
      do {
        const page = await drive.files.list({ path: file.path, limit: 500, cursor }, { signal })
        signal.throwIfAborted()
        for (const image of page.entries) if (!image.is_dir && isImage(image.name) && !image.name.startsWith('.')) this.pages.push({ name: image.name, entry: String(image.id), file: image })
        if (this.pages.length > LIMITS.entries) throw new Error('图片章节超过 10000 页，请按章节拆分目录')
        cursor = page.next_cursor
      } while (cursor)
    } else {
      this.archive = await new Archive(new RangeFile(drive, file, signal, LIMITS.archive)).open()
      for (const [path, item] of this.archive.entries) if (!item.directory && isImage(path) && !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')) this.pages.push({ name: path, entry: path })
    }
    signal.throwIfAborted()
    this.pages.sort((a, b) => natural(a.name, b.name) || natural(a.entry, b.entry))
    if (!this.pages.length) throw new Error('此目录或压缩包中没有支持的漫画图片')
    this.sections = this.pages.map((page, i) => ({ label: `${i + 1} · ${page.name}`, entry: page.entry }))
    this.heights = this.pages.map(() => Math.min(1500, Math.max(240, this.context.viewport.clientWidth * 1.45)))
    this.preloader = new ComicPreloader({
      pages: this.pages, archive: this.archive, drive: this.context.drive,
      signal: this.signal, ahead: 3, behind: 2, maxCache: 12, concurrency: 2,
      error: this.context.error,
    })
    this.context.viewport.replaceChildren(this.root)
    await this.restore(location?.format === 'comic' ? location : { format: 'comic', index: 0 })
  }
  private sum(from: number, to: number) { let value = 0; for (let i = from; i < to; i++) value += this.heights[i] ?? 0; return value }
  private bottomPadding() { return this.continuous && this.trackEnd === this.pages.length ? Math.max(0, this.context.viewport.clientHeight - (this.heights.at(-1) ?? 0)) : 0 }
  current(): Location {
    const scroll = this.context.viewport.scrollTop
    // 未知尺寸的末页可能暂时无法滚到目标比例，不能用占位布局覆盖已保存的进度。
    if (this.restoreTarget && Math.abs(scroll - this.scrollPosition) < .5) return { ...this.restoreTarget, entry: this.pages[this.restoreTarget.index]?.entry }
    let index = this.trackFirst, top = 0
    if (this.continuous) {
      while (index < this.trackEnd - 1 && top + this.heights[index]! <= scroll + 1) {
        top += this.heights[index]!
        index++
      }
    } else {
      index = this.index
    }
    return { format: 'comic', index, entry: this.pages[index]?.entry, ratio: this.continuous ? Math.min(1, Math.max(0, (scroll - top) / Math.max(1, this.heights[index] ?? 1))) : this.pageRatio }
  }
  navigationState() {
    const index = this.current().index, first = this.continuous ? index : this.spread[0] ?? index, last = this.continuous ? index : this.spread.at(-1) ?? index
    return { ...sectionState(index, this.sections.length), pageIndex: index, pageCount: this.sections.length,
      canPrevious: first > 0, canNext: last < this.sections.length - 1, visiblePages: this.continuous ? undefined : [...this.spread], effectiveMode: this.renderedMode, layoutNotice: this.layoutNotice, atEnd: this.atEnd(last) }
  }
  private atEnd(last: number) {
    if (this.stopped || this.rendering || !this.pages.length || last !== this.pages.length - 1 || this.trackEnd !== this.pages.length) return false
    const visible = this.continuous ? [last] : this.spread
    if (visible.some(index => { const image = this.nodes.get(index)?.querySelector('img'); return !image?.complete || !image.naturalWidth })) return false
    const viewport = this.context.viewport, bottom = viewport.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(viewport).paddingBottom) || 0)
    return this.nodes.get(last)!.querySelector('img')!.getBoundingClientRect().bottom <= bottom + 1
  }
  private snapshot(location: Location, proportional: boolean): ScrollAnchor {
    return { location, proportional, offset: (location.ratio ?? 0) * (this.heights[location.index] ?? 0) }
  }
  private capture(resized = false) {
    if (!resized && Math.abs(this.context.viewport.scrollTop - this.scrollPosition) >= .5) this.restoreTarget = undefined
    return this.snapshot(this.restoreTarget ?? (resized ? this.anchor : this.current()), resized || !!this.restoreTarget)
  }
  private syncScroll(top: number) {
    const viewport = this.context.viewport
    // 相同坐标也不能重复赋值：部分浏览器会因此中断触摸惯性滚动。
    if (Math.abs(viewport.scrollTop - top) >= .5) viewport.scrollTop = top
    this.scrollPosition = viewport.scrollTop
  }
  private publish = () => {
    clearTimeout(this.progressTimer); this.progressTimer = undefined
    if (!this.stopped) this.context.changed()
  }
  private scheduleProgress() {
    // 页码立即更新；页内进度最多每 120ms 更新一次，避免每帧重写菜单和序列化进度。
    if (this.progressTimer === undefined && !this.stopped) this.progressTimer = setTimeout(this.publish, 120)
  }
  turn(delta: -1 | 1) {
    const state = this.navigationState()
    if (delta < 0 ? !state.canPrevious : !state.canNext) return Promise.resolve()
    const index = this.continuous ? this.current().index : delta > 0 ? this.spread.at(-1) ?? this.index : this.spread[0] ?? this.index
    return this.go(index + delta)
  }
  private async prepareSpread(index: number, signal: AbortSignal) {
    await Promise.all(spreadCandidates(index, this.pages.length, this.context.prefs).map(async selected => {
      if (this.dimensions.has(selected)) return
      try {
        const bytes = await this.preloader!.get(selected, signal)
        signal.throwIfAborted()
        this.dimensions.set(selected, imageInfo(bytes))
      } catch (error) {
        if (signal.aborted || isAbort(error)) throw error
        // 损坏或未知尺寸先单页显示，不跳过相邻物理页；下载失败由预加载器报告。
        if (this.preloader!.has(selected)) this.context.error(error)
      }
    }))
    signal.throwIfAborted()
    return comicSpread(index, this.pages.length, this.context.prefs, this.dimensions)
  }
  private async window(index: number, ratio: number, programmatic = false) {
    if (this.stopped) return
    const active = ++this.generation, selected = boundedIndex(index, this.pages.length), mode = this.effectiveMode
    this.navigationController.abort(); this.navigationController = new AbortController()
    const signal = AbortSignal.any([this.signal, this.navigationController.signal])
    const location: Location = { format: 'comic', index: selected, ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0 }
    this.pendingWindow = { location, mode }
    this.rendering = true; this.preloader?.setCenter(selected)
    let spread = [selected]
    try { if (mode === 'double') spread = await this.prepareSpread(selected, signal); signal.throwIfAborted() }
    catch (error) { if (active === this.generation) { this.rendering = false; this.pendingWindow = undefined }; throw error }
    if (active !== this.generation) return
    this.pendingWindow = undefined
    const candidates = spreadCandidates(selected, this.pages.length, this.context.prefs)
    this.layoutNotice = mode === 'double' && spread.length === 1 && candidates.length === 2
      && candidates.every(index => { const size = this.dimensions.get(index); return size && size.width <= size.height })
      ? '当前双页图片超过内存预算，暂按单页显示' : undefined
    this.index = selected; this.spread = spread; this.renderedMode = mode
    this.pageRatio = location.ratio!
    const anchor = this.snapshot(location, programmatic)
    if (programmatic) this.restoreTarget = location
    const continuous = this.continuous
    this.context.viewport.dataset.format = 'comic'; this.context.viewport.dataset.comicMode = mode
    this.context.viewport.dataset.mode = this.context.prefs.mode; this.context.viewport.dataset.fit = this.fit
    this.root.dataset.mode = mode
    this.root.style.display = continuous ? '' : 'flex'
    this.root.style.flexDirection = continuous ? '' : this.context.prefs.direction === 'rtl' ? 'row-reverse' : 'row'
    this.before.style.display = this.after.style.display = continuous ? '' : 'none'
    if (continuous) { this.root.style.height = ''; this.root.style.marginTop = '' }
    // 挂载窗口可以逐页移动，轨道只在接近边界时换段，普通跨页不改变原生滚动坐标。
    const nearStart = this.trackFirst > 0 && this.index < this.trackFirst + 4
    // 短图可能一屏容纳多页，不能等到固定的末四页才扩展，否则会先碰到滚动底部。
    const nearEnd = this.trackEnd < this.pages.length && (this.index >= this.trackEnd - 4 || this.sum(this.index, this.trackEnd) < this.context.viewport.clientHeight * 2)
    if (!continuous) {
      this.trackFirst = spread[0]!; this.trackEnd = spread.at(-1)! + 1
    } else if (programmatic || nearStart || nearEnd) {
      this.trackFirst = Math.max(0, this.index - 20)
      this.trackEnd = Math.min(this.pages.length, this.index + 21)
    }
    const first = continuous ? Math.max(0, this.index - 2) : spread[0]!
    const last = continuous ? Math.min(this.pages.length, this.index + 3) : spread.at(-1)! + 1
    if (this.before.parentElement !== this.root) this.root.prepend(this.before)
    if (this.after.parentElement !== this.root) this.root.append(this.after)
    for (const [key, node] of this.nodes) {
      if (key < first || key >= last) {
        this.observer.unobserve(node)
        node.remove()
        this.nodes.delete(key)
      }
    }
    let refNode: Node = this.after
    for (let i = last - 1; i >= first; i--) {
      let node = this.nodes.get(i)
      if (!node) {
        node = document.createElement('figure')
        node.className = 'comic-page'
        node.dataset.index = String(i)
        node.style.minHeight = `${this.heights[i]!}px`
        const image = document.createElement('img'), label = document.createElement('figcaption')
        image.dataset.resource = String(i)
        image.alt = this.pages[i]!.name
        image.decoding = 'async'
        const size = this.dimensions.get(i)
        if (size) {
          // Blob 与 DOM 可以回收，已知尺寸必须保留，回看长图时不能退回普通页骨架。
          image.width = size.width; image.height = size.height
          image.style.width = `${size.width}px`; image.style.minHeight = '0'
          image.style.aspectRatio = `${size.width} / ${size.height}`
        } else image.style.aspectRatio = '1 / 1.45'
        label.textContent = this.sections[i]!.label
        node.append(image, label)
        this.nodes.set(i, node)
        this.observer.observe(node)
      }
      if (node.nextSibling !== refNode || node.parentElement !== this.root) this.root.insertBefore(node, refNode)
      refNode = node
    }
    if (!this.pictures) this.pictures = new PictureWindow(this.context.viewport, this.root, this.signal, async (image, signal) => {
      const index = Number(image.dataset.resource)
      return this.preloader ? this.preloader.get(index, signal) : Promise.reject(new Error('预加载器未初始化'))
    }, this.context.error, (mutate) => {
      if (this.stopped) return
      // 必须在图片改尺寸、浏览器截断 scrollTop 之前捕获位置；实时阅读保留像素偏移。
      const anchor = this.capture()
      mutate()
      this.measure(anchor)
    }, { maxVisible: 5, verticalMargin: 2 })
    else this.pictures.update(this.root)
    this.rendering = false
    if (!continuous && programmatic) { this.context.viewport.scrollLeft = 0; this.syncScroll(0) }
    this.measure(anchor)
    if (active !== this.generation) return
    if (!continuous && programmatic) this.syncScroll(this.pageRatio * (parseFloat(this.nodes.get(this.index)?.querySelector('img')?.style.height ?? '') || 0))
    this.publish()
    if (programmatic) {
      await frame()
      if (this.stopped || active !== this.generation) return
      this.measure()
      this.publish()
    }
  }
  private availableWidth(width = this.context.viewport.clientWidth) {
    const style = getComputedStyle(this.context.viewport)
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    return Math.max(200, Math.max(40, width - padding) * this.zoom)
  }
  private updateSpacers() {
    const keys = [...this.nodes.keys()], continuous = this.continuous
    const before = continuous && keys.length ? this.sum(this.trackFirst, Math.min(...keys)) : 0
    const after = continuous && keys.length ? this.sum(Math.max(...keys) + 1, this.trackEnd) + this.bottomPadding() : 0
    if (this.before.style.height !== `${before}px`) this.before.style.height = `${before}px`
    if (this.after.style.height !== `${after}px`) this.after.style.height = `${after}px`
  }
  private scaledSize(size: Dimensions, width: number, height: number, fit = this.fit, zoom = this.zoom): Dimensions {
    const scale = Math.min(1, width / size.width, fit === 'page' ? height / size.height : Infinity) * zoom
    return { width: Math.min(196605, size.width * scale), height: Math.min(196605, size.height * scale) }
  }
  private measurePaged() {
    const viewport = this.context.viewport, available = contentSize(viewport), slot = available.width / Math.max(1, this.spread.length)
    let totalWidth = 0, totalHeight = 0
    for (const [index, node] of this.nodes) {
      const image = node.querySelector('img')!, width = Number(image.getAttribute('width')), height = Number(image.getAttribute('height'))
      if (width > 0 && height > 0) this.dimensions.set(index, { width, height })
      const size = this.scaledSize(this.dimensions.get(index) ?? { width: slot, height: slot * 1.45 }, slot, available.height)
      image.style.width = node.style.width = `${size.width}px`; image.style.height = node.style.height = `${size.height}px`
      node.style.minHeight = ''; node.style.flex = '0 0 auto'
      totalWidth += size.width; totalHeight = Math.max(totalHeight, size.height)
    }
    this.root.style.width = `${totalWidth}px`; this.root.style.height = `${totalHeight}px`
    this.root.style.setProperty('--comic-track-width', `${totalWidth}px`)
    this.root.style.setProperty('--comic-track-height', `${totalHeight}px`)
    this.root.style.marginTop = `${Math.max(0, (available.height - totalHeight) / 2)}px`
    this.width = viewport.clientWidth; this.height = viewport.clientHeight
    this.updateSpacers()
    if (this.restoreTarget && this.dimensions.has(this.restoreTarget.index)) this.restoreTarget = undefined
    this.anchor = this.current()
  }
  private measure(forced?: ScrollAnchor) {
    if (this.stopped || !this.pages.length) return
    if (this.rendering) {
      // 横竖屏切换不等待旧双页候选的慢尺寸，沿同一物理目标取消并回退。
      if (this.pendingWindow && this.pendingWindow.mode !== this.effectiveMode) void this.restore(this.pendingWindow.location).catch(error => this.report(error))
      return
    }
    if (this.renderedMode !== this.effectiveMode) {
      void this.restore(this.current()).catch(error => this.report(error))
      return
    }
    if (!this.continuous) { this.measurePaged(); this.scheduleProgress(); return }
    const width = this.context.viewport.clientWidth, height = this.context.viewport.clientHeight
    const layoutWidth = this.availableWidth(width), layoutHeight = contentSize(this.context.viewport).height
    const resized = width !== this.width || height !== this.height || layoutWidth !== this.layoutWidth || this.fit !== this.layoutFit || this.zoom !== this.layoutZoom
    const anchor = forced ?? this.capture(resized)
    let changed = resized
    if (layoutWidth !== this.layoutWidth || this.fit !== this.layoutFit || this.zoom !== this.layoutZoom || this.fit === 'page' && layoutHeight !== this.layoutHeight) {
      if (this.layoutWidth) this.heights = this.heights.map((h, index) => {
        const size = this.dimensions.get(index)
        const previous = size ? this.scaledSize(size, this.layoutWidth / this.layoutZoom, this.layoutHeight, this.layoutFit, this.layoutZoom).height : 0
        const next = size ? this.scaledSize(size, layoutWidth / this.zoom, layoutHeight).height : 0
        return Math.min(196640, Math.max(1, size ? h - previous + next : h * layoutWidth / this.layoutWidth))
      })
    }
    if (this.root.style.width !== `${layoutWidth}px`) this.root.style.width = `${layoutWidth}px`
    this.width = width; this.height = height; this.layoutWidth = layoutWidth; this.layoutHeight = layoutHeight; this.layoutFit = this.fit; this.layoutZoom = this.zoom
    // 先完成所有样式写入，再统一测量，避免逐页交替写样式和强制同步布局。
    for (const [index, node] of this.nodes) {
      const image = node.querySelector('img')!
      const width = Number(image.getAttribute('width')), height = Number(image.getAttribute('height'))
      const known = width > 0 && height > 0
      node.style.width = ''; node.style.height = ''; node.style.flex = ''
      const size = known ? this.scaledSize({ width, height }, layoutWidth / this.zoom, layoutHeight) : { width: layoutWidth, height: Math.min(196605, layoutWidth * 1.45, this.fit === 'page' ? layoutHeight * this.zoom : Infinity) }
      // 无 src 的 img 在部分浏览器中忽略 aspect-ratio；显式高度保证解码前后和回收后几何一致。
      if (image.style.height !== `${size.height}px`) image.style.height = `${size.height}px`
      if (known) {
        if (image.style.width !== `${size.width}px`) image.style.width = `${size.width}px`
        this.dimensions.set(index, { width, height })
        if (node.style.minHeight) node.style.minHeight = ''
      } else {
        const minHeight = `${this.heights[index]!}px`
        if (node.style.minHeight !== minHeight) node.style.minHeight = minHeight
      }
    }
    for (const [index, node] of this.nodes) {
      const h = node.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - this.heights[index]!) >= .5) { this.heights[index] = h; changed = true }
    }
    // 未知页不跟随某一张图片的高度全量改写，混排长短图时占位也保持稳定。
    this.updateSpacers()
    const { location, offset, proportional } = anchor
    const pageHeight = this.heights[location.index] ?? 0
    const withinPage = proportional ? (location.ratio ?? 0) * pageHeight : Math.min(offset, Math.max(0, pageHeight - 1))
    this.syncScroll(this.sum(this.trackFirst, location.index) + withinPage)
    if (this.restoreTarget && this.dimensions.has(this.restoreTarget.index)) this.restoreTarget = undefined
    this.anchor = this.current()
    if (changed) this.scheduleProgress()
  }
  private onScroll = () => {
    if (this.stopped || this.rendering) return
    if (Math.abs(this.context.viewport.scrollTop - this.scrollPosition) >= .5) {
      this.restoreTarget = undefined
      if (!this.continuous) this.pageRatio = Math.min(1, Math.max(0, this.context.viewport.scrollTop / Math.max(1, parseFloat(this.nodes.get(this.index)?.querySelector('img')?.style.height ?? '') || 1)))
    }
    if (this.scrollFrame !== undefined) return
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = undefined
      if (this.stopped) return
      if (this.context.viewport.clientWidth !== this.width || this.context.viewport.clientHeight !== this.height) this.measure(this.snapshot(this.anchor, true))
      const position = this.current()
      this.anchor = position; this.scrollPosition = this.context.viewport.scrollTop
      if (this.continuous && position.index !== this.index) {
        void this.window(position.index, position.ratio ?? 0).catch(error => this.report(error))
      } else this.scheduleProgress()
    })
  }
  async go(index: number) { await this.window(index, 0, true) }
  async restore(location: Location) {
    const selected = location.entry ? this.pages.findIndex((page) => page.entry === location.entry) : -1
    if (location.entry && selected < 0) this.context.error(new Error('原图片已不在本章，已定位到有效相邻页'))
    await this.window(selected >= 0 ? selected : location.index, location.ratio ?? 0, true)
  }
  async configure(prefs: Preferences) {
    const location = this.current()
    const redraw = (['mode', 'zoom', 'fit', 'direction', 'coverAlone', 'spreadOffset'] as const).some(key => prefs[key] !== this.context.prefs[key])
    this.context.prefs = prefs
    if (!redraw) { this.publish(); return }
    this.pictures?.destroy(); this.pictures = undefined
    await this.restore(location)
  }
  async thumbnail(index: number, caller: AbortSignal): Promise<ReaderThumbnail> {
    const signal = AbortSignal.any([this.signal, caller])
    signal.throwIfAborted()
    if (!this.preloader || !Number.isSafeInteger(index) || index < 0 || index >= this.pages.length) throw new Error('漫画缩略图页码无效')
    return coverTasks.run(signal, async () => {
      const resource = imageBlob(await this.preloader!.readIndependent(index, signal))
      signal.throwIfAborted()
      const url = URL.createObjectURL(resource.blob), image = new Image(), canvas = document.createElement('canvas')
      try {
        await new Promise<void>((resolve, reject) => {
          const clean = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', abort) }
          const abort = () => { clean(); image.removeAttribute('src'); reject(signal.reason ?? new DOMException('缩略图已取消', 'AbortError')) }
          image.onload = () => { clean(); resolve() }
          image.onerror = () => { clean(); reject(new Error('漫画缩略图解码失败')) }
          signal.addEventListener('abort', abort, { once: true }); image.src = url
        })
        signal.throwIfAborted()
        const width = image.naturalWidth, height = image.naturalHeight
        if (!width || !height || width > 65535 || height > 65535 || width * height > LIMITS.pixels) throw new Error('漫画缩略图超过图片像素上限')
        const scale = Math.min(1, 320 / width, 320 / height)
        canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建漫画缩略图画布')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return await canvasThumbnail(canvas, signal)
      } finally { image.removeAttribute('src'); URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0 }
    })
  }
  pan(x: number, y: number) {
    if (this.stopped || !Number.isFinite(x) || !Number.isFinite(y)) return
    const viewport = this.context.viewport
    viewport.scrollLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + x))
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + y))
    this.onScroll()
  }
  private onAbort = () => this.destroy()
  private report(error: unknown) { if (!isAbort(error) && !this.signal.aborted) this.context.error(error) }
  destroy() {
    if (this.stopped) return
    this.stopped = true; this.generation++; this.lifetime.abort(); this.navigationController.abort()
    this.pictures?.destroy(); this.preloader?.destroy(); this.archive?.destroy(); this.observer.disconnect()
    this.context.viewport.removeEventListener('scroll', this.onScroll); this.context.signal.removeEventListener('abort', this.onAbort)
    this.root.removeEventListener('load', this.publish, true)
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame)
    clearTimeout(this.progressTimer)
    this.nodes.clear(); this.dimensions.clear(); this.root.replaceChildren()
  }
}
