/** 书库导航：桌面常驻侧栏，手机复用可关闭、圈定焦点的书库抽屉。 */
import { contentKind, scopeFormats, type LibrarySnapshot } from '../library'
import type { LibrarySelection, UiContext, UiView } from './types'

interface LibraryShortcut {
  id: string
  label: string
  icon: string
  selection: LibrarySelection
  title?: string
  disabled?: boolean
}

export class NavManager {
  private activeView: UiView = 'home'
  private selection: LibrarySelection = {}
  private shortcuts = new Map<string, LibraryShortcut>()
  private signature = ''
  private media = window.matchMedia?.('(max-width: 768px), (pointer: coarse)')
  private drawerOpen = false
  private previousFocus?: HTMLElement
  private inertElements: { element: HTMLElement; inert: boolean }[] = []
  private unsubs: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {
    this.render()
    this.refreshLibraries()
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
      if (!target || !this.container.contains(target) || target.disabled) return
      const shortcut = target.dataset.libraryId && this.shortcuts.get(target.dataset.libraryId)
      if (shortcut) {
        this.closeDrawer()
        this.run(() => this.context.openLibrary
          ? this.context.openLibrary(shortcut.selection)
          : this.context.switchView('library'))
      } else if (target.dataset.view) {
        this.closeDrawer()
        this.run(() => target.dataset.view === 'library' && this.context.openLibrary
          ? this.context.openLibrary({})
          : this.context.switchView(target.dataset.view as UiView))
      } else if (target.id === 'btn-mobile-libraries') {
        this.openDrawer()
      } else if (target.id === 'btn-sidebar-dismiss' || target.id === 'sidebar-backdrop') {
        this.closeDrawer()
      } else if (target.id.endsWith('-settings')) {
        this.closeDrawer()
        this.run(() => this.context.drive.settings.open())
      } else if (target.id.endsWith('-close')) {
        this.closeDrawer()
        this.run(() => this.context.closeApp())
      }
    }
    this.container.addEventListener('click', click)
    document.addEventListener('keydown', this.key)
    this.media?.addEventListener('change', this.resize)
    this.unsubs.push(
      () => this.container.removeEventListener('click', click),
      () => document.removeEventListener('keydown', this.key),
      () => this.media?.removeEventListener('change', this.resize)
    )
  }

  private render() {
    const isBooks = this.context.kind === 'books'
    const title = this.context.kind === 'all' ? '阅读馆' : isBooks ? '图书' : '漫画'
    const subtitle = this.context.kind === 'all' ? '书与漫画，都在这里' : isBooks ? '把网盘变成随身书房' : '按自己的节奏，翻开下一页'
    this.container.innerHTML = `
      <button id="sidebar-backdrop" class="sidebar-backdrop" aria-label="关闭书库侧边栏" tabindex="-1" hidden></button>
      <aside id="library-sidebar" class="desktop-sidebar" aria-label="书库侧边栏">
        <div class="sidebar-heading">
          <div class="sidebar-brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <div class="brand-text">
              <h1 class="sidebar-title">${title}</h1>
              <p class="sidebar-subtitle">${subtitle}</p>
            </div>
          </div>
          <button id="btn-sidebar-dismiss" class="sidebar-mobile-close" type="button" aria-label="关闭书库侧边栏">×</button>
        </div>
        <div class="sidebar-scroll">
          <nav class="sidebar-nav" aria-label="应用导航">
            <button id="nav-home" class="nav-item active" data-view="home" type="button">
              <span class="nav-icon" aria-hidden="true">⌂</span><span class="nav-label">首页</span>
            </button>
            <button id="nav-library" class="nav-item" data-view="library" type="button">
              <span class="nav-icon" aria-hidden="true">▤</span><span class="nav-label">全部书库</span>
            </button>
            <button id="nav-me" class="nav-item" data-view="me" type="button">
              <span class="nav-icon" aria-hidden="true">○</span><span class="nav-label">我的</span>
            </button>
          </nav>
          <div id="sidebar-libraries"></div>
        </div>
        <div class="sidebar-actions">
          <button id="btn-sidebar-settings" class="sidebar-action-btn" type="button">目录设置</button>
          <button id="btn-sidebar-close" class="sidebar-action-btn" type="button">返回网盘</button>
        </div>
      </aside>
      <header class="mobile-header">
        <div class="mobile-brand">
          <button id="btn-mobile-libraries" class="mobile-action-btn" type="button" aria-label="打开书库侧边栏" aria-controls="library-sidebar" aria-expanded="false">☰</button>
          <h1 class="mobile-title">${title}</h1>
        </div>
        <div class="mobile-actions">
          <button id="btn-mobile-settings" class="mobile-action-btn" type="button">目录设置</button>
          <button id="btn-mobile-close" class="mobile-action-btn" type="button">返回网盘</button>
        </div>
      </header>
      <nav class="mobile-bottom-nav" aria-label="移动端底部导航">
        <button id="tab-home" class="bottom-tab active" data-view="home" type="button" aria-label="首页">
          <span class="tab-icon" aria-hidden="true">⌂</span><span class="tab-label">首页</span>
        </button>
        <button id="tab-library" class="bottom-tab" data-view="library" type="button" aria-label="书库">
          <span class="tab-icon" aria-hidden="true">▤</span><span class="tab-label">书库</span>
        </button>
        <button id="tab-me" class="bottom-tab" data-view="me" type="button" aria-label="我的">
          <span class="tab-icon" aria-hidden="true">○</span><span class="tab-label">我的</span>
        </button>
      </nav>
    `
  }

  refreshLibraries(snapshot: LibrarySnapshot = this.context.library.snapshot) {
    const formats = scopeFormats(this.context.kind)
    const types: LibraryShortcut[] = [
      ...(this.context.kind !== 'comics' ? [{ id: 'kind:books', label: '图书', icon: '文', selection: { kind: 'books' as const } }] : []),
      ...(this.context.kind !== 'books' ? [{ id: 'kind:comics', label: '漫画', icon: '▧', selection: { kind: 'comics' as const } }] : []),
      ...formats.filter(format => ['epub', 'pdf', 'txt', 'images'].includes(format)).map(format => ({
        id: `format:${format}`,
        label: format === 'images' ? '图片目录' : format === 'pdf' ? 'PDF 文档' : format === 'epub' ? 'EPUB 电子书' : 'TXT 文本',
        icon: format === 'images' ? '▧' : '▤',
        selection: { kind: contentKind(format), format },
      })),
    ]
    const sources: LibraryShortcut[] = snapshot.sources.config.sources.map(source => ({
      id: `source:${source.nodeId}`,
      label: source.path === '/' ? '网盘根目录' : source.path.split('/').pop() || source.path,
      icon: '▱',
      title: source.path,
      selection: { sourceId: source.nodeId },
    }))
    const store = this.context.library.bookGroups
    const groups: LibraryShortcut[] = this.context.kind === 'comics' ? [] : store.groups.map(group => ({
      id: `group:${group.id}`, label: group.name, icon: '◇', selection: { groupId: group.id }, disabled: !store.ready,
    }))
    const sections = [
      { title: '内容类型', entries: types },
      { title: '来源书库', entries: sources },
      ...(this.context.kind === 'comics' ? [] : [{ title: '自定义分组', entries: groups }]),
    ]
    const signature = JSON.stringify(sections)
    if (signature === this.signature) { this.updateActive(); return }
    this.signature = signature
    this.shortcuts = new Map(sections.flatMap(section => section.entries.map(entry => [entry.id, entry] as const)))
    const libraries = this.container.querySelector<HTMLElement>('#sidebar-libraries')!
    const focused = document.activeElement instanceof HTMLElement && libraries.contains(document.activeElement)
      ? document.activeElement.dataset.libraryId : undefined
    libraries.replaceChildren()
    for (const section of sections) {
      const nav = document.createElement('nav')
      nav.className = 'sidebar-library-section'; nav.setAttribute('aria-label', section.title)
      const heading = document.createElement('h2')
      heading.className = 'sidebar-section-title'; heading.textContent = section.title
      nav.append(heading)
      for (const entry of section.entries) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'nav-item library-shortcut'
        button.dataset.libraryId = entry.id; button.disabled = !!entry.disabled
        button.title = entry.title ?? entry.label
        const icon = document.createElement('span'), label = document.createElement('span')
        icon.className = 'nav-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = entry.icon
        label.className = 'nav-label'; label.textContent = entry.label
        button.append(icon, label); nav.append(button)
      }
      if (!section.entries.length) {
        const hint = document.createElement('p')
        hint.className = 'sidebar-empty'
        hint.textContent = section.title === '来源书库' ? '在“我的”添加目录' : '在书库中管理分组'
        nav.append(hint)
      }
      libraries.append(nav)
    }
    this.updateActive()
    if (focused) [...libraries.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.libraryId === focused)?.focus({ preventScroll: true })
  }

  setLibrarySelection(selection: LibrarySelection) {
    this.selection = { ...selection }
    this.updateActive()
  }

  setActive(view: UiView) {
    this.activeView = view
    this.updateActive()
  }

  private updateActive() {
    const selected = this.selection
    const id = selected.groupId !== undefined ? `group:${selected.groupId}`
      : selected.sourceId !== undefined ? `source:${selected.sourceId}`
      : selected.format ? `format:${selected.format}` : selected.kind ? `kind:${selected.kind}` : undefined
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('.nav-item, .bottom-tab')) {
      const match = button.dataset.libraryId
        ? this.activeView === 'library' && button.dataset.libraryId === id
        : button.dataset.view === this.activeView && (button.id !== 'nav-library' || !id || !this.shortcuts.has(id))
      button.classList.toggle('active', match)
      if (match) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }

  private run(action: () => unknown) {
    try { Promise.resolve(action()).catch(this.context.reportError) }
    catch (error) { this.context.reportError(error) }
  }

  private openDrawer() {
    if (!this.media?.matches || this.drawerOpen) return
    this.drawerOpen = true
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.container.classList.add('sidebar-open')
    this.container.querySelector<HTMLElement>('#sidebar-backdrop')!.hidden = false
    const sidebar = this.container.querySelector<HTMLElement>('#library-sidebar')!
    sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true')
    this.container.querySelector('#btn-mobile-libraries')!.setAttribute('aria-expanded', 'true')
    const content = this.container.parentElement?.querySelector<HTMLElement>('.ui-content')
    this.inertElements = [...this.container.querySelectorAll<HTMLElement>('.mobile-header, .mobile-bottom-nav'),
      ...(content ? [content] : [])].map(element => ({ element, inert: element.inert }))
    this.inertElements.forEach(({ element }) => { element.inert = true })
    this.focusable()[0]?.focus({ preventScroll: true })
  }

  private closeDrawer(focus = true) {
    if (!this.drawerOpen) return
    this.drawerOpen = false
    this.container.classList.remove('sidebar-open')
    this.container.querySelector<HTMLElement>('#sidebar-backdrop')!.hidden = true
    const sidebar = this.container.querySelector('#library-sidebar')!
    sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal')
    this.container.querySelector('#btn-mobile-libraries')!.setAttribute('aria-expanded', 'false')
    this.inertElements.forEach(({ element, inert }) => { element.inert = inert })
    this.inertElements = []
    if (focus) this.previousFocus?.focus({ preventScroll: true })
    this.previousFocus = undefined
  }

  private focusable() {
    return [...this.container.querySelectorAll<HTMLButtonElement>('#library-sidebar button')]
      .filter(button => !button.disabled && getComputedStyle(button).display !== 'none')
  }

  private resize = () => { if (!this.media?.matches) this.closeDrawer(false) }
  private key = (event: KeyboardEvent) => {
    if (!this.drawerOpen) return
    if (event.key === 'Escape') {
      event.preventDefault(); this.closeDrawer()
    } else if (event.key === 'Tab') {
      const elements = this.focusable(), first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLButtonElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLButtonElement))) {
        event.preventDefault(); first.focus()
      }
    }
  }

  destroy() {
    this.closeDrawer(false)
    this.unsubs.splice(0).forEach(unsub => unsub())
  }
}
