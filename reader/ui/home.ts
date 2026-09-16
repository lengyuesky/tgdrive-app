/** 首页视图：续读卡直接进阅读器，最近加入与想读封面进详情。 */
import type { UiContext } from './types'
import {
  ViewportCoverLoader,
  type CatalogItem,
  type ReadingUnit,
  type Work,
  type UnitReading,
} from '../library'

export class HomeView {
  private coverLoader?: ViewportCoverLoader
  private lifecycle = new AbortController()

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {}

  async render() {
    this.destroy()
    this.lifecycle = new AbortController()
    this.coverLoader =
      typeof IntersectionObserver !== 'undefined'
        ? new ViewportCoverLoader(
            this.context.library.covers,
            this.lifecycle.signal
          )
        : undefined

    this.container.innerHTML = `
      <div class="home-container">
        <section class="home-section continue-section">
          <h2 class="section-title">继续阅读</h2>
          <div id="home-continue-card" class="continue-card-wrapper">
            <div class="loading-placeholder">正在加载阅读记录…</div>
          </div>
        </section>
        <section class="home-section recent-added-section">
          <div class="section-header">
            <h2 class="section-title">最近加入</h2>
            <button id="btn-home-view-all" class="section-more-btn">查看全部</button>
          </div>
          <div id="home-recent-grid" class="home-grid">
            <div class="loading-placeholder">正在加载…</div>
          </div>
        </section>
        <section id="home-want-section" class="home-section want-section" hidden>
          <div class="section-header">
            <h2 class="section-title">想读清单</h2>
          </div>
          <div id="home-want-grid" class="home-grid"></div>
        </section>
      </div>
    `

    const viewAllBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-home-view-all'
    )
    if (viewAllBtn) {
      viewAllBtn.onclick = () => this.context.switchView('library')
    }

    try {
      await this.loadData()
    } catch (error) {
      this.context.reportError(error)
    }
  }

  private async loadData() {
    const readingState = await this.context.library.loadReadingState(
      this.lifecycle.signal
    )

    // 1. 查找最新阅读记录用于续读卡
    await this.renderContinueCard(readingState.readings)

    // 2. 加载最近加入 (sort: 'added')
    const addedResult = this.context.library.query(
      { sort: 'added', limit: 8 },
      readingState.readings,
      readingState.flags
    )
    this.renderRecentAdded(addedResult.items)

    // 3. 加载想读清单 (wantToRead: true)
    const wantResult = this.context.library.query(
      { wantToRead: true, limit: 8 },
      readingState.readings,
      readingState.flags
    )
    this.renderWantToRead(wantResult.items)
  }

  private async renderContinueCard(readings: Map<number, UnitReading>) {
    const wrapper = this.container.querySelector('#home-continue-card')
    if (!wrapper) return

    const units = this.context.library.snapshot.units
    const unitMap = new Map(units.map((u) => [u.nodeId, u]))

    // 按当前可用单元范围筛选最新历史记录，避免失效来源首项遮蔽后续有效历史
    let latestUnit: ReadingUnit | undefined
    let latestReading: UnitReading | undefined

    const historySnap = this.context.library.history.snapshot
    for (const row of historySnap.rows) {
      if (unitMap.has(row.nodeId)) {
        latestUnit = unitMap.get(row.nodeId)
        latestReading = readings.get(row.nodeId)
        break
      }
    }

    if (!latestUnit) {
      let maxTime = 0
      for (const [nodeId, reading] of readings.entries()) {
        if (reading.updatedAt > maxTime && unitMap.has(nodeId)) {
          maxTime = reading.updatedAt
          latestUnit = unitMap.get(nodeId)
          latestReading = reading
        }
      }
    }

    if (!latestUnit) {
      wrapper.innerHTML = `
        <div class="empty-continue-card">
          <p class="empty-hint">暂无阅读记录，去书库挑选作品开始阅读吧</p>
          <button id="btn-go-library" class="btn-primary">浏览书库</button>
        </div>
      `
      const goBtn = wrapper.querySelector<HTMLButtonElement>('#btn-go-library')
      if (goBtn) goBtn.onclick = () => this.context.switchView('library')
      return
    }

    // 找到该 unit 对应的 Work 或名称
    const works = this.context.library.snapshot.works.rows
    const work = works.find((w) =>
      w.members.some((m) => m.unitId === latestUnit.nodeId)
    )

    const meta = work?.overrides.title
      ? work.overrides.title
      : latestUnit.file.name.replace(/\.[^.]+$/, '')

    let progressText = '已打开过'
    if (latestReading?.summary?.label) {
      progressText = `读至：${latestReading.summary.label}`
    } else if (latestReading?.summary?.percent !== undefined) {
      progressText = `已读 ${Math.round(latestReading.summary.percent)}%`
    } else if (latestReading?.location) {
      progressText = `读至 第 ${latestReading.location.index + 1} 页/节`
    }

    wrapper.replaceChildren()
    const card = document.createElement('div')
    card.className = 'continue-card'
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.setAttribute('aria-label', `继续阅读 ${meta}`)

    const coverContainer = document.createElement('div')
    coverContainer.className = 'card-cover continue-cover'
    const coverArt = document.createElement('div')
    coverArt.className = 'cover-art'
    const initial = document.createElement('span')
    initial.className = 'cover-initial'
    initial.textContent = meta.slice(0, 1)
    coverArt.append(initial)
    coverContainer.append(coverArt)
    this.coverLoader?.observe(coverArt, latestUnit)

    const info = document.createElement('div')
    info.className = 'continue-info'

    const tag = document.createElement('span')
    tag.className = 'continue-tag'
    tag.textContent = '上次读到'

    const title = document.createElement('h3')
    title.className = 'continue-title'
    title.textContent = meta

    const prog = document.createElement('p')
    prog.className = 'continue-progress'
    prog.textContent = progressText

    const actionBtn = document.createElement('button')
    actionBtn.id = 'btn-continue-reading'
    actionBtn.className = 'btn-primary continue-btn'
    actionBtn.textContent = '继续阅读'

    const launch = () => {
      void this.context.openReader(latestUnit.nodeId).catch(this.context.reportError)
    }

    card.addEventListener('click', launch)
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      launch()
    })
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        launch()
      }
    })

    info.append(tag, title, prog, actionBtn)
    card.append(coverContainer, info)
    wrapper.append(card)
  }

  private renderRecentAdded(items: CatalogItem[]) {
    const grid = this.container.querySelector('#home-recent-grid')
    if (!grid) return
    grid.replaceChildren()

    if (!items.length) {
      grid.innerHTML = '<div class="empty-state">书库暂无内容，请在“我的”中添加来源</div>'
      return
    }

    items.forEach((item) => {
      const card = this.createItemCard(item)
      grid.append(card)
    })
  }

  private renderWantToRead(items: CatalogItem[]) {
    const section = this.container.querySelector<HTMLElement>('#home-want-section')
    const grid = this.container.querySelector('#home-want-grid')
    if (!section || !grid) return

    if (!items.length) {
      section.hidden = true
      return
    }

    section.hidden = false
    grid.replaceChildren()
    items.forEach((item) => {
      const card = this.createItemCard(item)
      grid.append(card)
    })
  }

  private createItemCard(item: CatalogItem): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'library-card'
    card.setAttribute('data-id', item.id)

    const firstUnit = item.units[0]!
    const title = item.metadata.title || firstUnit.file.name.replace(/\.[^.]+$/, '')

    const coverWrapper = document.createElement('div')
    coverWrapper.className = 'card-cover'
    const coverArt = document.createElement('div')
    coverArt.className = 'cover-art'
    const initial = document.createElement('span')
    initial.className = 'cover-initial'
    initial.textContent = title.slice(0, 1)

    const mark = document.createElement('span')
    mark.className = 'file-mark'
    mark.textContent =
      firstUnit.format === 'images' ? '目录' : firstUnit.format.toUpperCase()

    coverArt.append(initial, mark)
    coverWrapper.append(coverArt)
    this.coverLoader?.observe(coverArt, firstUnit)

    const info = document.createElement('div')
    info.className = 'card-info'

    const titleEl = document.createElement('strong')
    titleEl.className = 'card-title'
    titleEl.textContent = title

    const metaEl = document.createElement('span')
    metaEl.className = 'file-meta'
    if (item.units.length > 1) {
      metaEl.textContent = `共 ${item.units.length} 卷/话`
    } else if (item.metadata.authors?.length) {
      metaEl.textContent = item.metadata.authors.join(', ')
    } else {
      metaEl.textContent = firstUnit.file.path
    }

    info.append(titleEl, metaEl)
    card.append(coverWrapper, info)

    // 普通封面点击进详情
    card.addEventListener('click', () => {
      this.context.openDetail(item)
    })

    return card
  }

  destroy() {
    this.lifecycle.abort()
    this.coverLoader?.destroy()
    this.coverLoader = undefined
  }
}
