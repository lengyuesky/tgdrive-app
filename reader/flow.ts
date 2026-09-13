/** TXT/EPUB 只挂载当前内容单元；滚动和单列分页共用逻辑字符锚点。 */
import type { Location, Preferences } from './state'
import type { ReaderView, Section, ViewContext, NavigationState } from './view'
import { boundedIndex, contentSize, frame, pageCount, PAGE_GAP, revealRect, sectionState, textPosition } from './view'
import { isAbort } from './io'
export abstract class FlowReader implements ReaderView {
  title: string
  sections: Section[] = []
  protected index = 0
  protected article = document.createElement('article')
  protected generation = 0
  protected sectionController = new AbortController()
  protected restoring = false
  protected offsetBase = 0
  private pager = document.createElement('div')
  private scrollTimer?: ReturnType<typeof setTimeout>
  private resize: ResizeObserver
  private lastLocation?: Location
  private anchorPage = 0
  private width = 0
  private height = 0
  private stopped = false
  private queue = Promise.resolve()
  private layoutFrame?: number
  private layoutLocation?: Location
  abstract readonly format: 'txt' | 'epub'
  constructor(protected context: ViewContext) {
    this.title = context.file.name
    this.article.className = 'flow-content'
    this.pager.className = 'flow-pages'
    context.viewport.addEventListener('scroll', this.onScroll, { passive: true })
    this.pager.addEventListener('scroll', this.onScroll, { passive: true })
    this.resize = new ResizeObserver(() => {
      if (context.viewport.clientWidth === this.width && context.viewport.clientHeight === this.height) return
      if (this.lastLocation && !this.restoring) this.scheduleLayout(this.lastLocation)
    })
    this.resize.observe(context.viewport)
  }
  protected get paged() { return this.context.prefs.mode === 'page' }
  protected get scroller() { return this.paged ? this.pager : this.context.viewport }
  protected get stride() { return this.pager.clientWidth + PAGE_GAP }
  protected abstract prepare(location?: Location): Promise<void>
  protected abstract content(index: number, signal: AbortSignal): Promise<DocumentFragment>
  protected offsetFor(_index: number) { return 0 }
  protected indexFor(location: Location) { return boundedIndex(location.index, this.sections.length) }
  protected afterContent(_signal: AbortSignal) {}
  protected afterLayout() {}
  private check() {
    this.context.signal.throwIfAborted()
    if (this.stopped) throw new DOMException('阅读器已关闭', 'AbortError')
  }
  private run(work: () => Promise<void>) {
    const operation = this.queue.catch(() => {}).then(async () => { this.check(); await work() })
    this.queue = operation
    return operation
  }
  async open(location?: Location) {
    await this.prepare(location); this.check()
    await this.restore(location?.format === this.format ? location : { format: this.format, index: 0 })
  }
  private page() {
    const count = pageCount(this.pager.scrollWidth, this.pager.clientWidth)
    return { index: boundedIndex(Math.round(this.pager.scrollLeft / Math.max(1, this.stride)), count), count }
  }
  navigationState(): NavigationState {
    const state = sectionState(this.index, this.sections.length)
    if (!this.paged) return state
    const page = this.page()
    return { ...state, pageIndex: page.index, pageCount: page.count, canPrevious: state.canPrevious || page.index > 0, canNext: state.canNext || page.index < page.count - 1 }
  }
  private readLocation(): Location {
    const scroller = this.scroller, page = this.page()
    return { format: this.format, index: this.index, entry: this.sections[this.index]?.entry,
      offset: this.article.textContent?.trim() ? this.offsetBase + textPosition(this.article, scroller, undefined, this.paged ? this.stride : undefined) : undefined,
      ratio: this.paged ? page.index / Math.max(1, page.count - 1) : Math.min(1, Math.max(0, scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight))) }
  }
  current(): Location {
    // 重排期间不能把临时首页当作真实进度；分页保留页内锚点，避免反复调字号向前漂移。
    if (this.lastLocation && (this.restoring || this.layoutLocation || this.paged && this.anchorPage === this.page().index)) return { ...this.lastLocation }
    const location = this.readLocation()
    if (!this.restoring) this.lastLocation = location
    return location
  }
  private remember(target?: Location) {
    const actual = this.readLocation()
    if (this.paged && target?.offset !== undefined && this.indexFor(target) === this.index && this.article.textContent?.trim()) {
      actual.offset = this.offsetBase + Math.min(Math.max(0, target.offset - this.offsetBase), Math.max(0, (this.article.textContent?.length ?? 1) - 1))
    } else if (!this.article.textContent?.trim() && target?.ratio !== undefined) {
      // 图片尚未解码时临时只有一页，也必须保留待恢复的比例，不能提前保存为首页。
      actual.ratio = Math.max(0, Math.min(1, target.ratio))
    }
    this.lastLocation = actual; this.anchorPage = this.page().index
  }
  go(index: number) { return this.restore({ format: this.format, index: boundedIndex(index, this.sections.length) }) }
  turn(delta: -1 | 1) {
    return this.run(async () => {
      const pending = this.layoutLocation
      this.generation++; this.cancelLayout()
      if (pending || this.width !== this.context.viewport.clientWidth || this.height !== this.context.viewport.clientHeight) await this.relayout(pending ?? this.lastLocation ?? this.current())
      const state = this.navigationState()
      if (delta < 0 ? !state.canPrevious : !state.canNext) return
      if (this.paged) {
        const page = this.page(), next = page.index + delta
        if (next >= 0 && next < page.count) {
          this.pager.scrollLeft = next * this.stride
          this.remember(); this.afterLayout(); this.context.changed()
          return
        }
      }
      await this.restoreContent({ format: this.format, index: this.index + delta, ratio: this.paged && delta < 0 ? 1 : 0 })
    })
  }
  restore(location: Location) { return this.run(() => this.restoreContent(location)) }
  private async restoreContent(location: Location) {
    const active = ++this.generation
    this.cancelLayout()
    this.sectionController.abort(); this.sectionController = new AbortController()
    const signal = AbortSignal.any([this.context.signal, this.sectionController.signal])
    this.restoring = true
    const index = this.indexFor(location)
    try {
      const fragment = await this.content(index, signal)
      signal.throwIfAborted(); this.check()
      if (active !== this.generation) return
      this.index = index; this.offsetBase = this.offsetFor(index)
      this.article.replaceChildren(fragment)
      this.applyStyles()
      this.scroller.scrollTop = 0; this.scroller.scrollLeft = 0
      this.lastLocation = { ...location, index }; this.anchorPage = 0
      this.afterContent(signal)
      await frame(); this.check()
      await this.reposition(location)
      this.remember(location); this.afterLayout()
    } finally {
      if (active === this.generation && !this.stopped && !this.context.signal.aborted) { this.restoring = false; this.context.changed() }
    }
  }
  protected async reposition(location: Location) {
    this.check()
    if (this.article.textContent?.trim() && location.offset !== undefined) textPosition(this.article, this.scroller, Math.max(0, location.offset - this.offsetBase), this.paged ? this.stride : undefined)
    else if (this.paged) this.pager.scrollLeft = Math.round((location.ratio ?? 0) * (this.page().count - 1)) * this.stride
    else this.scroller.scrollTop = (location.ratio ?? 0) * Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
  }
  protected reveal(target: Element) {
    revealRect(target.getBoundingClientRect(), this.scroller, this.paged ? this.stride : undefined)
  }
  private onScroll = () => {
    if (this.stopped || this.context.signal.aborted || this.restoring || this.layoutLocation) return
    if ((this.context.viewport.clientWidth !== this.width || this.context.viewport.clientHeight !== this.height) && this.lastLocation) { this.scheduleLayout(this.lastLocation); return }
    if (!this.paged || this.anchorPage !== this.page().index) {
      this.generation++; this.cancelLayout(); this.remember()
    }
    clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      if (!this.stopped && !this.context.signal.aborted && !this.restoring && !this.layoutLocation) this.context.changed()
    }, 120)
  }
  private applyStyles() {
    const { viewport, prefs } = this.context
    viewport.dataset.format = this.format; viewport.dataset.mode = prefs.mode
    this.article.style.fontSize = `${prefs.fontSize}px`
    this.article.style.lineHeight = String(prefs.lineHeight)
    this.article.classList.toggle('is-paginated', this.paged)
    if (this.paged) {
      if (this.article.parentElement !== this.pager) this.pager.replaceChildren(this.article)
      if (this.pager.parentElement !== viewport) viewport.replaceChildren(this.pager)
      const size = contentSize(viewport)
      const mobile = !!viewport.closest('.immersive')
      this.pager.style.width = `${Math.min(size.width, mobile ? size.width : prefs.width)}px`
      this.pager.style.height = `${size.height}px`
      this.article.style.maxWidth = 'none'
      this.article.style.paddingBottom = '0px'
      this.article.style.columnWidth = `${this.pager.clientWidth}px`
      this.article.style.setProperty('--page-height', `${size.height}px`)
      // 超过单页的不可分割表格行需要保留页内滚动，不能被阅读视口裁掉。
      for (const table of this.article.querySelectorAll('table')) {
        if (table.parentElement?.classList.contains('flow-block-scroll')) continue
        if ([...table.rows].some((row) => row.scrollHeight > size.height)) {
          const wrapper = document.createElement('div'); wrapper.className = 'flow-block-scroll'; wrapper.tabIndex = 0
          wrapper.setAttribute('aria-label', '可滚动表格'); table.before(wrapper); wrapper.append(table)
        }
      }
    } else {
      if (this.article.parentElement !== viewport) viewport.replaceChildren(this.article)
      this.article.style.maxWidth = `${prefs.width}px`
      this.article.style.paddingBottom = `${viewport.clientHeight}px`
      this.article.style.removeProperty('column-width')
      for (const wrapper of this.article.querySelectorAll('.flow-block-scroll')) wrapper.replaceWith(...wrapper.childNodes)
    }
    this.width = viewport.clientWidth; this.height = viewport.clientHeight
  }
  /** 图片尺寸更新必须先捕获逻辑位置，再安排有界重排。 */
  protected layout(mutate: () => void) {
    if (this.stopped || this.context.signal.aborted) return
    const location = this.layoutLocation ?? this.lastLocation ?? this.current()
    mutate()
    this.scheduleLayout(location)
  }
  private scheduleLayout(location: Location) {
    if (this.stopped || this.context.signal.aborted) return
    this.layoutLocation ??= { ...location }
    if (this.layoutFrame !== undefined) return
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined
      const location = this.layoutLocation, generation = this.generation
      if (!location) return
      void this.run(async () => {
        if (generation !== this.generation) return
        if (this.layoutLocation === location) this.layoutLocation = undefined
        await this.relayout(location)
      }).catch((error) => this.report(error))
    })
  }
  private async relayout(location: Location) {
    this.restoring = true
    try {
      this.applyStyles()
      await frame(); this.check()
      await this.reposition(location); this.remember(location); this.afterLayout()
    } finally { if (!this.stopped) this.restoring = false }
    this.context.changed()
  }
  configure(prefs: Preferences) {
    return this.run(async () => {
      const location = this.layoutLocation ?? this.current(), modeChanged = this.context.prefs.mode !== prefs.mode
      this.generation++; this.cancelLayout()
      this.context.prefs = prefs
      await this.relayout(location)
      if (modeChanged) this.afterContent(AbortSignal.any([this.context.signal, this.sectionController.signal]))
    })
  }
  private cancelLayout() {
    if (this.layoutFrame !== undefined) cancelAnimationFrame(this.layoutFrame)
    this.layoutFrame = undefined; this.layoutLocation = undefined
  }
  destroy() {
    this.stopped = true; this.generation++; this.sectionController.abort(); clearTimeout(this.scrollTimer); this.cancelLayout()
    this.resize.disconnect(); this.context.viewport.removeEventListener('scroll', this.onScroll); this.pager.removeEventListener('scroll', this.onScroll)
    this.article.replaceChildren(); this.pager.replaceChildren()
  }
  protected report(error: unknown) { if (!isAbort(error) && !this.stopped && !this.context.signal.aborted) this.context.error(error) }
}
