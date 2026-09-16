/** 书库视图：两列封面、搜索筛选排序、作品/文件切换、部分范围提示、SDK文件分页兜底与滚动恢复。 */
import type { UiContext, LibraryFilterState } from './types'
import type { FileEntry } from '../../sdk/types'
import {
  ViewportCoverLoader,
  type CatalogItem,
  type ReadingUnit,
  type UnitFormat,
  type ReadingStatus,
  type ScanProgress,
  unitFormat,
  aggregateReading,
} from '../library'

export class LibraryView {
  private coverLoader?: ViewportCoverLoader
  private lifecycle = new AbortController()
  private state: LibraryFilterState = {
    query: '',
    format: undefined,
    sourceId: undefined,
    status: undefined,
    sort: 'title',
    view: 'works',
    offset: 0,
    scrollTop: 0,
  }
  private searchTimer?: ReturnType<typeof setTimeout>
  private loadGeneration = 0
  private totalItems = 0
  private pageSize = 40
  private isScanning = false
  private currentProgress?: ScanProgress
  private sdkPageCursors = new Map<number, string | null>()
  private hasMore = false

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {}

  getState(): LibraryFilterState {
    const scrollEl = this.container.closest('.ui-content') || this.container
    this.state.scrollTop = scrollEl.scrollTop
    return { ...this.state }
  }

  setState(saved: Partial<LibraryFilterState>) {
    Object.assign(this.state, saved)
  }

  async render(restoreScroll = false) {
    this.destroy()
    this.lifecycle = new AbortController()
    this.coverLoader =
      typeof IntersectionObserver !== 'undefined'
        ? new ViewportCoverLoader(
            this.context.library.covers,
            this.lifecycle.signal
          )
        : undefined

    const isBooks = this.context.kind === 'books'
    const snapshot = this.context.library.snapshot

    this.container.innerHTML = `
      <div class="library-view-container">
        <!-- 搜索与筛选工具栏 -->
        <div class="library-toolbar">
          <div class="toolbar-search-row">
            <input
              id="library-search"
              type="search"
              placeholder="搜索书名或作者…"
              aria-label="搜索书名或作者"
            />
            <button id="btn-library-refresh" class="btn-refresh" title="刷新书库">刷新</button>
            <div class="view-toggle">
              <button id="btn-view-works" class="toggle-btn ${this.state.view === 'works' ? 'active' : ''}" type="button">作品</button>
              <button id="btn-view-files" class="toggle-btn ${this.state.view === 'files' ? 'active' : ''}" type="button">文件</button>
            </div>
          </div>
          <div class="toolbar-filters-row">
            <select id="filter-format" aria-label="筛选格式">
              <option value="">全部格式</option>
              ${
                isBooks
                  ? `
                <option value="txt">TXT 文本</option>
                <option value="epub">EPUB 电子书</option>
                <option value="pdf">PDF 文档</option>
              `
                  : `
                <option value="cbz">CBZ 归档</option>
                <option value="zip">ZIP 压缩包</option>
                <option value="images">图片目录</option>
              `
              }
            </select>
            <select id="filter-source" aria-label="筛选来源">
              <option value="">全部来源</option>
            </select>
            <select id="filter-status" aria-label="筛选阅读状态">
              <option value="">全部状态</option>
              <option value="unread">未读</option>
              <option value="reading">在读</option>
              <option value="read">已读</option>
            </select>
            <select id="sort-select" aria-label="排序方式">
              <option value="title">按名称排序</option>
              <option value="added">按加入时间</option>
              <option value="recent">按最近阅读</option>
            </select>
          </div>
        </div>

        <!-- 扫描状态提示条 -->
        <div id="scan-status-bar" class="scan-status-bar" hidden>
          <span id="scan-status-text">正在扫描新增文件…</span>
          <div class="scan-actions">
            <button id="btn-scan-pause" class="btn-sm">暂停</button>
            <button id="btn-scan-cancel" class="btn-sm">取消</button>
          </div>
        </div>

        <!-- 范围限制与错误提示条 -->
        <div id="scope-notice" class="scope-notice" hidden>
          <span id="scope-notice-text">仅已整理范围；可切换文件视图继续查找</span>
          <button id="btn-switch-file-view" class="btn-link">切换到文件视图</button>
        </div>

        <!-- 书库内容网格 (两列/自适应) -->
        <div id="library-status" role="status" class="library-status-msg"></div>
        <div id="items" class="library-grid" role="list"></div>

        <!-- 分页栏 -->
        <div class="library-pagination">
          <button id="btn-prev-page" class="btn-page" disabled>上一页</button>
          <span id="page-info" class="page-indicator">第 1 页</span>
          <button id="btn-next-page" class="btn-page" disabled>下一页</button>
        </div>
      </div>
    `

    this.bindEvents()
    await this.loadItems()

    if (restoreScroll && this.state.scrollTop > 0) {
      const scrollEl = this.container.closest('.ui-content') || this.container
      scrollEl.scrollTop = this.state.scrollTop
    }
  }

  private bindEvents() {
    // 搜索输入防抖
    const searchInput = this.container.querySelector<HTMLInputElement>('#library-search')
    if (searchInput) {
      searchInput.value = this.state.query
      searchInput.addEventListener('input', () => {
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => {
          this.state.query = searchInput.value.trim()
          this.state.offset = 0
          this.sdkPageCursors.clear()
          void this.loadItems()
        }, 300)
      })
    }

    // 刷新按钮
    const refreshBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-library-refresh'
    )
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.showScanning(true, '正在扫描新增内容…')
        this.context.library
          .refresh(this.lifecycle.signal)
          .then(() => this.loadItems())
          .catch((err) => {
            this.showScanning(false)
            this.context.reportError(err)
          })
      })
    }

    // 作品/文件视图切换
    const worksBtn = this.container.querySelector<HTMLButtonElement>('#btn-view-works')
    const filesBtn = this.container.querySelector<HTMLButtonElement>('#btn-view-files')
    if (worksBtn && filesBtn) {
      worksBtn.onclick = () => {
        if (this.state.view !== 'works') {
          this.state.view = 'works'
          this.state.offset = 0
          this.sdkPageCursors.clear()
          worksBtn.classList.add('active')
          filesBtn.classList.remove('active')
          void this.loadItems()
        }
      }
      filesBtn.onclick = () => {
        if (this.state.view !== 'files') {
          this.state.view = 'files'
          this.state.offset = 0
          this.sdkPageCursors.clear()
          filesBtn.classList.add('active')
          worksBtn.classList.remove('active')
          void this.loadItems()
        }
      }
    }

    // 格式筛选
    const formatSelect = this.container.querySelector<HTMLSelectElement>(
      '#filter-format'
    )
    if (formatSelect) {
      formatSelect.value = this.state.format ?? ''
      formatSelect.onchange = () => {
        this.state.format = (formatSelect.value as UnitFormat) || undefined
        this.state.offset = 0
        this.sdkPageCursors.clear()
        void this.loadItems()
      }
    }

    // 来源筛选
    const sourceSelect = this.container.querySelector<HTMLSelectElement>(
      '#filter-source'
    )
    if (sourceSelect) {
      const sources = this.context.library.snapshot.sources.config.sources
      sources.forEach((s) => {
        const opt = document.createElement('option')
        opt.value = String(s.nodeId)
        opt.textContent = s.path || ('来源 ' + s.nodeId)
        sourceSelect.append(opt)
      })
      sourceSelect.value =
        this.state.sourceId !== undefined ? String(this.state.sourceId) : ''
      sourceSelect.onchange = () => {
        this.state.sourceId = sourceSelect.value ? Number(sourceSelect.value) : undefined
        this.state.offset = 0
        this.sdkPageCursors.clear()
        void this.loadItems()
      }
    }

    // 状态筛选
    const statusSelect = this.container.querySelector<HTMLSelectElement>(
      '#filter-status'
    )
    if (statusSelect) {
      statusSelect.value = this.state.status ?? ''
      statusSelect.onchange = () => {
        this.state.status = (statusSelect.value as ReadingStatus) || undefined
        this.state.offset = 0
        this.sdkPageCursors.clear()
        void this.loadItems()
      }
    }

    // 排序
    const sortSelect = this.container.querySelector<HTMLSelectElement>('#sort-select')
    if (sortSelect) {
      sortSelect.value = this.state.sort
      sortSelect.onchange = () => {
        this.state.sort = sortSelect.value as 'title' | 'added' | 'recent'
        this.state.offset = 0
        this.sdkPageCursors.clear()
        void this.loadItems()
      }
    }

    // 范围提示中的切换到文件视图按钮
    const switchFileBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-switch-file-view'
    )
    if (switchFileBtn) {
      switchFileBtn.onclick = () => {
        this.state.view = 'files'
        this.state.offset = 0
        this.sdkPageCursors.clear()
        if (worksBtn) worksBtn.classList.remove('active')
        if (filesBtn) filesBtn.classList.add('active')
        void this.loadItems()
      }
    }

    // 分页
    const prevBtn = this.container.querySelector<HTMLButtonElement>('#btn-prev-page')
    const nextBtn = this.container.querySelector<HTMLButtonElement>('#btn-next-page')
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (this.state.offset >= this.pageSize) {
          this.state.offset -= this.pageSize
          void this.loadItems()
        }
      }
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (this.hasMore) {
          this.state.offset += this.pageSize
          void this.loadItems()
        }
      }
    }

    // 扫描控制按钮
    const pauseBtn = this.container.querySelector<HTMLButtonElement>('#btn-scan-pause')
    const cancelBtn = this.container.querySelector<HTMLButtonElement>('#btn-scan-cancel')
    if (pauseBtn) {
      pauseBtn.onclick = () => {
        if (pauseBtn.textContent === '暂停') {
          this.context.library.pause()
          pauseBtn.textContent = '继续'
        } else {
          this.context.library.resume()
          pauseBtn.textContent = '暂停'
        }
      }
    }
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        this.context.library.cancelScan()
        this.showScanning(false)
      }
    }
  }

  showScanning(show: boolean, message?: string) {
    this.isScanning = show
    const bar = this.container.querySelector<HTMLElement>('#scan-status-bar')
    const textEl = this.container.querySelector<HTMLElement>('#scan-status-text')
    if (!bar) return
    bar.hidden = !show
    if (textEl && message) textEl.textContent = message
  }

  onScanProgress(progress: ScanProgress) {
    this.currentProgress = progress
    if (!progress.complete && progress.phase === 'scanning') {
      this.showScanning(
        true,
        `正在扫描：已处理 ${progress.nodes} 节点 / 发现 ${progress.units} 个作品`
      )
    } else if (progress.complete) {
      this.showScanning(false)
      void this.loadItems()
    }
  }

  private async loadItems() {
    const activeGen = ++this.loadGeneration
    this.coverLoader?.clear()
    const itemsContainer = this.container.querySelector<HTMLElement>('#items')
    const statusMsg = this.container.querySelector<HTMLElement>('#library-status')
    const scopeNotice = this.container.querySelector<HTMLElement>('#scope-notice')
    const prevBtn = this.container.querySelector<HTMLButtonElement>('#btn-prev-page')
    const nextBtn = this.container.querySelector<HTMLButtonElement>('#btn-next-page')
    const pageInfo = this.container.querySelector<HTMLElement>('#page-info')

    if (!itemsContainer || !statusMsg) return
    statusMsg.textContent = '正在加载书库…'
    itemsContainer.replaceChildren()

    try {
      const readingState = await this.context.library.loadReadingState(
        this.lifecycle.signal
      )
      if (activeGen !== this.loadGeneration || this.lifecycle.signal.aborted) return

      const isFilesView = this.state.view === 'files'
      const snapshot = this.context.library.snapshot
      const isComplete = snapshot.complete

      // 1. 先查询已索引数据
      const result = this.context.library.query(
        {
          query: this.state.query || undefined,
          format: this.state.format,
          sourceId: this.state.sourceId,
          status: this.state.status,
          sort: this.state.sort,
          view: this.state.view,
          offset: this.state.offset,
          limit: this.pageSize,
        },
        readingState.readings,
        readingState.flags
      )
      if (activeGen !== this.loadGeneration || this.lifecycle.signal.aborted) return

      let displayItems: CatalogItem[] = result.items
      let hasMore = result.nextOffset !== null
      const currentPage = Math.floor(this.state.offset / this.pageSize) + 1

      // 2. 如果处于文件视图且索引不完整（或已索引条目已展示完毕/无匹配），使用 SDK 游标分页兜底
      if (isFilesView && (!isComplete || this.state.offset >= result.total)) {
        const sources = snapshot.sources.config.sources
        const targetSourceId = this.state.sourceId ?? sources[0]?.nodeId
        if (targetSourceId !== undefined) {
          const cursor = this.sdkPageCursors.get(currentPage) ?? null
          const indexedNodeIds = new Set(snapshot.units.map((u) => u.nodeId))

          let rawFiles: FileEntry[] = []
          let sdkHasMore = false
          let nextCursor: string | null = null

          if (this.state.query) {
            const searchRes = await this.context.library.access.search(
              targetSourceId,
              { q: this.state.query, cursor },
              this.lifecycle.signal
            )
            if (activeGen !== this.loadGeneration || this.lifecycle.signal.aborted) return
            rawFiles = searchRes.results
            sdkHasMore = searchRes.has_more
            nextCursor = searchRes.next_cursor
          } else {
            const listRes = await this.context.library.access.list(
              targetSourceId,
              cursor,
              this.lifecycle.signal
            )
            if (activeGen !== this.loadGeneration || this.lifecycle.signal.aborted) return
            rawFiles = listRes.entries
            sdkHasMore = listRes.has_more
            nextCursor = listRes.next_cursor
          }

          if (nextCursor) {
            this.sdkPageCursors.set(currentPage + 1, nextCursor)
          }

          // 转换为未索引单元 CatalogItem 并过滤格式及已索引去重
          const unindexedItems: CatalogItem[] = rawFiles
            .filter((f) => !f.is_dir && !indexedNodeIds.has(f.id))
            .filter((f) => {
              const fmt = unitFormat(f, this.context.kind)
              if (!fmt) return false
              if (this.state.format && fmt !== this.state.format) return false
              return true
            })
            .map((f) => ({
              id: `file:${f.id}`,
              work: undefined,
              units: [
                {
                  nodeId: f.id,
                  file: f,
                  format: unitFormat(f, this.context.kind)!,
                  sourceIds: [targetSourceId],
                  firstIndexedAt: f.created_at || Date.now(),
                },
              ],
              metadata: { title: f.name.replace(/\.[^.]+$/, '') },
              reading: aggregateReading([]),
              flags: { schemaVersion: 1, wantToRead: false, favorite: false },
              firstIndexedAt: f.created_at || Date.now(),
              ungrouped: true,
            }))

          if (this.state.offset >= result.total) {
            displayItems = unindexedItems
            hasMore = sdkHasMore
          } else {
            displayItems = [...result.items, ...unindexedItems].slice(0, this.pageSize)
            hasMore = result.nextOffset !== null || sdkHasMore
          }
        }
      }

      this.hasMore = hasMore
      this.totalItems = result.total + (this.hasMore ? this.pageSize : 0)

      // 部分范围提示：如果书库索引未完成或存在限制
      if (scopeNotice) {
        scopeNotice.hidden = isComplete
      }

      if (!displayItems.length) {
        statusMsg.textContent = this.state.query
          ? '没有匹配的图书或漫画，可尝试更换搜索关键词'
          : '该分类下暂无内容'
      } else {
        statusMsg.textContent = ''
      }

      displayItems.forEach((item) => {
        const card = this.renderCard(item)
        itemsContainer.append(card)
      })

      // 更新分页
      const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize))
      if (pageInfo) {
        pageInfo.textContent = `第 ${currentPage} / ${this.hasMore ? currentPage + 1 : totalPages} 页`
      }
      if (prevBtn) prevBtn.disabled = this.state.offset === 0
      if (nextBtn) nextBtn.disabled = !this.hasMore
    } catch (error) {
      statusMsg.textContent = '加载失败，请刷新重试'
      this.context.reportError(error)
    }
  }

  private renderCard(item: CatalogItem): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'library-card'
    card.setAttribute('data-id', item.id)

    const firstUnit = item.units[0]!
    card.setAttribute('data-file-id', String(firstUnit.nodeId))

    const title = item.metadata.title || firstUnit.file.name.replace(/\.[^.]+$/, '')

    // 封面容器
    const coverWrapper = document.createElement('div')
    coverWrapper.className = 'card-cover'
    const coverArt = document.createElement('div')
    coverArt.className = 'cover-art'
    const initial = document.createElement('span')
    initial.className = 'cover-initial'
    initial.textContent = title.slice(0, 1)

    // 格式标记
    const mark = document.createElement('span')
    mark.className = 'file-mark'
    mark.textContent =
      firstUnit.format === 'images' ? '目录' : firstUnit.format.toUpperCase()

    // 状态徽标
    const statusBadge = document.createElement('span')
    statusBadge.className = `badge-status badge-${item.reading.status}`
    statusBadge.textContent =
      item.reading.status === 'read'
        ? '已读'
        : item.reading.status === 'reading'
          ? '在读'
          : '未读'

    coverArt.append(initial, mark, statusBadge)

    // 如果未归组或顺序待确认，显示未归组标签
    if (item.ungrouped || !item.work?.orderConfirmed) {
      const ungroupedBadge = document.createElement('span')
      ungroupedBadge.className = 'badge-ungrouped'
      ungroupedBadge.textContent = '未归组'
      coverArt.append(ungroupedBadge)
    }

    coverWrapper.append(coverArt)
    this.coverLoader?.observe(coverArt, firstUnit)

    // 信息容器
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

    // 点击进入详情
    card.addEventListener('click', () => {
      this.getState() // 保存滚动位置
      this.context.openDetail(item)
    })

    return card
  }

  destroy() {
    this.loadGeneration++
    this.lifecycle.abort()
    this.coverLoader?.destroy()
    this.coverLoader = undefined
    clearTimeout(this.searchTimer)
  }
}
