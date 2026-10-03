/** 书库视图：两列封面、搜索筛选排序、作品/文件切换、部分范围提示、SDK文件分页兜底与滚动恢复。 */
import { fillGroupSelect, showBookGroups } from './book-groups'
import { HostLibraryView } from './host-library'
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
  private hostView?: HostLibraryView
  private hostMode = false
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
  private selecting = false
  private selected = new Set<number>()
  private displayed: CatalogItem[] = []
  private savingGroups = false
  private targetGroup = ''

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
    if (this.hostMode && this.context.drive.can?.('library.page') && this.context.drive.library) {
      this.hostView = new HostLibraryView(this.container, this.context, () => { this.hostMode = false; void this.render() })
      await this.hostView.render()
      return
    }
    this.coverLoader =
      typeof IntersectionObserver !== 'undefined'
        ? new ViewportCoverLoader(
            this.context.library.covers,
            this.lifecycle.signal
          )
        : undefined

    const isBooks = this.context.kind === 'books'
    const snapshot = this.context.library.snapshot
    if (this.state.sourceId !== undefined && !snapshot.sources.config.sources.some(source => source.nodeId === this.state.sourceId)) this.state.sourceId = snapshot.indexedSourceId

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
              ${this.context.drive.can?.('library.page') && this.context.drive.library ? '<button id="btn-view-host" class="toggle-btn" type="button">全库</button>' : ''}
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
        <button id="btn-library-retry" class="btn-primary" type="button" hidden>重试加载本页</button>
        <div id="items" class="library-grid" role="list"></div>

        <!-- 分页栏 -->
        <div class="library-pagination">
          <button id="btn-prev-page" class="btn-page" disabled>上一页</button>
          <span id="page-info" class="page-indicator">第 1 页</span>
          <button id="btn-next-page" class="btn-page" disabled>下一页</button>
        </div>
      </div>
    `

    if (isBooks) {
      const signal = this.lifecycle.signal
      try { await this.context.library.bookGroups.load(signal) }
      catch (error) { if (!signal.aborted) this.context.reportError(error) }
      if (signal.aborted) return
      this.renderGroupControls()
    }
    this.bindEvents()
    const hostButton = this.container.querySelector<HTMLButtonElement>('#btn-view-host')
    if (hostButton) hostButton.onclick = () => { this.hostMode = true; void this.render() }
    this.container.querySelector<HTMLButtonElement>('#btn-library-retry')!.onclick = () => { void this.loadItems() }
    await this.loadItems()

    if (restoreScroll && this.state.scrollTop > 0) {
      const scrollEl = this.container.closest('.ui-content') || this.container
      scrollEl.scrollTop = this.state.scrollTop
    }
  }

  private renderGroupControls() {
    this.container.querySelector('#book-group-controls')?.remove()
    const store = this.context.library.bookGroups
    if (this.state.groupId && !store.groups.some(group => group.id === this.state.groupId)) this.state.groupId = undefined
    const controls = document.createElement('div')
    controls.id = 'book-group-controls'; controls.className = 'book-group-controls'
    const filter = document.createElement('select')
    filter.id = 'filter-book-group'; filter.setAttribute('aria-label', '筛选分组')
    fillGroupSelect(filter, store, true, this.state.groupId ?? '*')
    filter.disabled = !store.ready
    filter.onchange = () => {
      this.state.groupId = filter.value === '*' ? undefined : filter.value
      this.state.offset = 0; this.sdkPageCursors.clear(); void this.loadItems()
    }
    const manage = document.createElement('button')
    manage.textContent = '管理分组'; manage.type = 'button'
    manage.onclick = () => {
      void showBookGroups(store, this.lifecycle.signal).then(() => {
        if (this.lifecycle.signal.aborted) return
        this.renderGroupControls(); this.state.offset = 0; this.sdkPageCursors.clear(); void this.loadItems()
      })
    }
    const toggle = document.createElement('button')
    toggle.textContent = this.selecting ? '退出多选' : '批量分组'; toggle.type = 'button'
    toggle.disabled = !store.ready
    toggle.onclick = () => {
      this.selecting = !this.selecting; this.selected.clear()
      this.renderGroupControls(); void this.loadItems()
    }
    controls.append(filter, manage, toggle)
    if (!store.ready) {
      const notice = document.createElement('span'); notice.textContent = '分组读取失败，可在管理分组中重新加载'
      controls.append(notice)
    }
    if (this.selecting) {
      const all = document.createElement('button')
      all.type = 'button'; all.textContent = '全选当前页'
      all.onclick = () => {
        this.selected = new Set(this.displayed.flatMap(item => item.units.map(unit => unit.nodeId)))
        this.updateSelection()
      }
      const target = document.createElement('select')
      if (this.targetGroup && !store.groups.some(group => group.id === this.targetGroup)) this.targetGroup = ''
      target.setAttribute('aria-label', '移动到分组'); fillGroupSelect(target, store, false, this.targetGroup)
      target.onchange = () => { this.targetGroup = target.value }
      const move = document.createElement('button')
      move.id = 'btn-move-group'; move.type = 'button'; move.textContent = '移动'; move.disabled = !this.selected.size
      move.onclick = () => {
        if (!this.selected.size || this.savingGroups) return
        this.savingGroups = true
        const frozen = [...this.container.querySelectorAll<HTMLElement>('.library-toolbar,.library-pagination')]
        frozen.forEach(el => { el.inert = true })
        controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(el => { el.disabled = true })
        void store.assign([...this.selected], target.value || undefined, this.lifecycle.signal).then(() => {
          this.state.offset = 0; this.sdkPageCursors.clear(); return this.loadItems(true)
        }).catch(error => {
          if (!this.lifecycle.signal.aborted) this.context.reportError(error)
        }).finally(() => {
          this.savingGroups = false
          frozen.forEach(el => { el.inert = false })
          if (!this.lifecycle.signal.aborted) { this.renderGroupControls(); this.updateSelection() }
        })
      }
      const count = document.createElement('span'); count.id = 'group-selection-count'; count.setAttribute('role', 'status')
      const reload = document.createElement('button')
      reload.type = 'button'; reload.textContent = '重新加载分组'
      reload.onclick = () => {
        reload.disabled = true
        void store.load(this.lifecycle.signal).then(() => {
          if (!this.lifecycle.signal.aborted) this.renderGroupControls()
        }).catch(error => { if (!this.lifecycle.signal.aborted) this.context.reportError(error) })
          .finally(() => { reload.disabled = false })
      }
      controls.append(all, target, move, reload, count)
    }
    this.container.querySelector('.library-toolbar')?.append(controls)
    this.updateSelection()
  }

  private updateSelection() {
    for (const card of this.container.querySelectorAll<HTMLButtonElement>('.library-card')) {
      const selected = this.selected.has(Number(card.dataset.fileId))
      card.classList.toggle('group-selected', selected)
      if (this.selecting) card.setAttribute('aria-pressed', String(selected))
      else card.removeAttribute('aria-pressed')
    }
    const count = this.container.querySelector('#group-selection-count')
    if (count) count.textContent = '已选 ' + this.selected.size + ' 本'
    const move = this.container.querySelector<HTMLButtonElement>('#btn-move-group')
    if (move) move.disabled = !this.selected.size || this.savingGroups
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
        this.context.library.invalidateReadingState()
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
        void this.context.library.selectSource(this.state.sourceId, this.lifecycle.signal)
          .then(() => this.loadItems()).catch(error => this.context.reportError(error))
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

  private async loadItems(afterSave = false) {
    if (this.savingGroups && !afterSave) return
    this.selected.clear(); this.displayed = []; this.updateSelection()
    const activeGen = ++this.loadGeneration
    this.coverLoader?.clear()
    const itemsContainer = this.container.querySelector<HTMLElement>('#items')
    const statusMsg = this.container.querySelector<HTMLElement>('#library-status')
    const scopeNotice = this.container.querySelector<HTMLElement>('#scope-notice')
    const prevBtn = this.container.querySelector<HTMLButtonElement>('#btn-prev-page')
    const nextBtn = this.container.querySelector<HTMLButtonElement>('#btn-next-page')
    const pageInfo = this.container.querySelector<HTMLElement>('#page-info')

    if (!itemsContainer || !statusMsg) return
    const retry = this.container.querySelector<HTMLButtonElement>('#btn-library-retry')!
    retry.hidden = true
    itemsContainer.replaceChildren()
    if (prevBtn) prevBtn.disabled = true
    if (nextBtn) nextBtn.disabled = true
    if (pageInfo) pageInfo.textContent = `第 ${Math.floor(this.state.offset / this.pageSize) + 1} 页`
    itemsContainer.setAttribute('aria-busy', 'true')
    statusMsg.textContent = '正在加载书库…'

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
          groupId: this.context.kind === 'books' ? this.state.groupId : undefined,
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
              if (this.context.kind === 'books' && !this.context.library.bookGroups.matches(f.id, this.state.groupId)) return false
              if (this.state.status && this.state.status !== 'unread') return false
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

      this.displayed = displayItems
      itemsContainer.replaceChildren()
      displayItems.forEach((item) => {
        const card = this.renderCard(item)
        itemsContainer.append(card)
      })

      this.updateSelection()

      // 更新分页
      const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize))
      if (pageInfo) {
        pageInfo.textContent = `第 ${currentPage} / ${this.hasMore ? currentPage + 1 : totalPages} 页`
      }
      if (prevBtn) prevBtn.disabled = this.state.offset === 0
      if (nextBtn) nextBtn.disabled = !this.hasMore
    } catch (error) {
      if (activeGen !== this.loadGeneration || this.lifecycle.signal.aborted) return
      statusMsg.textContent = '本页加载失败，筛选条件已保留。'
      retry.hidden = false
      if (prevBtn) prevBtn.disabled = this.state.offset === 0
      this.context.reportError(error)
    } finally {
      if (activeGen === this.loadGeneration && !this.lifecycle.signal.aborted) itemsContainer.setAttribute('aria-busy', 'false')
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
    if (this.context.kind === 'comics' && (item.ungrouped || !item.work?.orderConfirmed)) {
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
    if (this.context.kind === 'books') {
      const badge = document.createElement('span'); badge.className = 'book-group-badge'
      const store = this.context.library.bookGroups
      badge.textContent = store.ready ? (store.groups.find(group => group.id === store.groupFor(firstUnit.nodeId))?.name ?? '未分组') : '分组未加载'
      info.append(badge)
    }
    card.append(coverWrapper, info)

    // 点击直接进入阅读器：单卷作品一步开读，多卷作品仍进详情选择卷话。
    card.addEventListener('click', () => {
      if (this.savingGroups) return
      if (this.selecting) {
        const selected = this.selected.has(firstUnit.nodeId)
        for (const unit of item.units) { if (selected) this.selected.delete(unit.nodeId); else this.selected.add(unit.nodeId) }
        this.updateSelection(); return
      }
      this.getState() // 保存滚动位置
      if (item.units.length === 1) {
        void this.context.openReader(firstUnit.nodeId).catch(this.context.reportError)
      } else {
        this.context.openDetail(item)
      }
    })

    return card
  }

  destroy() {
    this.hostView?.destroy(); this.hostView = undefined
    this.loadGeneration++
    this.lifecycle.abort()
    this.coverLoader?.destroy()
    this.coverLoader = undefined
    clearTimeout(this.searchTimer)
  }
}
