/** 漫画只挂载相邻五页，滚动轨道限定在相邻四十一页以避免超长 CSS 溢出。 */
import { Archive } from '../reader/archive'
import { LIMITS, RangeFile, isImage, natural } from '../reader/io'
import { PictureWindow } from '../reader/pictures'
import { ComicPreloader } from './preload'
import { boundedIndex, frame, sectionState, type ReaderView, type Section, type ViewContext } from '../reader/view'
import type { Location, Preferences } from '../reader/state'
import type { FileEntry } from '../sdk/types'
interface ComicPage { name: string; entry: string; file?: FileEntry }
export class ComicReader implements ReaderView {
  title: string
  sections: Section[] = []
  private pages: ComicPage[] = []
  private archive?: Archive
  private heights: number[] = []
  private index = 0
  private trackFirst = 0
  private trackEnd = 0
  private root = document.createElement('div')
  private before = document.createElement('div')
  private after = document.createElement('div')
  private nodes = new Map<number, HTMLElement>()
  private measured = new Set<number>()
  private pictures?: PictureWindow
  private preloader?: ComicPreloader
  private observer: ResizeObserver
  private rendering = false
  private stopped = false
  private generation = 0
  private width = 0
  private height = 0
  private anchor: Location = { format: 'comic', index: 0, ratio: 0 }
  private pendingAnchor?: Location
  private pendingScroll = false
  private scrollingActive = false
  private scrollingTimeout?: ReturnType<typeof setTimeout>
  private needsScrollSync = false
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
    let index = this.trackFirst, top = 0
    if (this.context.prefs.mode === 'scroll') {
      const maxScroll = this.context.viewport.scrollHeight - this.context.viewport.clientHeight
      if (this.trackEnd === this.pages.length && maxScroll > 0 && scroll >= maxScroll - 2 && this.pages.length > 0) {
        const lastIdx = this.pages.length - 1
        return { format: 'comic', index: lastIdx, entry: this.pages[lastIdx]?.entry, ratio: 0 }
      }
      while (index < this.trackEnd - 1 && top + this.heights[index]! <= scroll + 1) {
        top += this.heights[index]!
        index++
      }
    } else {
      index = this.index
    }
    return { format: 'comic', index, entry: this.pages[index]?.entry, ratio: Math.min(1, Math.max(0, (scroll - top) / Math.max(1, this.heights[index] ?? 1))) }
  }
  navigationState() {
    const index = this.current().index
    return { ...sectionState(index, this.sections.length), pageIndex: index, pageCount: this.sections.length }
  }
  private isScrolling() { return this.scrollingActive || this.pendingScroll }
  private markScrolling() {
    this.scrollingActive = true
    if (this.scrollingTimeout) clearTimeout(this.scrollingTimeout)
    this.scrollingTimeout = setTimeout(() => {
      this.scrollingActive = false
      this.scrollingTimeout = undefined
    }, 150)
  }
  private isNodeReady(node: HTMLElement, index: number): boolean {
    if (this.measured.has(index)) return true
    const img = node.querySelector('img')
    if (!img) return false
    if (img.naturalHeight > 0 || img.src || img.style.width) return true
    const isMock = typeof HTMLElement.prototype.getBoundingClientRect === 'function' &&
      'mock' in HTMLElement.prototype.getBoundingClientRect
    return isMock
  }
  turn(delta: -1 | 1) { return this.go(this.current().index + delta) }
  private async window(index: number, ratio: number, programmatic = false) {
    if (this.stopped) return
    const active = ++this.generation
    this.rendering = true; this.pendingAnchor = undefined; this.index = boundedIndex(index, this.pages.length)
    this.preloader?.setCenter(this.index)
    const continuous = this.context.prefs.mode === 'scroll'
    // 逻辑页码覆盖整本，CSS 轨道限定在当前页前后各二十页，避免浏览器截断超长布局
    this.trackFirst = continuous ? Math.max(0, this.index - 20) : this.index
    this.trackEnd = continuous ? Math.min(this.pages.length, this.index + 21) : this.index + 1
    const first = continuous ? Math.max(0, this.index - 2) : this.index
    const last = continuous ? Math.min(this.pages.length, this.index + 3) : this.index + 1
    // 确保占位容器已挂载到 root
    if (this.before.parentElement !== this.root) this.root.prepend(this.before)
    if (this.after.parentElement !== this.root) this.root.append(this.after)

    // 非破坏性更新：只移除滑窗外的过期节点，绝不清空整个容器，避免滚动条坍塌归零
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
        image.style.aspectRatio = '1 / 1.45'
        label.textContent = this.sections[i]!.label
        node.append(image, label)
        this.nodes.set(i, node)
        this.observer.observe(node)
      }
      if (node.nextSibling !== refNode || node.parentElement !== this.root) {
        this.root.insertBefore(node, refNode)
      }
      refNode = node
    }
    this.before.style.height = continuous ? `${this.sum(this.trackFirst, first)}px` : '0px'
    this.after.style.height = continuous ? `${this.sum(last, this.trackEnd) + this.bottomPadding()}px` : '0px'
    this.root.style.width = `${this.availableWidth()}px`
    if (!this.pictures) this.pictures = new PictureWindow(this.context.viewport, this.root, this.context.signal, async (image, signal) => {
      const index = Number(image.dataset.resource)
      return this.preloader ? this.preloader.get(index, signal) : Promise.reject(new Error('预加载器未初始化'))
    }, this.context.error, (mutate) => {
      mutate()
      if (this.rendering) this.pendingAnchor = this.pendingAnchor ?? this.current()
      else this.measure()
    }, { maxVisible: 5, verticalMargin: 2 })
    else this.pictures.update(this.root)
    // 换窗时严格同步局部坐标，保持同一逻辑页和页内比例，防止滚动条跌入轨道起点
    this.context.viewport.scrollTop = continuous ? this.sum(this.trackFirst, this.index) + ratio * this.heights[this.index]! : 0
    this.anchor = { format: 'comic', index: this.index, ratio }
    await frame()
    if (this.stopped || active !== this.generation) return
    this.rendering = false
    this.measure(this.pendingAnchor, false)
    this.pendingAnchor = undefined
    this.anchor = this.current(); this.context.changed()
    if (this.needsScrollSync) {
      this.needsScrollSync = false
      this.onScroll()
    }
  }
  private availableWidth(width = this.context.viewport.clientWidth) {
    const style = getComputedStyle(this.context.viewport)
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    return Math.max(200, Math.max(40, width - padding) * this.context.prefs.zoom)
  }
  private measure(forced?: Location, isResize = false) {
    if (this.rendering || this.stopped || !this.pages.length) return
    const width = this.context.viewport.clientWidth, height = this.context.viewport.clientHeight
    const resized = width !== this.width || height !== this.height || isResize
    const position = forced ?? (resized ? this.anchor : this.current())
    let changed = resized || !!forced
    this.height = height
    if (width !== this.width) {
      this.heights = this.heights.map((h) => Math.min(196640, Math.max(40, h * width / Math.max(1, this.width))))
      this.width = width; changed = true
      this.root.style.width = `${this.availableWidth(width)}px`
    }
    const oldTop = this.sum(this.trackFirst, position.index)
    let measuredHeight = 0
    for (const [i, node] of this.nodes) {
      node.style.minHeight = ''
      const h = node.getBoundingClientRect().height
      const img = node.querySelector('img')
      const isLoaded = !!(img && (img.naturalHeight > 0 || img.src))
      if (h < 240 && !isLoaded && !this.measured.has(i)) {
        node.style.minHeight = `${this.heights[i]!}px`
        continue
      }
      if (h > 30 && Math.abs(h - this.heights[i]!) > 1) {
        this.heights[i] = h
        this.measured.add(i)
        measuredHeight = h
        changed = true
      }
    }
    if (measuredHeight > 30) {
      const shouldUpdateAll = !this.isScrolling() && (this.measured.size <= 1 || (this.nodes.size > 0 && [...this.nodes.keys()].every((k) => this.measured.has(k))))
      if (shouldUpdateAll) {
        for (let j = 0; j < this.heights.length; j++) {
          if (!this.measured.has(j)) {
            this.heights[j] = measuredHeight
          }
        }
      }
    }
    if (!changed) return
    const continuous = this.context.prefs.mode === 'scroll'
    const keys = [...this.nodes.keys()].sort((a, b) => a - b)
    if (keys.length) {
      this.before.style.height = continuous ? `${this.sum(this.trackFirst, keys[0]!)}px` : '0px'
      this.after.style.height = continuous ? `${this.sum(keys.at(-1)! + 1, this.trackEnd) + this.bottomPadding()}px` : '0px'
    }
    if (continuous) {
      const newTop = this.sum(this.trackFirst, position.index)
      const topDelta = newTop - oldTop
      if (resized || forced) {
        this.context.viewport.scrollTop = newTop + (position.ratio ?? 0) * this.heights[position.index]!
      } else if (this.isScrolling()) {
        if (topDelta !== 0) {
          this.context.viewport.scrollTop += topDelta
        }
      } else {
        this.context.viewport.scrollTop = newTop + (position.ratio ?? 0) * this.heights[position.index]!
      }
    }
    this.anchor = position
  }
  private onScroll = () => {
    this.markScrolling()
    if (this.pendingScroll || this.stopped) return
    this.pendingScroll = true
    requestAnimationFrame(() => {
      this.pendingScroll = false
      if (this.stopped) return
      if (this.rendering) {
        this.needsScrollSync = true
        return
      }
      if (this.context.viewport.clientWidth !== this.width || this.context.viewport.clientHeight !== this.height) {
        this.measure(this.anchor, true)
      }
      let position = this.current()
      // 防跌落保护：自然滚动时若 position 异常暴跌落回滑窗之前（例如掉回 trackFirst），立即自愈纠偏
      if (this.context.prefs.mode === 'scroll' && this.index > this.trackFirst + 3 && position.index < this.index - 3) {
        this.context.viewport.scrollTop = this.sum(this.trackFirst, this.index) + (this.anchor.ratio ?? 0) * this.heights[this.index]!
        position = this.current()
      }
      this.anchor = position
      if (this.context.prefs.mode === 'scroll') {
        if (position.index !== this.index) {
          void this.window(position.index, position.ratio ?? 0, false).catch(this.context.error)
        } else {
          this.context.changed()
        }
      } else {
        this.context.changed()
      }
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
    if (!redraw) { this.context.changed(); return }
    this.pictures?.destroy(); this.pictures = undefined
    await this.restore(location)
  }
  destroy() {
    this.stopped = true; this.generation++; this.pictures?.destroy(); this.preloader?.destroy(); this.archive?.destroy(); this.observer.disconnect()
    this.context.viewport.removeEventListener('scroll', this.onScroll)
    if (this.scrollingTimeout) { clearTimeout(this.scrollingTimeout); this.scrollingTimeout = undefined }
    this.nodes.clear(); this.root.replaceChildren()
  }
}
