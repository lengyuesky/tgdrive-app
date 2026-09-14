/** 漫画只挂载相邻五页，滚动轨道限定在相邻四十一页以避免超长 CSS 溢出。 */
import { Archive } from '../reader/archive'
import { LIMITS, RangeFile, isImage, natural } from '../reader/io'
import { PictureWindow } from '../reader/pictures'
import { ComicPreloader } from './preload'
import { boundedIndex, frame, sectionState, type ReaderView, type Section, type ViewContext } from '../reader/view'
import type { Location, Preferences } from '../reader/state'
import type { FileEntry } from '../sdk/types'
interface ComicPage { name: string; entry: string; file?: FileEntry }
interface Dimensions { width: number; height: number }
interface ScrollAnchor { location: Location; offset: number; proportional: boolean }
export class ComicReader implements ReaderView {
  title: string
  sections: Section[] = []
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
  constructor(private context: ViewContext) {
    this.title = context.file.name
    this.root.className = 'comic-track'
    context.viewport.addEventListener('scroll', this.onScroll, { passive: true })
    this.width = context.viewport.clientWidth; this.height = context.viewport.clientHeight
    this.observer = new ResizeObserver(() => this.measure())
    this.observer.observe(context.viewport)
  }
  async open(location?: Location) {
    const { drive, file, signal } = this.context
    if (file.is_dir) {
      let cursor: string | null = null
      do {
        const page = await drive.files.list({ path: file.path, limit: 500, cursor }, { signal })
        for (const image of page.entries) if (!image.is_dir && isImage(image.name) && !image.name.startsWith('.')) this.pages.push({ name: image.name, entry: String(image.id), file: image })
        if (this.pages.length > LIMITS.entries) throw new Error('图片章节超过 10000 页，请按章节拆分目录')
        cursor = page.next_cursor
      } while (cursor)
    } else {
      this.archive = await new Archive(new RangeFile(drive, file, signal, LIMITS.archive)).open()
      for (const [path, item] of this.archive.entries) if (!item.directory && isImage(path) && !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')) this.pages.push({ name: path, entry: path })
    }
    this.pages.sort((a, b) => natural(a.name, b.name) || natural(a.entry, b.entry))
    if (!this.pages.length) throw new Error('此目录或压缩包中没有支持的漫画图片')
    this.sections = this.pages.map((page, i) => ({ label: `${i + 1} · ${page.name}`, entry: page.entry }))
    this.heights = this.pages.map(() => Math.min(1500, Math.max(240, this.context.viewport.clientWidth * 1.45)))
    this.preloader = new ComicPreloader({
      pages: this.pages, archive: this.archive, drive: this.context.drive,
      signal: this.context.signal, ahead: 3, behind: 2, maxCache: 12, concurrency: 2,
      error: this.context.error,
    })
    this.context.viewport.replaceChildren(this.root)
    await this.restore(location?.format === 'comic' ? location : { format: 'comic', index: 0 })
  }
  private sum(from: number, to: number) { let value = 0; for (let i = from; i < to; i++) value += this.heights[i] ?? 0; return value }
  private bottomPadding() { return this.context.prefs.mode === 'scroll' && this.trackEnd === this.pages.length ? Math.max(0, this.context.viewport.clientHeight - (this.heights.at(-1) ?? 0)) : 0 }
  current(): Location {
    const scroll = this.context.viewport.scrollTop
    // 未知尺寸的末页可能暂时无法滚到目标比例，不能用占位布局覆盖已保存的进度。
    if (this.restoreTarget && Math.abs(scroll - this.scrollPosition) < .5) return { ...this.restoreTarget, entry: this.pages[this.restoreTarget.index]?.entry }
    let index = this.trackFirst, top = 0
    if (this.context.prefs.mode === 'scroll') {
      while (index < this.trackEnd - 1 && top + this.heights[index]! <= scroll) {
        top += this.heights[index]!
        index++
      }
    } else {
      index = this.index
    }
    return { format: 'comic', index, entry: this.pages[index]?.entry, ratio: this.context.prefs.mode === 'scroll' ? Math.min(1, Math.max(0, (scroll - top) / Math.max(1, this.heights[index] ?? 1))) : 0 }
  }
  navigationState() {
    const index = this.current().index
    return { ...sectionState(index, this.sections.length), pageIndex: index, pageCount: this.sections.length }
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
  turn(delta: -1 | 1) { return this.go(this.current().index + delta) }
  private async window(index: number, ratio: number, programmatic = false) {
    if (this.stopped) return
    const active = ++this.generation
    this.index = boundedIndex(index, this.pages.length)
    const location: Location = { format: 'comic', index: this.index, ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0 }
    const anchor = this.snapshot(location, programmatic)
    if (programmatic) this.restoreTarget = location
    this.rendering = true
    this.preloader?.setCenter(this.index)
    const continuous = this.context.prefs.mode === 'scroll'
    // 挂载窗口可以逐页移动，轨道只在接近边界时换段，普通跨页不改变原生滚动坐标。
    const nearStart = this.trackFirst > 0 && this.index < this.trackFirst + 4
    // 短图可能一屏容纳多页，不能等到固定的末四页才扩展，否则会先碰到滚动底部。
    const nearEnd = this.trackEnd < this.pages.length && (this.index >= this.trackEnd - 4 || this.sum(this.index, this.trackEnd) < this.context.viewport.clientHeight * 2)
    if (!continuous) {
      this.trackFirst = this.index; this.trackEnd = this.index + 1
    } else if (programmatic || nearStart || nearEnd) {
      this.trackFirst = Math.max(0, this.index - 20)
      this.trackEnd = Math.min(this.pages.length, this.index + 21)
    }
    const first = continuous ? Math.max(0, this.index - 2) : this.index
    const last = continuous ? Math.min(this.pages.length, this.index + 3) : this.index + 1
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
    if (!this.pictures) this.pictures = new PictureWindow(this.context.viewport, this.root, this.context.signal, async (image, signal) => {
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
    this.measure(anchor)
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
    return Math.max(200, Math.max(40, width - padding) * this.context.prefs.zoom)
  }
  private updateSpacers() {
    const keys = [...this.nodes.keys()], continuous = this.context.prefs.mode === 'scroll'
    const before = continuous && keys.length ? this.sum(this.trackFirst, Math.min(...keys)) : 0
    const after = continuous && keys.length ? this.sum(Math.max(...keys) + 1, this.trackEnd) + this.bottomPadding() : 0
    if (this.before.style.height !== `${before}px`) this.before.style.height = `${before}px`
    if (this.after.style.height !== `${after}px`) this.after.style.height = `${after}px`
  }
  private measure(forced?: ScrollAnchor) {
    if (this.rendering || this.stopped || !this.pages.length) return
    const width = this.context.viewport.clientWidth, height = this.context.viewport.clientHeight
    const layoutWidth = this.availableWidth(width)
    const resized = width !== this.width || height !== this.height || layoutWidth !== this.layoutWidth
    const anchor = forced ?? this.capture(resized)
    const continuous = this.context.prefs.mode === 'scroll'
    let changed = resized
    if (layoutWidth !== this.layoutWidth) {
      if (this.layoutWidth) this.heights = this.heights.map((h, index) => {
        const size = this.dimensions.get(index)
        const imageHeight = (width: number) => size ? Math.min(196605, size.height * Math.min(1, width / size.width)) : 0
        return Math.min(196640, Math.max(1, size ? h - imageHeight(this.layoutWidth) + imageHeight(layoutWidth) : h * layoutWidth / this.layoutWidth))
      })
      this.root.style.width = `${layoutWidth}px`
    }
    this.width = width; this.height = height; this.layoutWidth = layoutWidth
    // 先完成所有样式写入，再统一测量，避免逐页交替写样式和强制同步布局。
    for (const [index, node] of this.nodes) {
      const image = node.querySelector('img')!
      const width = Number(image.getAttribute('width')), height = Number(image.getAttribute('height'))
      const known = width > 0 && height > 0
      // 无 src 的 img 在部分浏览器中忽略 aspect-ratio；显式高度保证解码前后和回收后几何一致。
      const imageHeight = continuous ? `${Math.min(196605, known ? height * Math.min(1, layoutWidth / width) : layoutWidth * 1.45)}px` : ''
      if (image.style.height !== imageHeight) image.style.height = imageHeight
      if (known) {
        this.dimensions.set(index, { width, height })
        if (node.style.minHeight) node.style.minHeight = ''
      } else {
        const minHeight = continuous ? `${this.heights[index]!}px` : ''
        if (node.style.minHeight !== minHeight) node.style.minHeight = minHeight
      }
    }
    if (continuous) for (const [index, node] of this.nodes) {
      const h = node.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - this.heights[index]!) >= .5) { this.heights[index] = h; changed = true }
    }
    // 未知页不跟随某一张图片的高度全量改写，混排长短图时占位也保持稳定。
    this.updateSpacers()
    const { location, offset, proportional } = anchor
    const pageHeight = this.heights[location.index] ?? 0
    const withinPage = proportional ? (location.ratio ?? 0) * pageHeight : Math.min(offset, Math.max(0, pageHeight - 1))
    this.syncScroll(continuous ? this.sum(this.trackFirst, location.index) + withinPage : 0)
    if (this.restoreTarget && this.dimensions.has(this.restoreTarget.index)) this.restoreTarget = undefined
    this.anchor = this.current()
    if (changed) this.scheduleProgress()
  }
  private onScroll = () => {
    if (this.stopped) return
    if (Math.abs(this.context.viewport.scrollTop - this.scrollPosition) >= .5) this.restoreTarget = undefined
    if (this.scrollFrame !== undefined) return
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = undefined
      if (this.stopped) return
      if (this.context.viewport.clientWidth !== this.width || this.context.viewport.clientHeight !== this.height) this.measure(this.snapshot(this.anchor, true))
      const position = this.current()
      this.anchor = position; this.scrollPosition = this.context.viewport.scrollTop
      if (this.context.prefs.mode === 'scroll' && position.index !== this.index) {
        void this.window(position.index, position.ratio ?? 0).catch(this.context.error)
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
    const redraw = prefs.mode !== this.context.prefs.mode || prefs.zoom !== this.context.prefs.zoom
    this.context.prefs = prefs
    if (!redraw) { this.publish(); return }
    this.pictures?.destroy(); this.pictures = undefined
    await this.restore(location)
  }
  destroy() {
    this.stopped = true; this.generation++; this.pictures?.destroy(); this.preloader?.destroy(); this.archive?.destroy(); this.observer.disconnect()
    this.context.viewport.removeEventListener('scroll', this.onScroll)
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame)
    clearTimeout(this.progressTimer)
    this.nodes.clear(); this.dimensions.clear(); this.root.replaceChildren()
  }
}
