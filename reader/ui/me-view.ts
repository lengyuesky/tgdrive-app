/** “我的”视图：想读、收藏、历史记录（时间序/分页）、多来源管理（根确认/旧迁移/扫描控制）、缓存配额与设置。 */
import type { UiContext } from './types'
import {
  type CatalogItem,
  type HistoryEntry,
  type SourceRoots,
} from '../library'
import { showConfirmModal } from './modals'

type MeSubTab = 'want' | 'fav' | 'history' | 'sources' | 'settings'

export class MeView {
  private lifecycle = new AbortController()
  private activeSubTab: MeSubTab = 'sources'
  private historyOffset = 0
  private historyPageSize = 20
  private historyEntries: HistoryEntry[] = []
  private historyHasMore = false

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {}

  async render(subTab?: MeSubTab) {
    this.destroy()
    this.lifecycle = new AbortController()
    if (subTab) this.activeSubTab = subTab

    this.container.innerHTML = `
      <div class="me-view-container">
        <!-- 头部子导航切换 -->
        <header class="me-header">
          <h2 class="me-title">个人中心与设置</h2>
          <div class="me-tabs" role="tablist" aria-label="个人中心子标签">
            <button id="me-tab-sources" class="me-tab-btn ${this.activeSubTab === 'sources' ? 'active' : ''}" role="tab" data-tab="sources">来源管理</button>
            <button id="me-tab-history" class="me-tab-btn ${this.activeSubTab === 'history' ? 'active' : ''}" role="tab" data-tab="history">阅读历史</button>
            <button id="me-tab-want" class="me-tab-btn ${this.activeSubTab === 'want' ? 'active' : ''}" role="tab" data-tab="want">想读清单</button>
            <button id="me-tab-fav" class="me-tab-btn ${this.activeSubTab === 'fav' ? 'active' : ''}" role="tab" data-tab="fav">收藏夹</button>
            <button id="me-tab-settings" class="me-tab-btn ${this.activeSubTab === 'settings' ? 'active' : ''}" role="tab" data-tab="settings">缓存与设置</button>
          </div>
        </header>

        <!-- 错误或提示信息条 -->
        <div id="me-alert-msg" class="me-alert" hidden></div>

        <!-- 内容区域 -->
        <div class="me-content">
          <section id="subview-sources" class="me-subview" ${this.activeSubTab !== 'sources' ? 'hidden' : ''}></section>
          <section id="subview-history" class="me-subview" ${this.activeSubTab !== 'history' ? 'hidden' : ''}></section>
          <section id="subview-want" class="me-subview" ${this.activeSubTab !== 'want' ? 'hidden' : ''}></section>
          <section id="subview-fav" class="me-subview" ${this.activeSubTab !== 'fav' ? 'hidden' : ''}></section>
          <section id="subview-settings" class="me-subview" ${this.activeSubTab !== 'settings' ? 'hidden' : ''}></section>
        </div>
      </div>
    `

    this.bindSubTabEvents()
    await this.renderCurrentSubTab()
  }

  private bindSubTabEvents() {
    const tabButtons = this.container.querySelectorAll<HTMLButtonElement>('.me-tab-btn')
    tabButtons.forEach((btn) => {
      btn.onclick = () => {
        const tab = btn.dataset.tab as MeSubTab
        if (tab && tab !== this.activeSubTab) {
          this.activeSubTab = tab
          tabButtons.forEach((b) => b.classList.toggle('active', b === btn))
          const subviews = this.container.querySelectorAll<HTMLElement>('.me-subview')
          subviews.forEach((v) => {
            v.hidden = v.id !== `subview-${tab}`
          })
          void this.renderCurrentSubTab()
        }
      }
    })
  }

  private async renderCurrentSubTab() {
    switch (this.activeSubTab) {
      case 'sources':
        await this.renderSourcesSubView()
        break
      case 'history':
        await this.renderHistorySubView()
        break
      case 'want':
        await this.renderWantSubView()
        break
      case 'fav':
        await this.renderFavSubView()
        break
      case 'settings':
        this.renderSettingsSubView()
        break
    }
  }

  /** 多来源管理：来源列表、添加来源（根确认）、旧迁移引导、显式刷新/暂停/取消 */
  private async renderSourcesSubView() {
    const subview = this.container.querySelector<HTMLElement>('#subview-sources')
    if (!subview) return

    const snapshot = this.context.library.snapshot
    let roots: SourceRoots = { roots: [], unavailable: [] }
    try {
      roots = await this.context.library.access.roots(this.lifecycle.signal)
    } catch {
      /* 降级 */
    }

    subview.innerHTML = `
      <div class="sources-subview-container">
        <!-- 扫描控制条 -->
        <div class="card-box scan-control-card">
          <div class="scan-control-header">
            <h3 class="card-title">书库扫描状态</h3>
            <div class="scan-buttons">
              <button id="btn-me-refresh" class="btn-primary">显式刷新</button>
              <button id="btn-me-pause" class="btn-secondary">暂停扫描</button>
              <button id="btn-me-cancel" class="btn-secondary">取消扫描</button>
            </div>
          </div>
          <div id="me-scan-progress-info" class="scan-progress-info">
            <p>状态：${snapshot.complete ? '已完成整理' : '空闲或仅已整理部分范围'}</p>
            <p>当前可用单元：${snapshot.units.length} 个 / 来源数：${snapshot.sources.config.sources.length} 个</p>
          </div>
        </div>

        <!-- 已配置来源列表 -->
        <div class="card-box sources-list-card">
          <h3 class="card-title">已添加来源 (${snapshot.sources.config.sources.length} / 16)</h3>
          <div id="sources-list" class="sources-list"></div>
        </div>

        <!-- 添加来源表单 -->
        <div class="card-box add-source-card">
          <h3 class="card-title">添加新来源</h3>
          <p class="card-subtitle">支持输入目录路径（如 / 或 /漫画）。每个应用最多添加 16 个来源。</p>
          <form id="form-add-source" class="add-source-form">
            <input
              id="input-source-path"
              type="text"
              placeholder="请输入目录路径，如 /漫画"
              aria-label="目录路径"
              required
            />
            <button id="btn-choose-source" class="btn-primary" type="button">选择并授权目录</button>
            <button id="btn-submit-source" class="btn-primary" type="submit">添加目录</button>
          </form>
          <p id="add-source-error" class="error-text" hidden></p>
        </div>
      </div>
    `

    // 绑定扫描控制
    const refreshBtn = subview.querySelector<HTMLButtonElement>('#btn-me-refresh')
    const pauseBtn = subview.querySelector<HTMLButtonElement>('#btn-me-pause')
    const cancelBtn = subview.querySelector<HTMLButtonElement>('#btn-me-cancel')

    if (refreshBtn) {
      refreshBtn.onclick = () => {
        this.context.library
          .refresh(this.lifecycle.signal)
          .then(() => this.renderSourcesSubView())
          .catch((err) => this.context.reportError(err))
      }
    }
    if (pauseBtn) {
      pauseBtn.onclick = () => {
        if (pauseBtn.textContent === '暂停扫描') {
          this.context.library.pause()
          pauseBtn.textContent = '继续扫描'
        } else {
          this.context.library.resume()
          pauseBtn.textContent = '暂停扫描'
        }
      }
    }
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        this.context.library.cancelScan()
      }
    }

    // 渲染来源列表
    const listEl = subview.querySelector<HTMLElement>('#sources-list')
    if (listEl) {
      listEl.replaceChildren()
      if (!snapshot.sources.config.sources.length) {
        listEl.innerHTML = '<p class="empty-state">尚未添加任何目录来源</p>'
      } else {
        snapshot.sources.config.sources.forEach((source) => {
          const rootInfo = roots.roots.find((r) => r.source.nodeId === source.nodeId)
          const unavail = roots.unavailable.find(
            (u) => u.source.nodeId === source.nodeId
          )

          const item = document.createElement('div')
          item.className = 'source-list-item'

          const info = document.createElement('div')
          info.className = 'source-item-info'

          const pathTitle = document.createElement('strong')
          pathTitle.className = 'source-item-path'
          pathTitle.textContent = source.path || `节点 ${source.nodeId}`

          const statusBadge = document.createElement('span')
          statusBadge.className = `badge-source ${unavail ? 'badge-error' : 'badge-success'}`
          statusBadge.textContent = unavail
            ? `不可用: ${unavail.message}`
            : source.path === '/'
              ? '根目录 (已确认)'
              : '正常'

          info.append(pathTitle, statusBadge)

          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.className = 'btn-danger btn-sm'
          removeBtn.textContent = '移除来源'
          removeBtn.onclick = async () => {
            const base = this.context.library.snapshot.sources
            const confirmed = await showConfirmModal({
              title: '移除目录来源',
              message: `确定移除目录 ${source.path} 吗？用户已保存的进度和书签不会被删除。`,
              confirmText: '确认移除',
              danger: true,
              signal: this.lifecycle.signal,
            })
            if (!confirmed) return

            try {
              await this.context.library.removeSource(source.nodeId, base)
              await this.renderSourcesSubView()
            } catch (err) {
              this.context.reportError(err)
            }
          }

          item.append(info, removeBtn)
          listEl.append(item)
        })
      }
    }

    // 绑定添加来源表单
    const form = subview.querySelector<HTMLFormElement>('#form-add-source')
    const pathInput = subview.querySelector<HTMLInputElement>('#input-source-path')
    const errText = subview.querySelector<HTMLElement>('#add-source-error')

    const choose = subview.querySelector<HTMLButtonElement>('#btn-choose-source')
    if (choose) {
      choose.hidden = !this.context.drive.can?.('ui.authorizeDirectory')
      choose.onclick = async () => {
        try {
          const selected = await this.context.drive.ui.authorizeDirectory?.(pathInput?.value || '/')
          if (selected && pathInput) { pathInput.value = selected; form?.requestSubmit() }
        } catch (error) { this.context.reportError(error) }
      }
    }
    if (form && pathInput && errText) {
      form.onsubmit = async (e) => {
        e.preventDefault()
        errText.hidden = true
        const path = pathInput.value.trim()
        if (!path) return

        let confirmedRoot = false
        if (path === '/') {
          const confirmed = await showConfirmModal({
            title: '添加根目录来源确认',
            message:
              '添加根目录（/）将授权扫描整个网盘。扫描包含大量文件时可能耗时较长。是否确认添加？',
            confirmText: '确认添加根目录',
          })
          if (!confirmed) return
          confirmedRoot = true
        }

        const base = this.context.library.snapshot.sources
        try {
          const added = await this.context.library.addSource(path, {
            confirmedRoot,
            base,
          })
          void added.scan.catch(() => {})
          pathInput.value = ''
          await this.renderSourcesSubView()
        } catch (err) {
          errText.textContent = `添加失败：${err instanceof Error ? err.message : String(err)}`
          errText.hidden = false
        }
      }
    }
  }

  /** 阅读历史：按真实 updated_at 时间序分页展示 */
  private async renderHistorySubView() {
    const subview = this.container.querySelector<HTMLElement>('#subview-history')
    if (!subview) return

    subview.innerHTML = `
      <div class="history-subview-container">
        <h3 class="card-title">阅读历史 (按时间倒序排列)</h3>
        <div id="history-items-list" class="history-list">
          <div class="loading-placeholder">正在加载历史记录…</div>
        </div>
        <div class="history-pagination">
          <button id="btn-history-prev" class="btn-page" disabled>上一批</button>
          <button id="btn-history-next" class="btn-page" disabled>下一批</button>
        </div>
      </div>
    `

    const listEl = subview.querySelector<HTMLElement>('#history-items-list')
    const prevBtn = subview.querySelector<HTMLButtonElement>('#btn-history-prev')
    const nextBtn = subview.querySelector<HTMLButtonElement>('#btn-history-next')

    try {
      const pageResult = await this.context.library.history.page(
        this.historyOffset,
        this.historyPageSize,
        this.lifecycle.signal
      )

      if (!listEl) return
      listEl.replaceChildren()

      if (!pageResult.entries.length) {
        listEl.innerHTML = '<p class="empty-state">暂无阅读历史记录</p>'
      } else {
        pageResult.entries.forEach((entry) => {
          const row = document.createElement('div')
          row.className = 'history-item-row'

          const titleBtn = document.createElement('button')
          titleBtn.type = 'button'
          titleBtn.className = 'history-title-btn'

          const title = entry.progress.title || entry.progress.file.name
          const timeStr = entry.updatedAt
            ? new Date(entry.updatedAt).toLocaleString()
            : '未知时间'
          const progStr = entry.progress.summary?.label
            ? entry.progress.summary.label
            : `第 ${entry.progress.location.index + 1} 页/节`

          titleBtn.textContent = `${title} (上次阅读: ${progStr} · ${timeStr})`
          titleBtn.onclick = () => {
            void this.context
              .openReader(entry.nodeId)
              .catch(this.context.reportError)
          }

          row.append(titleBtn)
          listEl.append(row)
        })
      }

      if (prevBtn) {
        prevBtn.disabled = this.historyOffset === 0
        prevBtn.onclick = () => {
          if (this.historyOffset >= this.historyPageSize) {
            this.historyOffset -= this.historyPageSize
            void this.renderHistorySubView()
          }
        }
      }
      if (nextBtn) {
        nextBtn.disabled = pageResult.nextOffset === null
        nextBtn.onclick = () => {
          if (pageResult.nextOffset !== null) {
            this.historyOffset = pageResult.nextOffset
            void this.renderHistorySubView()
          }
        }
      }
    } catch (err) {
      if (listEl) {
        const p = document.createElement('p')
        p.className = 'error-text'
        p.textContent = `历史加载失败：${err instanceof Error ? err.message : String(err)}`
        listEl.replaceChildren(p)
      }
    }
  }

  private renderWantSubView() { return this.renderFlagList('want') }
  private renderFavSubView() { return this.renderFlagList('fav') }

  /** 收藏和想读使用有界分页，列表失败保留重试入口。 */
  private async renderFlagList(kind: 'want' | 'fav', offset = 0): Promise<void> {
    const container = this.container.querySelector<HTMLElement>('#subview-' + kind)
    if (!container) return
    const signal = this.lifecycle.signal
    container.replaceChildren()
    const title = document.createElement('h3'), list = document.createElement('div'), controls = document.createElement('div')
    title.textContent = kind === 'want' ? '想读清单' : '我的收藏'
    list.id = kind + '-items-list'; list.className = 'simple-cards-list'
    controls.className = 'pagination'; controls.setAttribute('aria-label', title.textContent + '分页')
    container.append(title, list, controls)
    list.textContent = '正在加载…'
    const button = (label: string, action: () => void) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.onclick = action; controls.append(el); return el }
    try {
      const state = await this.context.library.loadReadingState(signal)
      if (signal.aborted || !container.contains(list)) return
      const result = this.context.library.query({ [kind === 'want' ? 'wantToRead' : 'favorite']: true, offset, limit: 40 }, state.readings, state.flags)
      if (offset && !result.items.length && result.total) return this.renderFlagList(kind, Math.floor((result.total - 1) / 40) * 40)
      list.replaceChildren(...result.items.map(item => this.createSimpleRow(item)))
      if (!result.items.length) list.textContent = kind === 'want' ? '尚未添加任何想读作品' : '尚未收藏任何作品'
      const count = document.createElement('span')
      count.textContent = '共 ' + result.total + ' 项 · 第 ' + (Math.floor(offset / 40) + 1) + ' / ' + Math.max(1, Math.ceil(result.total / 40)) + ' 页' + (result.complete ? '' : '（仅已整理范围）')
      controls.append(count)
      button('上一页', () => { void this.renderFlagList(kind, Math.max(0, offset - 40)) }).disabled = offset === 0
      button('下一页', () => { void this.renderFlagList(kind, result.nextOffset ?? offset) }).disabled = result.nextOffset === null
    } catch (error) {
      if (signal.aborted || !container.contains(list)) return
      const message = document.createElement('p'); message.className = 'error-text'
      message.textContent = '加载失败：' + (error instanceof Error ? error.message : String(error)); list.replaceChildren(message)
      button('重试', () => { this.context.library.invalidateReadingState(); void this.renderFlagList(kind, offset) })
    }
  }

  private createSimpleRow(item: CatalogItem): HTMLElement {
    const row = document.createElement('div')
    row.className = 'simple-row'

    const titleBtn = document.createElement('button')
    titleBtn.type = 'button'
    titleBtn.className = 'simple-row-btn'

    const first = item.units[0]!
    const title = item.metadata.title || first.file.name.replace(/\.[^.]+$/, '')
    const format = first.format.toUpperCase()

    titleBtn.textContent = `${title} [${format}]`
    titleBtn.onclick = () => {
      this.context.openDetail(item)
    }

    row.append(titleBtn)
    return row
  }

  /** 缓存配额展示与应用设置 */
  private renderSettingsSubView() {
    const subview = this.container.querySelector<HTMLElement>('#subview-settings')
    if (!subview) return

    const coverStore = this.context.library.covers.cache.store
    const metaStatus = this.context.library.metadata.cache.status

    subview.innerHTML = `
      <div class="settings-subview-container">
        <div class="card-box quota-card">
          <h3 class="card-title">缓存与存储配额</h3>
          <div class="quota-item">
            <span class="quota-label">封面缓存:</span>
            <span class="quota-value" id="cover-quota">${coverStore.persistent ? '正在统计…' : `本次会话 ${coverStore.memoryStatus.entries} 张（宿主版本较旧，封面不跨会话保存）`}</span>
          </div>
          <p class="quota-hint">${coverStore.persistent ? '封面保存在服务器封面库，再次打开直接显示；可在网盘「应用中心 → 设置」中查看并清理。' : ''}</p>
          <div class="quota-item">
            <span class="quota-label">元数据缓存（上限 4 MiB）:</span>
            <span class="quota-value">${(metaStatus.bytes / 1024).toFixed(1)} KB / 共 ${metaStatus.entries} 项 (${metaStatus.mode === 'persistent' ? '持久缓存' : '本次会话'})</span>
          </div>
        </div>

        <div class="card-box app-settings-card">
          <h3 class="card-title">网盘与应用设置</h3>
          <div class="settings-actions">
            <button id="btn-open-settings" class="btn-primary">打开网盘目录设置</button>
            <button id="btn-close-app" class="btn-secondary">返回网盘</button>
          </div>
        </div>
      </div>
    `

    if (coverStore.persistent) {
      const signal = this.lifecycle.signal
      void coverStore.stats(signal).then(stats => {
        const target = subview.querySelector<HTMLElement>('#cover-quota')
        if (!stats || !target || signal.aborted) return
        const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)
        target.textContent = `${stats.entries} 张 · ${mib(stats.bytes)} MiB / ${mib(stats.limit_bytes)} MiB（服务器封面库）`
      }).catch(() => {
        const target = subview.querySelector<HTMLElement>('#cover-quota')
        if (target && !signal.aborted) target.textContent = '暂时无法统计'
      })
    }

    const openSettingsBtn = subview.querySelector<HTMLButtonElement>(
      '#btn-open-settings'
    )
    const closeAppBtn = subview.querySelector<HTMLButtonElement>('#btn-close-app')

    if (openSettingsBtn) {
      openSettingsBtn.onclick = () => this.context.drive.settings.open()
    }
    if (closeAppBtn) {
      closeAppBtn.onclick = () => this.context.closeApp()
    }
  }

  destroy() {
    this.lifecycle.abort()
  }
}
