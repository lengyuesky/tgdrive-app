/** 详情视图：图书封面作者简介/按需独立loadNavigation目录/重读确认；漫画正篇番外/不可变CAS人工归组管理。 */
import type { UiContext } from './types'
import {
  defaults,
  type Location,
} from '../state'
import type { NavigationItem, ViewContext } from '../view'
import {
  editWorkMetadata,
  mergeWorks,
  reorderWork,
  splitWork,
  type CatalogItem,
  type ReadingUnit,
  type Work,
  type WorkMember,
  type BibliographicMetadata,
  type ValueSnapshot,
  type WorkFlags,
  type UnitState,
  type CoverResource,
  resolveWork,
  resolvedMetadata,
  workFlagIds,
  aggregateFlags,
} from '../library'
import {
  showConfirmModal,
  showEditMetadataModal,
  showReorderMembersModal,
  showMergeWorksModal,
  showSplitWorkModal,
} from './modals'

export class DetailView {
  private lifecycle = new AbortController()
  private coverResource?: CoverResource
  private currentItem?: CatalogItem
  private currentWork?: Work
  private currentUnit?: ReadingUnit
  private flagSnapshots = new Map<string, ValueSnapshot<WorkFlags>>()
  private unitState?: ValueSnapshot<UnitState>
  private navigationItems: NavigationItem[] = []
  private navigationLoaded = false
  private renderGeneration = 0
  private editDraft?: BibliographicMetadata
  private reorderDraft?: readonly WorkMember[]
  private onBack?: () => void

  constructor(
    private container: HTMLElement,
    private context: UiContext
  ) {}

  setBackHandler(handler: () => void) {
    this.onBack = handler
  }

  async render(itemOrUnit: CatalogItem | { unit: ReadingUnit; work?: Work }) {
    this.destroy()
    const activeGen = ++this.renderGeneration
    this.lifecycle = new AbortController()
    this.navigationLoaded = false
    this.navigationItems = []

    let unit: ReadingUnit
    let work: Work | undefined

    if ('metadata' in itemOrUnit && 'units' in itemOrUnit) {
      this.currentItem = itemOrUnit
      unit = itemOrUnit.units[0]!
      work = itemOrUnit.work
    } else {
      unit = itemOrUnit.unit
      work = itemOrUnit.work
    }

    // 沿别名解析至主作品
    const worksSnapshot = this.context.library.snapshot.works
    if (work) {
      work = resolveWork(worksSnapshot.rows, work.id) ?? work
    } else {
      const found = worksSnapshot.rows.find((w) =>
        w.members.some((m) => m.unitId === unit.nodeId)
      )
      if (found) work = resolveWork(worksSnapshot.rows, found.id) ?? found
    }

    this.currentUnit = unit
    this.currentWork = work

    this.container.innerHTML = `
      <div class="detail-container">
        <!-- 详情顶栏导航 -->
        <header class="detail-header">
          <button id="btn-detail-back" class="detail-back-btn" type="button">
            <span class="back-arrow" aria-hidden="true">←</span> 返回
          </button>
          <h2 class="detail-header-title">作品详情</h2>
        </header>

        <div class="detail-body">
          <!-- 封面与主要元数据 -->
          <section class="detail-hero">
            <div class="detail-cover-wrapper">
              <div id="detail-cover-art" class="detail-cover-art">
                <span class="cover-initial"></span>
              </div>
            </div>
            <div class="detail-meta">
              <h1 id="detail-title" class="detail-title"></h1>
              <p id="detail-author" class="detail-author" hidden></p>
              <div class="detail-tags">
                <span id="detail-format-badge" class="badge-format"></span>
                <span id="detail-status-badge" class="badge-status"></span>
              </div>
              <div class="detail-flags-actions">
                <button id="btn-flag-want" class="btn-flag" type="button">☆ 想读</button>
                <button id="btn-flag-fav" class="btn-flag" type="button">♡ 收藏</button>
                <button id="btn-mark-read" class="btn-sm" type="button">标记为已读</button>
                <button id="btn-reread" class="btn-sm" type="button">从头重读</button>
              </div>
            </div>
          </section>

          <!-- 简介（如有） -->
          <section id="detail-desc-section" class="detail-desc-section" hidden>
            <h3 class="section-heading">简介</h3>
            <p id="detail-desc-text" class="detail-desc-text"></p>
          </section>

          <!-- 图书特有区域：按需独立目录加载 -->
          <section id="detail-books-section" class="detail-section" hidden>
            <div class="section-heading-row">
              <h3 class="section-heading">目录</h3>
              <button id="btn-load-toc" class="btn-sm" type="button">加载目录</button>
            </div>
            <div id="detail-toc-container" class="detail-toc-container">
              <p class="toc-placeholder">点击“加载目录”按需解析章节（不写入阅读进度）</p>
            </div>
          </section>

          <!-- 漫画特有区域：正篇与番外分卷、人工归组管理 -->
          <section id="detail-comics-section" class="detail-section" hidden>
            <!-- 顺序或审核提示 -->
            <div id="comic-review-notice" class="comic-review-notice" hidden></div>

            <!-- 人工归组管理工具 -->
            <div class="comic-manage-tools">
              <span class="manage-title">人工整理：</span>
              <button id="btn-comic-edit" class="btn-sm" type="button">修改信息</button>
              <button id="btn-comic-reorder" class="btn-sm" type="button">调整顺序</button>
              <button id="btn-comic-merge" class="btn-sm" type="button">合并作品</button>
              <button id="btn-comic-split" class="btn-sm" type="button">拆分作品</button>
            </div>

            <!-- 正篇列表 -->
            <div class="comic-chapters-group">
              <h3 class="chapters-group-title">正篇</h3>
              <div id="comic-main-chapters" class="chapters-list"></div>
            </div>

            <!-- 番外列表 -->
            <div id="comic-extra-group" class="comic-chapters-group" hidden>
              <h3 class="chapters-group-title">番外篇</h3>
              <div id="comic-extra-chapters" class="chapters-list"></div>
            </div>
          </section>

          <!-- 文件基本属性信息 -->
          <section class="detail-section file-info-section">
            <h3 class="section-heading">文件信息</h3>
            <div id="detail-file-info" class="file-info-grid"></div>
          </section>
        </div>

        <!-- 底部固定主操作栏 -->
        <footer class="detail-footer">
          <button id="btn-primary-read" class="btn-primary btn-large" type="button">
            开始阅读
          </button>
        </footer>
      </div>
    `

    this.bindStaticEvents()
    await this.loadDetailData(unit, work)
  }

  private bindStaticEvents() {
    const backBtn = this.container.querySelector<HTMLButtonElement>('#btn-detail-back')
    if (backBtn) {
      backBtn.onclick = () => {
        if (this.onBack) this.onBack()
        else this.context.switchView('library')
      }
    }

    const primaryReadBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-primary-read'
    )
    if (primaryReadBtn) {
      primaryReadBtn.onclick = () => {
        if (this.currentUnit) {
          void this.context
            .openReader(this.currentUnit.nodeId)
            .catch(this.context.reportError)
        }
      }
    }
  }

  private async loadDetailData(unit: ReadingUnit, work?: Work) {
    const isBooks = this.context.kind === 'books'
    const signal = this.lifecycle.signal

    // 1. 获取元数据并解析人工优先信息
    let currentUnit = unit
    try {
      const checked = await this.context.library.openUnit(unit.nodeId, signal)
      currentUnit = { ...unit, file: checked.file, format: checked.format, sourceIds: checked.sourceIds }
    } catch (err) {
      this.context.reportError(err)
      return
    }
    unit = currentUnit
    this.currentUnit = currentUnit

    let meta: BibliographicMetadata = {
      title: unit.file.name.replace(/\.[^.]+$/, ''),
    }
    try {
      const metaResult = await this.context.library.getMetadata(unit, signal)
      const currentWorks = this.context.library.snapshot.works.rows
      const found = currentWorks.find((w) => w.members.some((m) => m.unitId === unit.nodeId))
      if (found) {
        work = resolveWork(currentWorks, found.id) ?? found
        this.currentWork = work
      } else if (work) {
        work = resolveWork(currentWorks, work.id) ?? work
        this.currentWork = work
      }
      meta = resolvedMetadata(unit, work, metaResult.metadata)
    } catch {
      const currentWorks = this.context.library.snapshot.works.rows
      const found = currentWorks.find((w) => w.members.some((m) => m.unitId === unit.nodeId))
      if (found) {
        work = resolveWork(currentWorks, found.id) ?? found
        this.currentWork = work
      } else if (work) {
        work = resolveWork(currentWorks, work.id) ?? work
        this.currentWork = work
      }
      meta = resolvedMetadata(unit, work)
    }

    // 2. 加载封面
    const coverArt = this.container.querySelector<HTMLElement>('#detail-cover-art')
    const initialEl = this.container.querySelector<HTMLElement>(
      '#detail-cover-art .cover-initial'
    )
    if (initialEl) initialEl.textContent = (meta.title || unit.file.name).slice(0, 1)

    try {
      this.coverResource = await this.context.library.covers.get(unit, signal)
      if (coverArt && this.coverResource.url) {
        coverArt.style.backgroundImage = `url("${this.coverResource.url}")`
        coverArt.classList.add('has-cover')
      }
    } catch {
      /* 封面失败保留文字占位 */
    }

    // 3. 填充标题、作者、格式
    const titleEl = this.container.querySelector<HTMLElement>('#detail-title')
    const authorEl = this.container.querySelector<HTMLElement>('#detail-author')
    const formatBadge = this.container.querySelector<HTMLElement>(
      '#detail-format-badge'
    )
    const descSection = this.container.querySelector<HTMLElement>(
      '#detail-desc-section'
    )
    const descText = this.container.querySelector<HTMLElement>('#detail-desc-text')

    if (titleEl) titleEl.textContent = meta.title || unit.file.name
    if (authorEl) {
      if (meta.authors?.length) {
        authorEl.textContent = `作者：${meta.authors.join(', ')}`
        authorEl.hidden = false
      } else {
        authorEl.hidden = true
      }
    }
    if (formatBadge) {
      formatBadge.textContent =
        unit.format === 'images' ? '图片目录' : unit.format.toUpperCase()
    }

    // 简介展示（不伪造）
    if (descSection && descText) {
      if (meta.description) {
        descText.textContent = meta.description
        descSection.hidden = false
      } else {
        descSection.hidden = true
      }
    }

    // 4. 读取该单元当前用户的阅读状态与想读/收藏
    const readingSnap = await this.context.library.reading.load(unit.file, signal)
    this.unitState = readingSnap.state

    // 读取并聚合标志
    if (work) {
      const currentWorks = this.context.library.snapshot.works.rows
      const flagIds = workFlagIds(work, currentWorks)
      for (const id of flagIds) {
        const snap = await this.context.library.reading.flags(id, signal)
        this.flagSnapshots.set(id, snap)
      }
    }

    this.updateStatusBadgesAndButtons(readingSnap.reading.status, work)

    // 5. 绑定 想读/收藏/已读/从头重读 按钮
    this.bindActionButtons(unit, work)

    // 6. 分别渲染 图书（按需目录） 或 漫画（卷章与人工归组）
    if (isBooks) {
      this.renderBooksSection(unit)
    } else {
      this.renderComicsSection(work, unit)
    }

    // 7. 文件属性
    this.renderFileInfo(unit)
  }

  private updateStatusBadgesAndButtons(status: string, work?: Work) {
    const statusBadge = this.container.querySelector<HTMLElement>(
      '#detail-status-badge'
    )
    const primaryReadBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-primary-read'
    )
    if (statusBadge) {
      statusBadge.className = `badge-status badge-${status}`
      statusBadge.textContent =
        status === 'read' ? '已读' : status === 'reading' ? '在读' : '未读'
    }
    if (primaryReadBtn) {
      primaryReadBtn.textContent = status === 'unread' ? '开始阅读' : '继续阅读'
    }

    // 更新 想读/收藏 按钮高亮
    const wantBtn = this.container.querySelector<HTMLButtonElement>('#btn-flag-want')
    const favBtn = this.container.querySelector<HTMLButtonElement>('#btn-flag-fav')

    if (work) {
      const currentWorks = this.context.library.snapshot.works.rows
      const flagsMap = new Map([...this.flagSnapshots].map(([id, snap]) => [id, snap.value]))
      const aggregated = aggregateFlags(work, currentWorks, flagsMap)
      if (wantBtn) {
        wantBtn.textContent = aggregated.wantToRead ? '★ 已想读' : '☆ 想读'
        wantBtn.classList.toggle('active', aggregated.wantToRead)
      }
      if (favBtn) {
        favBtn.textContent = aggregated.favorite ? '♥ 已收藏' : '♡ 收藏'
        favBtn.classList.toggle('active', aggregated.favorite)
      }
    }
  }

  private bindActionButtons(unit: ReadingUnit, work?: Work) {
    const wantBtn = this.container.querySelector<HTMLButtonElement>('#btn-flag-want')
    const favBtn = this.container.querySelector<HTMLButtonElement>('#btn-flag-fav')
    const markReadBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-mark-read'
    )
    const rereadBtn = this.container.querySelector<HTMLButtonElement>('#btn-reread')

    // 想读切换
    if (wantBtn && work) {
      wantBtn.onclick = async () => {
        try {
          const currentWorks = this.context.library.snapshot.works.rows
          const flagsMap = new Map([...this.flagSnapshots].map(([id, snap]) => [id, snap.value]))
          const aggregated = aggregateFlags(work, currentWorks, flagsMap)
          const updated = await this.context.library.reading.setWorkFlags(
            work,
            currentWorks,
            this.flagSnapshots,
            { wantToRead: !aggregated.wantToRead },
            this.lifecycle.signal
          )
          for (const [id, snap] of updated) {
            this.flagSnapshots.set(id, snap)
          }
          this.updateStatusBadgesAndButtons(
            this.unitState?.value.status ?? 'unread',
            work
          )
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 收藏切换
    if (favBtn && work) {
      favBtn.onclick = async () => {
        try {
          const currentWorks = this.context.library.snapshot.works.rows
          const flagsMap = new Map([...this.flagSnapshots].map(([id, snap]) => [id, snap.value]))
          const aggregated = aggregateFlags(work, currentWorks, flagsMap)
          const updated = await this.context.library.reading.setWorkFlags(
            work,
            currentWorks,
            this.flagSnapshots,
            { favorite: !aggregated.favorite },
            this.lifecycle.signal
          )
          for (const [id, snap] of updated) {
            this.flagSnapshots.set(id, snap)
          }
          this.updateStatusBadgesAndButtons(
            this.unitState?.value.status ?? 'unread',
            work
          )
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 显式已读
    if (markReadBtn && this.unitState) {
      markReadBtn.onclick = async () => {
        try {
          const verified = await this.context.library.openUnit(unit.nodeId, this.lifecycle.signal)
          const saved = await this.context.library.reading.markRead(
            verified.file,
            this.unitState!,
            this.lifecycle.signal
          )
          this.unitState = saved
          this.updateStatusBadgesAndButtons('read', work)
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 从头重读（弹窗确认契约）
    if (rereadBtn && this.unitState) {
      rereadBtn.onclick = async () => {
        const confirmed = await showConfirmModal({
          title: '从头重读',
          message: '确定从第一页开始重读吗？原阅读进度和所有书签均会保留。',
          confirmText: '从头阅读',
        })
        if (!confirmed) return

        try {
          const verified = await this.context.library.openUnit(unit.nodeId, this.lifecycle.signal)
          const locFormat: Location['format'] = ['cbz', 'zip', 'images'].includes(verified.format)
            ? 'comic'
            : (verified.format as 'txt' | 'epub' | 'pdf')
          const result = await this.context.library.reading.restart(
            verified.file,
            this.unitState!,
            locFormat,
            true,
            this.lifecycle.signal
          )
          this.unitState = result.state
          this.updateStatusBadgesAndButtons('reading', work)
          // 重新打开阅读器
          void this.context
            .openReader(unit.nodeId, result.location)
            .catch(this.context.reportError)
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }
  }

  /** 图书详情：按需独立实例 loadNavigation 加载目录，不挂载正文，不读写进度 */
  private renderBooksSection(unit: ReadingUnit) {
    const section = this.container.querySelector<HTMLElement>('#detail-books-section')
    const loadBtn = this.container.querySelector<HTMLButtonElement>('#btn-load-toc')
    const tocContainer = this.container.querySelector<HTMLElement>(
      '#detail-toc-container'
    )
    if (!section || !loadBtn || !tocContainer) return

    section.hidden = false

    loadBtn.onclick = async () => {
      if (this.navigationLoaded) {
        tocContainer.hidden = !tocContainer.hidden
        loadBtn.textContent = tocContainer.hidden ? '展开目录' : '折叠目录'
        return
      }

      loadBtn.disabled = true
      loadBtn.textContent = '正在解析目录…'
      tocContainer.innerHTML = '<p class="toc-loading">正在解析文件结构，请稍候…</p>'

      try {
        const items = await this.loadDetailNavigation(unit)
        this.navigationItems = items
        this.navigationLoaded = true
        loadBtn.disabled = false
        loadBtn.textContent = '折叠目录'
        this.renderTocList(items, tocContainer, unit)
      } catch (err) {
        loadBtn.disabled = false
        loadBtn.textContent = '重新加载目录'
        const p = document.createElement('p')
        p.className = 'toc-error'
        p.textContent = `目录解析失败：${err instanceof Error ? err.message : String(err)}`
        tocContainer.replaceChildren(p)
      }
    }
  }

  /** 详情独立 loadNavigation 契约：独立 ViewContext、空 viewport，finally destroy */
  private async loadDetailNavigation(unit: ReadingUnit): Promise<NavigationItem[]> {
    const verified = await this.context.library.openUnit(unit.nodeId, this.lifecycle.signal)
    const dummyViewport = document.createElement('div')
    const readingContext: ViewContext = {
      drive: this.context.drive,
      file: verified.file,
      signal: this.lifecycle.signal,
      prefs: defaults,
      viewport: dummyViewport,
      navigate: async (w) => {
        await w()
      },
      changed: () => {},
      error: () => {},
    }

    const reader = await this.context.createReader(readingContext)
    try {
      this.lifecycle.signal.throwIfAborted()
      if (reader.loadNavigation) {
        return await reader.loadNavigation()
      }
      if (reader.navigation?.length) {
        return reader.navigation
      }
      const format = (reader.current?.().format ?? 'txt') as Location['format']
      return reader.sections.map((section, index) => ({
        label: section.label,
        location: { format, index, entry: section.entry },
        depth: 0,
      }))
    } finally {
      reader.destroy()
    }
  }

  private renderTocList(
    items: NavigationItem[],
    container: HTMLElement,
    unit: ReadingUnit
  ) {
    container.replaceChildren()
    if (!items.length) {
      container.innerHTML = '<p class="toc-empty">未发现层级目录，可直接阅读正文</p>'
      return
    }

    const list = document.createElement('div')
    list.className = 'toc-tree-list'

    items.forEach((item) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'toc-item-btn'
      const depth = item.depth ?? 0
      btn.style.paddingLeft = `${depth * 16 + 12}px`
      btn.textContent = item.label

      // 点击章节直接以该 Location 正式阅读
      btn.onclick = () => {
        void this.context
          .openReader(unit.nodeId, item.location)
          .catch(this.context.reportError)
      }

      list.append(btn)
    })

    container.append(list)
  }

  /** 漫画详情：正篇/番外分卷展示、人工归组管理（合并、拆分、重排、元数据修正） */
  private renderComicsSection(work: Work | undefined, unit: ReadingUnit) {
    const section = this.container.querySelector<HTMLElement>('#detail-comics-section')
    if (!section) return
    section.hidden = false

    const noticeEl = this.container.querySelector<HTMLElement>('#comic-review-notice')
    if (noticeEl) {
      if (work?.reviewReason || work && !work.orderConfirmed) {
        noticeEl.textContent = `⚠️ 提示：${work.reviewReason ?? '卷话顺序待确认，建议人工检查调整'}`
        noticeEl.hidden = false
      } else {
        noticeEl.hidden = true
      }
    }

    const allUnits = this.context.library.snapshot.units
    const unitMap = new Map(allUnits.map((u) => [u.nodeId, u]))
    const unitNames = new Map(allUnits.map((u) => [u.nodeId, u.file.name]))

    const mainContainer = this.container.querySelector<HTMLElement>(
      '#comic-main-chapters'
    )
    const extraGroup = this.container.querySelector<HTMLElement>('#comic-extra-group')
    const extraContainer = this.container.querySelector<HTMLElement>(
      '#comic-extra-chapters'
    )

    if (mainContainer) mainContainer.replaceChildren()
    if (extraContainer) extraContainer.replaceChildren()

    const members: WorkMember[] = work?.members.length
      ? work.members
      : [{ unitId: unit.nodeId, role: 'main', firstIndexedAt: unit.firstIndexedAt }]

    let hasExtra = false

    members.forEach((member) => {
      const u = unitMap.get(member.unitId) ?? (member.unitId === unit.nodeId ? unit : undefined)
      const name = u ? u.file.name.replace(/\.[^.]+$/, '') : `卷话 ${member.unitId}`

      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'chapter-item-btn'

      const titleSpan = document.createElement('span')
      titleSpan.className = 'chapter-title'
      titleSpan.textContent = name

      const arrowSpan = document.createElement('span')
      arrowSpan.className = 'chapter-arrow'
      arrowSpan.textContent = '阅读 →'

      row.append(titleSpan, arrowSpan)
      row.onclick = () => {
        void this.context.openReader(member.unitId).catch(this.context.reportError)
      }

      if (member.role === 'extra') {
        hasExtra = true
        extraContainer?.append(row)
      } else {
        mainContainer?.append(row)
      }
    })

    if (extraGroup) extraGroup.hidden = !hasExtra

    // 绑定人工归组管理按钮
    this.bindComicManagementButtons(work ?? {
      id: '00000000000000000000000000000000',
      kind: 'comics',
      members,
      grouping: 'single',
      orderConfirmed: true,
      firstIndexedAt: unit.firstIndexedAt,
      overrides: {},
    }, unitNames)
  }

  private bindComicManagementButtons(
    work: Work,
    unitNames: ReadonlyMap<number, string>
  ) {
    const editBtn = this.container.querySelector<HTMLButtonElement>('#btn-comic-edit')
    const reorderBtn = this.container.querySelector<HTMLButtonElement>(
      '#btn-comic-reorder'
    )
    const mergeBtn = this.container.querySelector<HTMLButtonElement>('#btn-comic-merge')
    const splitBtn = this.container.querySelector<HTMLButtonElement>('#btn-comic-split')

    // 1. 修改元数据
    if (editBtn) {
      editBtn.onclick = async () => {
        const baseSnapshot = this.context.library.snapshot.works
        const initialData = this.editDraft ?? work.overrides
        const result = await showEditMetadataModal(initialData, this.lifecycle.signal)
        if (!result) return
        this.editDraft = result

        try {
          const updated = editWorkMetadata(baseSnapshot.rows, work.id, result)
          await this.context.library.publishWorks({
            ...baseSnapshot,
            rows: updated,
          })
          this.editDraft = undefined
          if (this.currentUnit) {
            await this.render({ unit: this.currentUnit, work })
          }
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 2. 调整顺序
    if (reorderBtn) {
      reorderBtn.onclick = async () => {
        const baseSnapshot = this.context.library.snapshot.works
        const initialMembers = this.reorderDraft ?? work.members
        const result = await showReorderMembersModal(
          initialMembers,
          unitNames,
          this.lifecycle.signal
        )
        if (!result) return
        this.reorderDraft = result

        try {
          const updated = reorderWork(baseSnapshot.rows, work.id, result)
          await this.context.library.publishWorks({
            ...baseSnapshot,
            rows: updated,
          })
          this.reorderDraft = undefined
          if (this.currentUnit) {
            await this.render({ unit: this.currentUnit, work })
          }
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 3. 合并作品
    if (mergeBtn) {
      mergeBtn.onclick = async () => {
        const baseSnapshot = this.context.library.snapshot.works
        const workTitles = new Map<string, string>()
        baseSnapshot.rows.forEach((w) => {
          workTitles.set(w.id, w.overrides.title ?? `作品 (${w.members.length}卷)`)
        })

        const result = await showMergeWorksModal(
          work,
          baseSnapshot.rows,
          workTitles,
          this.lifecycle.signal
        )
        if (!result) return

        try {
          const updated = mergeWorks(baseSnapshot.rows, result)
          await this.context.library.publishWorks({
            ...baseSnapshot,
            rows: updated,
          })
          if (this.currentUnit) {
            await this.render({ unit: this.currentUnit, work })
          }
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }

    // 4. 拆分作品（严格遵守法定契约）
    if (splitBtn) {
      splitBtn.onclick = async () => {
        const baseSnapshot = this.context.library.snapshot.works
        const result = await showSplitWorkModal(
          work,
          unitNames,
          this.lifecycle.signal
        )
        if (!result) return

        try {
          const unitIdGroups = result.map((group) => group.map((m) => m.unitId))
          const updated = splitWork(baseSnapshot.rows, work.id, unitIdGroups)
          await this.context.library.publishWorks({
            ...baseSnapshot,
            rows: updated,
          })
          if (this.currentUnit) {
            await this.render({ unit: this.currentUnit, work })
          }
        } catch (err) {
          this.context.reportError(err)
        }
      }
    }
  }

  private renderFileInfo(unit: ReadingUnit) {
    const container = this.container.querySelector<HTMLElement>('#detail-file-info')
    if (!container) return
    container.replaceChildren()

    const addField = (label: string, value: string) => {
      const labelEl = document.createElement('span')
      labelEl.className = 'info-label'
      labelEl.textContent = label

      const valEl = document.createElement('span')
      valEl.className = 'info-value'
      valEl.textContent = value

      container.append(labelEl, valEl)
    }

    addField('文件路径', unit.file.path)
    addField('文件大小', `${(unit.file.size / 1024).toFixed(1)} KB`)
    addField('格式类型', unit.format)
    addField('版本标识', unit.file.content_version)
  }

  destroy() {
    this.lifecycle.abort()
    this.coverResource?.release()
    this.coverResource = undefined
  }
}
