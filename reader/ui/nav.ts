/** 书库导航：桌面常驻侧栏；手机为极简顶栏（标题 + 搜索）、书库页横滑筛选标签与底部三标签，不再使用抽屉。 */
import { icon } from '../../ui/icons'
import { contentKind, sourceLabel, scopeFormats, type LibrarySnapshot } from '../library'
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
  private unsubs: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {
    this.render()
    if (this.context.library.manualShelves) {
      const create = document.createElement('button')
      create.id = 'btn-sidebar-create-shelf'; create.type = 'button'; create.className = 'sidebar-action-btn'; create.textContent = '创建书库'
      this.container.querySelector('.sidebar-actions')!.prepend(create)
    }
    this.refreshLibraries()
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
      if (!target || !this.container.contains(target) || target.disabled) return
      const shortcut = target.dataset.libraryId && this.shortcuts.get(target.dataset.libraryId)
      if (shortcut) {
        this.run(() => this.context.openLibrary
          ? this.context.openLibrary(shortcut.selection)
          : this.context.switchView('library'))
      } else if (target.dataset.view) {
        this.run(() => target.dataset.view === 'library' && this.context.openLibrary
          ? this.context.openLibrary({})
          : this.context.switchView(target.dataset.view as UiView))
      } else if (target.id === 'btn-sidebar-create-shelf') {
        this.run(() => this.context.createShelf?.())
      } else if (target.id === 'btn-mobile-search') {
        this.run(() => this.search())
      } else if (target.id.endsWith('-settings')) {
        this.run(() => this.context.drive.settings.open())
      } else if (target.id.endsWith('-close')) {
        this.run(() => this.context.closeApp())
      }
    }
    this.container.addEventListener('click', click)
    this.unsubs.push(() => this.container.removeEventListener('click', click))
  }

  /** 搜索：进入书库并聚焦搜索框；书库模式下停在书库列表时先进入当前或第一个书库。 */
  private async search() {
    const field = () => document.querySelector<HTMLInputElement>('#library-search')
    const first = this.context.library.snapshot.sources.config.sources[0]
    const selection = this.selection.sourceId === undefined && this.context.library.manualShelves && first
      ? { sourceId: first.nodeId } : this.selection
    if (this.activeView !== 'library' || !field()) await (this.context.openLibrary ? this.context.openLibrary(selection) : this.context.switchView('library'))
    field()?.focus()
  }

  private render() {
    const isBooks = this.context.kind === 'books'
    const title = this.context.kind === 'all' ? '阅读馆' : isBooks ? '图书' : '漫画'
    const subtitle = this.context.kind === 'all' ? '书与漫画，都在这里' : isBooks ? '把网盘变成随身书房' : '按自己的节奏，翻开下一页'
    this.container.innerHTML = `
      <aside id="library-sidebar" class="desktop-sidebar" aria-label="书库侧边栏">
        <div class="sidebar-heading">
          <div class="sidebar-brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <div class="brand-text">
              <h1 class="sidebar-title">${title}</h1>
              <p class="sidebar-subtitle">${subtitle}</p>
            </div>
          </div>
        </div>
        <div class="sidebar-scroll">
          <nav class="sidebar-nav" aria-label="应用导航">
            <button id="nav-home" class="nav-item active" data-view="home" type="button">
              <span class="nav-icon" aria-hidden="true">${icon('home')}</span><span class="nav-label">首页</span>
            </button>
            <button id="nav-library" class="nav-item" data-view="library" type="button">
              <span class="nav-icon" aria-hidden="true">${icon('library')}</span><span class="nav-label">全部书库</span>
            </button>
            <button id="nav-me" class="nav-item" data-view="me" type="button">
              <span class="nav-icon" aria-hidden="true">${icon('user')}</span><span class="nav-label">我的</span>
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
        <h1 class="mobile-title">${title}</h1>
        <button id="btn-mobile-search" class="tg-icon-btn mobile-action-btn" type="button" aria-label="搜索" title="搜索">${icon('search')}</button>
      </header>
      <div id="mobile-library-chips" class="tg-chips mobile-library-chips" role="toolbar" aria-label="书库筛选" hidden></div>
      <nav class="mobile-bottom-nav tg-tabbar" aria-label="移动端底部导航">
        <button id="tab-home" class="bottom-tab tg-tab active" data-view="home" type="button" aria-label="首页">
          <span class="tab-icon" aria-hidden="true">${icon('home')}</span><span class="tab-label">首页</span>
        </button>
        <button id="tab-library" class="bottom-tab tg-tab" data-view="library" type="button" aria-label="书库">
          <span class="tab-icon" aria-hidden="true">${icon('library')}</span><span class="tab-label">书库</span>
        </button>
        <button id="tab-me" class="bottom-tab tg-tab" data-view="me" type="button" aria-label="我的">
          <span class="tab-icon" aria-hidden="true">${icon('user')}</span><span class="tab-label">我的</span>
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
      label: sourceLabel(source),
      icon: '▱',
      title: source.path,
      selection: { sourceId: source.nodeId },
    }))
    const store = this.context.library.bookGroups
    const groups: LibraryShortcut[] = this.context.kind === 'comics' ? [] : store.groups.map(group => ({
      id: `group:${group.id}`, label: group.name, icon: '◇', selection: { groupId: group.id }, disabled: !store.ready,
    }))
    const sections = this.context.library.manualShelves
      ? [{ title: '我的书库', entries: sources }]
      : [
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
        hint.textContent = this.context.library.manualShelves ? '点击“创建书库”绑定目录' : section.title === '来源书库' ? '在“我的”添加目录' : '在书库中管理分组'
        nav.append(hint)
      }
      libraries.append(nav)
    }
    this.renderChips(sections.flatMap(section => section.entries))
    this.updateActive()
    if (focused) [...libraries.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.dataset.libraryId === focused)?.focus({ preventScroll: true })
  }

  /** 手机书库页顶部横滑筛选：取代原抽屉里的书库与类型快捷入口。 */
  private renderChips(entries: LibraryShortcut[]) {
    const chips = this.container.querySelector<HTMLElement>('#mobile-library-chips')!
    const all = document.createElement('button')
    all.type = 'button'; all.id = 'chip-library-all'; all.className = 'tg-chip library-chip'; all.dataset.view = 'library'; all.textContent = '全部'
    const buttons = entries.map(entry => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'tg-chip library-chip'
      button.dataset.libraryId = entry.id; button.disabled = !!entry.disabled
      button.title = entry.title ?? entry.label; button.textContent = entry.label
      return button
    })
    chips.replaceChildren(all, ...buttons)
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
    const id = this.context.library.manualShelves && selected.sourceId !== undefined ? `source:${selected.sourceId}`
      : selected.groupId !== undefined ? `group:${selected.groupId}`
      : selected.sourceId !== undefined ? `source:${selected.sourceId}`
      : selected.format ? `format:${selected.format}` : selected.kind ? `kind:${selected.kind}` : undefined
    const chips = this.container.querySelector<HTMLElement>('#mobile-library-chips')
    if (chips) chips.hidden = this.activeView !== 'library'
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('.nav-item, .bottom-tab, .library-chip')) {
      const match = button.dataset.libraryId
        ? this.activeView === 'library' && button.dataset.libraryId === id
        : button.dataset.view === this.activeView && (!['nav-library', 'chip-library-all'].includes(button.id) || !id || !this.shortcuts.has(id))
      button.classList.toggle('active', match)
      if (match) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }

  private run(action: () => unknown) {
    try { Promise.resolve(action()).catch(this.context.reportError) }
    catch (error) { this.context.reportError(error) }
  }

  destroy() {
    this.unsubs.splice(0).forEach(unsub => unsub())
  }
}
