/** 导航栏组件：桌面侧边栏与手机底部三导航栏，跟随深浅色与图书绿/漫画紫主题。 */
import type { UiContext, UiView } from './types'

export class NavManager {
  private activeView: UiView = 'home'
  private unsubs: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {
    this.render()
  }

  private render() {
    const isBooks = this.context.kind === 'books'
    const title = isBooks ? '图书' : '漫画'
    const subtitle = isBooks ? '把网盘变成随身书房' : '按自己的节奏，翻开下一页'

    this.container.innerHTML = `
      <aside class="desktop-sidebar">
        <div class="sidebar-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div class="brand-text">
            <h1 class="sidebar-title">${title}</h1>
            <p class="sidebar-subtitle">${subtitle}</p>
          </div>
        </div>
        <nav class="sidebar-nav" aria-label="应用导航">
          <button id="nav-home" class="nav-item active" data-view="home">
            <span class="nav-icon" aria-hidden="true">⌂</span>
            <span class="nav-label">首页</span>
          </button>
          <button id="nav-library" class="nav-item" data-view="library">
            <span class="nav-icon" aria-hidden="true">📖</span>
            <span class="nav-label">书库</span>
          </button>
          <button id="nav-me" class="nav-item" data-view="me">
            <span class="nav-icon" aria-hidden="true">👤</span>
            <span class="nav-label">我的</span>
          </button>
        </nav>
        <div class="sidebar-actions">
          <button id="btn-sidebar-settings" class="sidebar-action-btn">目录设置</button>
          <button id="btn-sidebar-close" class="sidebar-action-btn">返回网盘</button>
        </div>
      </aside>
      <header class="mobile-header">
        <div class="mobile-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <h1 class="mobile-title">${title}</h1>
        </div>
        <div class="mobile-actions">
          <button id="btn-mobile-settings" class="mobile-action-btn">目录设置</button>
          <button id="btn-mobile-close" class="mobile-action-btn">返回网盘</button>
        </div>
      </header>
      <nav class="mobile-bottom-nav" aria-label="移动端底部导航">
        <button id="tab-home" class="bottom-tab active" data-view="home" aria-label="首页">
          <span class="tab-icon" aria-hidden="true">⌂</span>
          <span class="tab-label">首页</span>
        </button>
        <button id="tab-library" class="bottom-tab" data-view="library" aria-label="书库">
          <span class="tab-icon" aria-hidden="true">📖</span>
          <span class="tab-label">书库</span>
        </button>
        <button id="tab-me" class="bottom-tab" data-view="me" aria-label="我的">
          <span class="tab-icon" aria-hidden="true">👤</span>
          <span class="tab-label">我的</span>
        </button>
      </nav>
    `

    this.bindEvents()
  }

  private bindEvents() {
    const bindNavClick = (selector: string, view: UiView) => {
      const btn = this.container.querySelector<HTMLButtonElement>(selector)
      if (btn) {
        const handler = () => {
          this.context.switchView(view)
        }
        btn.addEventListener('click', handler)
        this.unsubs.push(() => btn.removeEventListener('click', handler))
      }
    }

    bindNavClick('#nav-home', 'home')
    bindNavClick('#nav-library', 'library')
    bindNavClick('#nav-me', 'me')

    bindNavClick('#tab-home', 'home')
    bindNavClick('#tab-library', 'library')
    bindNavClick('#tab-me', 'me')

    const bindAction = (selector: string, action: () => unknown) => {
      const btn = this.container.querySelector<HTMLButtonElement>(selector)
      if (btn) {
        const handler = () => {
          try {
            Promise.resolve(action()).catch(this.context.reportError)
          } catch (error) {
            this.context.reportError(error)
          }
        }
        btn.addEventListener('click', handler)
        this.unsubs.push(() => btn.removeEventListener('click', handler))
      }
    }

    bindAction('#btn-sidebar-settings', () => this.context.drive.settings.open())
    bindAction('#btn-sidebar-close', () => this.context.closeApp())
    bindAction('#btn-mobile-settings', () => this.context.drive.settings.open())
    bindAction('#btn-mobile-close', () => this.context.closeApp())
  }

  setActive(view: UiView) {
    this.activeView = view
    const allButtons = this.container.querySelectorAll<HTMLButtonElement>(
      '.nav-item, .bottom-tab'
    )
    allButtons.forEach((btn) => {
      const match = btn.dataset.view === view
      btn.classList.toggle('active', match)
      btn.setAttribute('aria-selected', String(match))
    })
  }

  destroy() {
    this.unsubs.forEach((unsub) => unsub())
    this.unsubs = []
  }
}
