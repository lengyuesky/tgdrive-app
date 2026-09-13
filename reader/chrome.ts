/** 图书与漫画的临时阅读界面状态不持久化，移动端阅读时激活全屏沉浸并与宿主联动。 */
import type { Drive, ReadyContext } from '../sdk/types'
import { ReadingGestures } from './gestures'
export const MOBILE_READING_QUERY = '(max-width: 768px), (pointer: coarse)'
type Panel = 'preferences' | 'bookmarks' | 'navigation' | 'reader-more'
interface ChromeOptions {
  books?: boolean; immersive?: boolean; drive: Drive; context: ReadyContext
  turn: (delta: -1 | 1) => void; paged: () => boolean; error: (error: unknown) => void
}
export class ReaderChrome {
  private media = window.matchMedia?.(MOBILE_READING_QUERY)
  private reading = false
  private ready = false
  private active = false
  private controls = true
  private panel?: Panel
  private previousFocus?: HTMLElement
  private disposed = false
  private hostState = false
  private hostBackground?: string
  private hostQueue = Promise.resolve()
  private gestures: ReadingGestures
  private removers: (() => void)[] = []
  private get = <T extends HTMLElement = HTMLElement>(id: string) => this.root.querySelector<T>(`#${id}`)!
  constructor(private root: HTMLElement, private options: ChromeOptions) {
    this.gestures = new ReadingGestures(this.get('viewport'), {
      enabled: () => this.active && this.ready && !this.panel,
      paged: options.paged, controls: () => this.controls,
      toggle: () => this.toggle(), turn: options.turn,
    })
    const bind = (id: string, action: () => void) => {
      const element = this.get(id), listener = () => action()
      element.addEventListener('click', listener); this.removers.push(() => element.removeEventListener('click', listener))
    }
    bind('reader-menu-toggle', () => this.reveal())
    bind('toc-toggle', () => this.togglePanel('navigation'))
    bind('reader-more-toggle', () => this.togglePanel('reader-more'))
    for (const button of root.querySelectorAll<HTMLElement>('[data-close-panel]')) {
      const listener = () => this.closePanel()
      button.addEventListener('click', listener); this.removers.push(() => button.removeEventListener('click', listener))
    }
    bind('reader-backdrop', () => this.closePanel())
    this.media?.addEventListener('change', this.resize)
    window.visualViewport?.addEventListener('resize', this.visualResize)
    document.addEventListener('keydown', this.key)
  }
  private supportsHost() { return this.options.context.capabilities?.includes('ui.setImmersive') && typeof this.options.drive.ui?.setImmersive === 'function' }
  private setHost(active: boolean) {
    const background = active && this.options.context.capabilities?.includes('ui.immersiveBackground')
      ? getComputedStyle(document.body).getPropertyValue('--bg').trim() : undefined
    if (!this.supportsHost() || (this.hostState === active && this.hostBackground === background)) return this.hostQueue
    this.hostState = active
    this.hostBackground = background
    this.hostQueue = this.hostQueue.catch(() => {}).then(async () => {
      if (active && this.disposed) return
      await this.options.drive.ui.setImmersive(active, background ? { background } : undefined)
    }).catch((error) => { if (!this.disposed) { this.hostState = false; this.options.error(error) } })
    return this.hostQueue
  }
  themeChanged() { return this.setHost(this.active) }
  private apply() {
    const active = (this.options.immersive ?? this.options.books ?? true) && this.reading && !!this.media?.matches
    if (active !== this.active) {
      this.closePanel(false)
      this.active = active
      this.root.classList.toggle('immersive', active)
      this.get(active ? 'reader-footer-actions' : 'reader-desktop-actions').append(this.get('reader-actions'))
      this.get('navigation').hidden = active
      this.get('reader-more').hidden = active
      this.controls = !active || !this.ready
    }
    this.render()
    return this.setHost(active)
  }
  private render() {
    this.root.dataset.controls = this.controls ? 'visible' : 'hidden'
    this.get('reader-backdrop').hidden = !this.active || !this.panel
    this.get('viewport').inert = this.active && !!this.panel
    for (const id of ['preferences', 'bookmarks', 'navigation', 'reader-more'] as Panel[]) {
      const element = this.get(id), modal = this.active && this.panel === id
      element.classList.toggle('reader-panel', this.active)
      if (modal) { element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true') }
      else { element.removeAttribute('role'); element.removeAttribute('aria-modal') }
    }
    this.visualResize()
  }
  private resize = () => { if (!this.disposed) void this.apply() }
  private visualResize = () => {
    // 键盘只约束浮层，不用缩放后的尺寸重排整本正文。
    const height = window.visualViewport?.height ?? window.innerHeight
    this.root.style.setProperty('--panel-height', `${Math.max(120, height * .75)}px`)
  }
  async enter() {
    this.closePanel(false)
    this.get('preferences').hidden = true; this.get('bookmarks').hidden = true
    this.reading = true; this.ready = false; this.controls = true
    await this.apply()
  }
  opened() {
    this.ready = true; this.controls = !this.active
    this.render()
    this.get('viewport').focus({ preventScroll: true })
  }
  async leave() {
    this.reading = false; this.ready = false; this.closePanel(false)
    await this.apply()
    this.get('preferences').hidden = true; this.get('bookmarks').hidden = true
  }
  reveal() { if (this.panel) this.closePanel(false); this.controls = true; this.render() }
  toggle() {
    if (!this.active) return
    this.closePanel(false); this.controls = !this.controls; this.render()
    if (!this.controls) this.get('viewport').focus({ preventScroll: true })
  }
  togglePanel(panel: Panel) {
    if (!this.active) {
      this.get(panel).hidden = !this.get(panel).hidden
      return !this.get(panel).hidden
    }
    if (this.panel === panel) { this.closePanel(); return false }
    this.closePanel(false)
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.panel = panel; this.controls = true
    this.get(panel).hidden = false; this.render()
    const first = this.focusable(this.get(panel))[0]
    first?.focus({ preventScroll: true })
    return true
  }
  closePanel(focus = true) {
    if (this.panel) this.get(this.panel).hidden = true
    this.panel = undefined
    this.get('viewport').inert = false
    if (focus) this.previousFocus?.focus({ preventScroll: true })
    this.previousFocus = undefined
    this.render()
  }
  private focusable(panel: HTMLElement) {
    return [...panel.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex="0"]')]
      .filter((element) => !element.closest('[hidden]') && !element.hasAttribute('disabled') && getComputedStyle(element).display !== 'none')
  }
  private key = (event: KeyboardEvent) => {
    if (!this.active || !this.reading) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (this.panel) this.closePanel()
      else { this.reveal(); this.get('back').focus({ preventScroll: true }) }
    } else if (event.key === 'Tab' && !this.panel && !this.controls) {
      event.preventDefault(); this.reveal(); this.get('back').focus({ preventScroll: true })
    } else if (event.key === 'Tab' && this.panel) {
      const elements = this.focusable(this.get(this.panel)), first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus() }
    }
  }
  destroy() {
    this.disposed = true; this.reading = false
    this.media?.removeEventListener('change', this.resize)
    window.visualViewport?.removeEventListener('resize', this.visualResize)
    document.removeEventListener('keydown', this.key)
    this.gestures.destroy(); this.removers.forEach((remove) => remove())
    this.closePanel(false); this.root.classList.remove('immersive')
    void this.setHost(false)
  }
}
