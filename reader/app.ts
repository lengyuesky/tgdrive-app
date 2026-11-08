import { BodySearch } from './search'
/** 阅读馆和兼容入口共用的应用外壳与阅读器桥接，只依赖公开 SDK 与统一数据层。 */
import { filesChangeAffectsSources } from './library/sources'
import type { Drive, FileEntry } from '../sdk/types'
import { isAbort } from './io'
import {
  PreferenceStore,
  PreferenceSaveError,
  ProgressStore,
  defaultPreferences,
  readerDefaultPreferences,
  resolvePreferences,
  preferenceFormat,
  validLocation,
  type Location,
  type Preferences,
  type PreferencesSnapshot,
  type WorkPreferencesSnapshot,
  type PreferenceFormat,
  type TextPreferences,
  type ComicPreferences,
  type PdfPreferences,
} from './state'
import type { NavigationItem, ReaderThumbnail, ReaderView, ViewContext } from './view'
import { ReaderChrome } from './chrome'
import { ReaderNavigation } from './navigation'
import {
  ReadingLibrary,
  bindLibraryLifecycle,
  resolveWork,
  nextWorkUnit,
  type CatalogItem,
  type ReadingUnit,
  type Work,
  type PdfOpener,
  type ValueSnapshot,
  type UnitState,
  type LibraryScope,
} from './library'
import type { UiView, UiContext, LibrarySelection } from './ui/types'
import { NavManager } from './ui/nav'
import { HomeView } from './ui/home'
import { LibraryView } from './ui/library-view'
import { DetailView } from './ui/detail-view'
import { MeView } from './ui/me-view'
import { showConfirmModal } from './ui/modals'
import { showShelfModal } from './ui/shelves'
import { icon } from '../ui/icons'
import '../ui/base.css'
import './style.css'
import './reading.css'
import './mobile.css'

export interface CoverLoader {
  observe(container: HTMLElement, file: FileEntry): void
  clear(): void
  destroy(): void
}

export interface AppOptions {
  id?: 'reader' | 'books' | 'comics'
  kind: LibraryScope
  create: (context: ViewContext) => Promise<ReaderView>
  createCoverLoader?: (drive: Drive, signal: AbortSignal) => CoverLoader
  openPdf?: PdfOpener
}

interface Bookmark {
  title: string
  location: Location
  content_version: string
}

export async function startApp(options: AppOptions) {
  const drive: Drive = window.tgdrive
  const root = document.getElementById('app')!

  root.innerHTML = `
    <p id="notice" role="alert" hidden></p>
    <div id="modal-container"></div>
    <section id="startup-error" class="empty-state" hidden>
      <p id="startup-message" role="status"></p>
      <button id="startup-retry" type="button">重新加载阅读馆</button>
      <button id="startup-exit" type="button">返回网盘</button>
    </section>

    <!-- 阅读馆非正文界面容器 (首页 / 书库 / 详情 / 我的) -->
    <div id="app-ui" class="app-ui-layout">
      <div id="nav-container"></div>
      <main id="ui-content" class="ui-content">
        <section id="view-home" class="ui-view"></section>
        <section id="view-library" class="ui-view" hidden></section>
        <section id="view-detail" class="ui-view" hidden></section>
        <section id="view-me" class="ui-view" hidden></section>
      </main>
    </div>

    <!-- 正文阅读器界面容器 (阅读时激活展示，关闭时返回原界面) -->
    <section id="reader" class="reader" hidden>
      <button id="reader-menu-toggle" class="focus-menu">显示阅读菜单</button>
      <button id="reader-backdrop" class="reader-backdrop" aria-label="关闭阅读面板" tabindex="-1" hidden></button>
      <!-- 工具栏隐藏时常驻的极简信息：章节名与进度，可在排版面板关闭 -->
      <div id="reading-meta" class="reading-meta" aria-hidden="true"><span id="meta-chapter"></span><span id="meta-progress"></span></div>
      <div class="reader-toolbar">
        <button id="back" class="tool-btn" type="button" aria-label="返回内容库" title="返回内容库">${icon('back')}<span class="tool-label">返回内容库</span></button>
        <h2 id="book-title"></h2>
        <div id="reader-desktop-actions">
          <div id="reader-actions">
            <button id="toc-toggle" class="tool-btn" type="button" aria-label="目录" title="目录">${icon('toc')}<span class="tool-label">目录</span></button>
            <button id="appearance-toggle" class="tool-btn" type="button" aria-label="主题" title="主题">${icon('theme')}<span class="tool-label">主题</span></button>
            <button id="preferences-toggle" class="tool-btn" type="button" aria-label="排版设置" title="排版设置">${icon('type')}<span class="tool-label">排版</span></button>
            <button id="paging-toggle" class="tool-btn" type="button" aria-label="翻页方式" title="翻页方式">${icon('page')}<span class="tool-label">翻页</span></button>
          </div>
        </div>
        <button id="bookmark-quick" class="tool-btn" type="button" aria-pressed="false" aria-label="添加书签" title="添加书签">${icon('bookmark')}<span class="tool-label">书签</span></button>
        <button id="reader-more-toggle" class="tool-btn" type="button" aria-label="更多" title="更多">${icon('more')}<span class="tool-label">更多</span></button>
        <div id="reader-more" class="reader-more" aria-label="更多操作" hidden>
          <div class="panel-heading mobile-only"><strong>更多操作</strong><button data-close-panel>关闭</button></div>
          <button id="bookmarks-toggle">书签列表</button>
          <button id="download">下载原文件</button>
          <button id="host-show-file">在文件中显示</button>
          <button id="host-file-details">文件信息</button>
          <button id="btn-reader-detail">作品详情</button>
          <button id="btn-reader-restart">从头重读</button>
          <button id="btn-reader-settings">目录设置</button>
          <button id="reader-close" class="mobile-only">返回网盘</button>
        </div>
      </div>

      <!-- 统一层级目录抽屉面板 -->
      <div id="navigation" class="reader-panel reader-navigation" aria-label="阅读目录" hidden>
        <div class="panel-heading">
          <strong>阅读目录</strong>
          <button data-close-panel type="button" aria-label="关闭目录">关闭</button>
        </div>
        <div class="toc-search-bar">
          <input id="toc-filter" type="search" placeholder="筛选目录标题…" aria-label="筛选目录标题" />
        </div>
        <details id="body-search" class="body-search" hidden><summary>搜索正文</summary><div class="body-search-controls"><input type="search" maxlength="100" aria-label="搜索正文" placeholder="输入正文关键词…" /><button type="button" data-search-run>搜索</button><button type="button" data-search-stop hidden>停止</button></div><p role="status"></p><div data-search-results></div></details>
        <div id="toc-tree" class="toc-tree" role="tree"></div>
        <div class="toc-quick-jump">
          <label class="toc-select-label">快速跳转<select id="toc" aria-label="快速跳转目录"></select></label>
          <label class="jump-label"><span id="jump-label">位置</span><input id="jump" type="number" min="1" aria-label="页码或章节" /></label>
          <button id="jump-button" type="button">跳转</button>
        </div>
      </div>

      <!-- 主题面板：四种阅读主题色块，实际值仍写入 #theme -->
      <div id="appearance" class="appearance-panel" aria-label="阅读主题" hidden>
        <div class="panel-heading mobile-only"><strong>主题</strong><button data-close-panel>关闭</button></div>
        <div class="theme-swatches" data-proxy="theme" role="group" aria-label="阅读主题">
          <button type="button" class="theme-swatch" data-value="system" aria-pressed="false"><span class="swatch swatch-system" aria-hidden="true">Aa</span><span>跟随主站</span></button>
          <button type="button" class="theme-swatch" data-value="light" aria-pressed="false"><span class="swatch swatch-light" aria-hidden="true">Aa</span><span>明亮</span></button>
          <button type="button" class="theme-swatch" data-value="sepia" aria-pressed="false"><span class="swatch swatch-sepia" aria-hidden="true">Aa</span><span>护眼</span></button>
          <button type="button" class="theme-swatch" data-value="dark" aria-pressed="false"><span class="swatch swatch-dark" aria-hidden="true">Aa</span><span>深色</span></button>
        </div>
        <p class="panel-hint">屏幕亮度请使用系统控制中心调节。</p>
      </div>

      <!-- 翻页面板：常用的阅读方式，实际值仍写入原有选择框 -->
      <div id="paging" class="paging-panel" aria-label="翻页方式" hidden>
        <div class="panel-heading mobile-only"><strong>翻页方式</strong><button data-close-panel>关闭</button></div>
        <div class="pref-row paging-text"><span>文字</span><div class="tg-segmented" data-proxy="mode"><button type="button" data-value="page" aria-pressed="false">左右翻页</button><button type="button" data-value="scroll" aria-pressed="false">上下滚动</button></div></div>
        <div class="pref-row paging-comic"><span>漫画</span><div class="tg-segmented" data-proxy="comic-mode"><button type="button" data-value="single" aria-pressed="false">单页</button><button type="button" data-value="scroll" aria-pressed="false">连续滚动</button><button type="button" data-value="double" class="wide-only" aria-pressed="false">双页</button></div></div>
        <div class="pref-row paging-comic"><span>方向</span><div class="tg-segmented" data-proxy="direction"><button type="button" data-value="ltr" aria-pressed="false">从左到右</button><button type="button" data-value="rtl" aria-pressed="false">从右到左</button></div></div>
        <div class="pref-row paging-fit"><span>画面</span><div class="tg-segmented" data-proxy="fit"><button type="button" data-value="width" aria-pressed="false">适应宽度</button><button type="button" data-value="page" aria-pressed="false">适应整页</button></div></div>
        <p class="panel-hint paging-text">点屏幕左右两侧或左右滑动翻页，点中间唤出菜单。</p>
      </div>

      <!-- 排版面板：一级为常用项，二级保留全部细项 -->
      <div id="preferences" class="preferences reader-panel" aria-label="排版设置" hidden>
        <div class="panel-heading mobile-only"><strong>排版</strong><button data-close-panel>关闭</button></div>
        <div id="pref-quick" class="pref-quick">
          <div class="pref-row flow-quick"><span>字号</span><div class="font-stepper"><button type="button" data-font-step="-1" aria-label="减小字号">A−</button><output id="font-size-value" aria-live="polite"></output><button type="button" data-font-step="1" aria-label="增大字号">A+</button></div></div>
          <div class="pref-row flow-quick"><span>字体</span><div class="tg-segmented" data-proxy="font"><button type="button" data-value="serif" aria-pressed="false">宋体</button><button type="button" data-value="sans" aria-pressed="false">黑体</button><button type="button" data-value="system" aria-pressed="false">系统</button></div></div>
          <div class="pref-row flow-quick"><span>行距</span><div class="tg-segmented" data-line-preset><button type="button" data-value="1.5" aria-pressed="false">紧凑</button><button type="button" data-value="1.8" aria-pressed="false">标准</button><button type="button" data-value="2.2" aria-pressed="false">宽松</button></div></div>
          <div class="pref-row"><span>常驻章节与进度</span><button id="status-line-toggle" class="tg-switch" type="button" role="switch" aria-checked="true" aria-label="常驻显示章节与进度"></button></div>
        </div>
        <button id="pref-advanced-toggle" class="pref-advanced-toggle" type="button" aria-expanded="false" aria-controls="pref-advanced">更多设置</button>
        <div id="pref-advanced" class="pref-advanced">

        <!-- 偏好设置覆盖范围 -->
        <div id="pref-scope-control" class="pref-scope-control">
          <span class="pref-scope-title">配置范围：</span>
          <label class="pref-scope-label"><input type="radio" name="pref-scope" value="format" checked /> 全格式默认</label>
          <label id="pref-scope-work-label" class="pref-scope-label" hidden><input type="radio" name="pref-scope" value="work" /> 仅本作覆盖</label>
          <button id="pref-clear-work" type="button" class="btn-sm" hidden>清除本作覆盖</button>
        </div>

        <label>主题
          <select id="theme">
            <option value="system">跟随主站</option>
            <option value="light">明亮</option>
            <option value="sepia">护眼</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label id="font-option" class="flow-option" hidden>字体
          <select id="font">
            <option value="serif">宋体 (Serif)</option>
            <option value="sans">黑体 (Sans)</option>
            <option value="system">系统默认 (System)</option>
          </select>
        </label>
        <label class="flow-option">
          <span>字号</span>
          <span class="range-stepper">
            <button type="button" id="font-size-decrease" class="step-btn" aria-label="减小字号" title="减小字号">−</button>
            <input id="font-size" type="range" min="12" max="36" step="1" />
            <button type="button" id="font-size-increase" class="step-btn" aria-label="增大字号" title="增大字号">+</button>
          </span>
        </label>
        <label class="flow-option">
          <span>行距</span>
          <span class="range-stepper">
            <button type="button" id="line-height-decrease" class="step-btn" aria-label="减小行距">−</button>
            <input id="line-height" type="range" min="1.2" max="2.8" step="0.1" />
            <button type="button" id="line-height-increase" class="step-btn" aria-label="增大行距" title="增大行距">+</button>
          </span>
        </label>
        <label id="margin-option" class="flow-option" hidden>
          <span>页边距</span>
          <span class="range-stepper">
            <button type="button" id="margin-decrease" class="step-btn" aria-label="减小边距">−</button>
            <input id="margin" type="range" min="0" max="64" step="2" />
            <button type="button" id="margin-increase" class="step-btn" aria-label="增大边距">+</button>
          </span>
        </label>
        <label class="flow-option width-option">正文宽度<input id="width" type="range" min="360" max="1400" step="20" /></label>
        <label id="encoding-option" hidden>文本编码
          <select id="encoding">
            <option value="utf-8">UTF-8</option>
            <option value="utf-16le">UTF-16 LE</option>
            <option value="utf-16be">UTF-16 BE</option>
            <option value="gb18030">GB18030 / GBK</option>
          </select>
        </label>
        <label id="mode-option" hidden>阅读模式
          <select id="mode">
            <option value="scroll">上下滚动</option>
            <option value="page">单页翻页</option>
          </select>
        </label>
        <label id="comic-mode-option" hidden>漫画排版
          <select id="comic-mode">
            <option value="scroll">连续滚动</option>
            <option value="single">单页</option>
            <option value="double">双页并排</option>
          </select>
        </label>
        <label id="fit-option" hidden>画面适应
          <select id="fit">
            <option value="width">适合宽度</option>
            <option value="page">适合整页</option>
          </select>
        </label>
        <label id="direction-option" hidden>翻页方向
          <select id="direction">
            <option value="ltr">从左到右 (LTR)</option>
            <option value="rtl">从右到左 (RTL)</option>
          </select>
        </label>
        <label id="cover-alone-option" hidden>
          <input type="checkbox" id="cover-alone" /> 封面单独展示
        </label>
        <label id="spread-offset-option" hidden>双页偏移
          <select id="spread-offset">
            <option value="0">默认起点 (0)</option>
            <option value="1">右移一页 (1)</option>
          </select>
        </label>
        <label id="zoom-option" hidden>缩放
          <select id="zoom">
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100% (适配)</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
            <option value="3">300%</option>
          </select>
        </label>
        </div>
      </div>

      <!-- 书签面板 -->
      <div id="bookmarks" class="bookmarks-panel" aria-label="书签" hidden>
        <div class="panel-heading mobile-only"><strong>书签</strong><button data-close-panel>关闭</button></div>
        <div class="bookmark-tools">
          <input id="bookmark-name" maxlength="120" placeholder="书签名称（可选）" aria-label="书签名称" />
          <button id="add-bookmark">添加当前位置</button>
          <button id="bookmark-more" hidden>更多书签</button>
        </div>
        <div id="bookmark-items"></div>
      </div>

      <div id="conflict" class="conflict" role="alert" hidden>
        <span id="conflict-msg">另一设备更新了进度，已暂停自动覆盖。</span>
        <button id="use-cloud">使用已保存进度</button>
        <button id="use-current">从当前页继续并保存</button>
      </div>
      <div id="layout-notice" class="layout-notice" role="alert" hidden></div>
      <div id="reader-toast" class="tg-toast reader-toast" role="status" hidden></div>
      <div id="reading-status" role="status"></div>
      <main id="viewport" class="reading-viewport" tabindex="0" aria-label="阅读内容"></main>
      <footer class="reader-footer">
        <div class="reader-progress-row">
          <button id="chapter-prev" class="tool-btn" type="button" aria-label="上一章" title="上一章">${icon('prev')}</button>
          <div class="progress-slider"><input id="progress" type="range" min="1" max="1" step="1" value="1" aria-label="阅读进度" /><output id="progress-bubble" class="progress-bubble" hidden></output></div>
          <button id="chapter-next" class="tool-btn" type="button" aria-label="下一章" title="下一章">${icon('next')}</button>
        </div>
        <div class="reader-footer-line">
          <button id="previous">上一页 / 章</button>
          <span id="position"></span>
          <button id="next">下一页 / 章</button>
          <span id="sync" role="status"></span>
          <button id="retry-save">重试同步</button>
          <button id="retry-reader" hidden>重试打开</button>
        </div>
        <div id="reader-footer-actions"></div>
      </footer>
      <!-- 读到真实末端才出现的完成卡片，不随工具栏隐藏 -->
      <div id="reader-completion" class="reader-completion" hidden>
        <strong class="completion-title">已读到最后一页</strong>
        <div class="completion-actions">
          <button id="btn-mark-finished" class="btn-primary" type="button">✓ 读完</button>
          <button id="btn-next-volume" class="btn-primary" type="button" hidden>读完并下一卷 →</button>
        </div>
      </div>
    </section>
  `

  const get = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T
  const show = (id: string, visible: boolean) => {
    const el = get(id)
    if (el) el.hidden = !visible
  }
  const text = (id: string, val: string) => {
    const el = get(id)
    if (el) el.textContent = val
  }
  const bind = (id: string, action: () => unknown) => {
    const el = get(id)
    if (el) {
      el.addEventListener('click', () => {
        try {
          Promise.resolve(action()).catch(report)
        } catch (error) {
          report(error)
        }
      })
    }
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let bodySearch: BodySearch | undefined
  let navigationSize = 0
  let nextVolumeOpening = false
  let chrome: ReaderChrome | undefined
  let stopped = false
  const appLifecycle = new AbortController()

  function errorText(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return /[\u3400-\u9fff]/.test(message)
      ? message
      : `读取失败：${message}。文件可能损坏或包含不支持的结构，可重试或下载原文件。`
  }

  function report(error: unknown) {
    if (isAbort(error) || stopped) return
    chrome?.reveal()
    text('notice', errorText(error))
    show('notice', true)
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => show('notice', false), 7000)
  }

  const context = await drive.ready
  const manualShelves = options.id === 'reader'
  let taskAt = 0, scanCancelled = false
  get('host-show-file').hidden = !drive.can?.('ui.showFile')
  get('host-file-details').hidden = !drive.can?.('ui.fileDetails')
  get('host-show-file').onclick = () => { if (currentFile) void drive.ui.showFile?.(currentFile).catch(report) }
  get('host-file-details').onclick = () => { if (currentFile) void drive.ui.fileDetails?.(currentFile).catch(report) }
  let dark = context.dark

  root.dataset.kind = options.kind
  root.dataset.app = options.id ?? options.kind
  document.title = context.name

  // 创建集中数据层服务，隔离不需要的 PDF 依赖
  const library = new ReadingLibrary(
    drive,
    options.kind,
    {
      progress: (prog) => {
        libraryView?.onScanProgress(prog)
        if (prog.phase === 'scanning' && prog.nodes === 0) scanCancelled = false
        if (drive.can?.('ui.task') && (Date.now() - taskAt > 500 || prog.phase !== 'scanning')) {
          taskAt = Date.now()
          void drive.ui.task?.({ id: 'library-scan', title: '整理内容库', completed: prog.nodes, state: prog.phase === 'scanning' ? 'running' : prog.phase === 'complete' ? 'done' : prog.phase === 'paused' || scanCancelled ? 'cancelled' : 'failed' }).catch(() => {})
        }
      },
      changed: snapshot => { navManager?.refreshLibraries(snapshot) },
    },
    options.openPdf,
    manualShelves
  )
  const unbindLibrary = bindLibraryLifecycle(library)
  const offTaskCancel = drive.on('task.cancel', value => { if (value?.id === 'library-scan') { scanCancelled = true; library.cancelScan(); void drive.ui.task?.({ id: 'library-scan', title: '整理内容库', completed: library.snapshot.progress?.nodes ?? 0, state: 'cancelled' }).catch(() => {}) } })
  appLifecycle.signal.addEventListener('abort', offTaskCancel, { once: true })

  // 路由与视图管理
  let currentView: UiView | undefined = undefined
  let previousView: UiView = 'home'

  const homeSection = get('view-home')
  const librarySection = get('view-library')
  const detailSection = get('view-detail')
  const meSection = get('view-me')

  let navManager: NavManager | undefined
  let homeView: HomeView | undefined
  let libraryView: LibraryView | undefined
  let detailView: DetailView | undefined
  let meView: MeView | undefined

  const switchView = async (view: UiView, selection?: LibrarySelection) => {
    if (view === currentView && view !== 'detail' && !selection) return
    if (currentView === 'library') libraryView?.getState()
    if (currentView && currentView !== 'detail') {
      previousView = currentView
    }
    currentView = view

    homeSection.hidden = view !== 'home'
    librarySection.hidden = view !== 'library'
    detailSection.hidden = view !== 'detail'
    meSection.hidden = view !== 'me'

    navManager?.setActive(view)

    if (view === 'home' && manualShelves) {
      libraryView?.setState({ sourceId: undefined, kind: undefined, format: undefined, groupId: undefined, offset: 0, scrollTop: 0 })
      await library.selectSource(undefined, appLifecycle.signal, false)
    }
    if (view === 'home') {
      await homeView?.render()
    } else if (view === 'library') {
      if (selection) await libraryView?.selectLibrary(selection)
      else await libraryView?.render(true)
    } else if (view === 'me') {
      await meView?.render()
    }
    navManager?.refreshLibraries()
  }

  // —— 宿主事件：跨设备进度、来源与文件树变化时去抖刷新阅读馆 ——
  let hostEventTimer: ReturnType<typeof setTimeout> | undefined
  const reading = () => !get('reader').hidden
  const rerenderCurrentView = async () => {
    // 面板或对话框打开时不重绘，避免打断当前操作；数据已在后台刷新，下次切换视图生效。
    if (document.querySelector('[role="dialog"]')) return
    if (currentView === 'detail' && detailView) {
      const item = detailView['currentItem']
      const unit = detailView['currentUnit']
      if (item) await detailView.render(item)
      else if (unit) await detailView.render({ unit, work: detailView['currentWork'] })
    } else if (currentView === 'library') {
      await libraryView?.render(true)
    } else if (currentView === 'home') {
      await homeView?.render()
    } else if (currentView === 'me') {
      await meView?.render()
    }
  }
  let pendingPaths = new Set<string>(), pendingFull = false, pendingSources = false, pendingWorks = false, pendingGroups = false, pendingState = false
  const scheduleLibraryRefresh = (kind: 'state' | 'files' | 'sources' | 'works' | 'groups', paths?: string[]) => {
    if (kind === 'state') pendingState = true
    if (kind === 'groups') pendingGroups = true
    if (kind === 'sources') pendingSources = true
    if (kind === 'works') pendingWorks = true
    if (kind === 'files' || kind === 'sources' && !manualShelves) { if (!paths) pendingFull = true; else paths.forEach(path => pendingPaths.add(path)) }
    clearTimeout(hostEventTimer)
    hostEventTimer = setTimeout(() => {
      hostEventTimer = undefined
      if (reading()) return
      const full = pendingFull, sources = pendingSources, works = pendingWorks, groups = pendingGroups, state = pendingState, paths = [...pendingPaths]
      pendingPaths.clear(); pendingFull = false; pendingSources = false; pendingWorks = false; pendingGroups = false; pendingState = false
      void (async () => {
        // 分组按实际修订号区分自身回流，不能按时间窗口忽略其他设备的连续写入。
        if (groups && !sources && !works && !full && !paths.length && !state && await library.bookGroups.isCurrent(appLifecycle.signal)) return
        if (sources) await library.initialize()
        else if (works) await library.reloadWorks()
        if (full || paths.length) {
          if (!manualShelves || library.snapshot.indexedSourceId !== undefined) await library.refresh(undefined, full ? undefined : paths)
        } else await library.loadReadingState()
        if (groups) await library.bookGroups.load(appLifecycle.signal)
        await rerenderCurrentView()
        navManager?.refreshLibraries()
      })().catch(report)
    }, 600)
  }
  async function loadUiPrefs() {
    // 界面偏好读取失败只回到默认显示，不阻断阅读馆启动。
    const record = await drive.storage.get<{ statusLine?: boolean }>(UI_KEY, { signal: appLifecycle.signal }).catch(() => null)
    uiPrefs = { statusLine: record?.value?.statusLine !== false }
    uiRevision = record?.revision ?? null
    syncProxies()
  }
  const offStorageEvents = drive.on('storage.changed', (value) => {
    const key = typeof (value as { key?: string })?.key === 'string' ? (value as { key: string }).key : ''
    if (key === UI_KEY) { if (!drive.storage.wroteRecently?.(key)) void loadUiPrefs(); return }
    const visible = key.startsWith('library:flags:') || key.startsWith('library:reading:') || key.startsWith('progress:')
    if (visible) library.invalidateReadingState(key)
    if (key === 'library:book-groups') { scheduleLibraryRefresh('groups'); return }
    if (drive.storage.wroteRecently?.(key)) return
    if (key === library.sources.key) scheduleLibraryRefresh('sources')
    else if (key === 'library:works') scheduleLibraryRefresh('works')
    else if (visible) scheduleLibraryRefresh('state')
  })
  const offFileEvents = drive.on('files.changed', (value) => {
    const paths = (value as { paths?: unknown } | undefined)?.paths
    const activeSources = manualShelves
      ? library.access.sources.filter(source => source.nodeId === library.snapshot.indexedSourceId)
      : library.access.sources
    if (!activeSources.length || !filesChangeAffectsSources(activeSources, paths)) return
    scheduleLibraryRefresh('files', Array.isArray(paths) && paths.every(path => typeof path === 'string') ? paths : undefined)
  })
  const offSyncEvents = drive.on('sync.hint', async value => {
    library.invalidateReadingState()
    if (!value?.filesRecovered) { scheduleLibraryRefresh('sources'); return }
    const before = JSON.stringify(library.snapshot.sources.config)
    try {
      await library.initialize()
      if (before !== JSON.stringify(library.snapshot.sources.config)) scheduleLibraryRefresh('sources')
      else scheduleLibraryRefresh('state')
    } catch (error) { report(error) }
  })
  const offScopeEvents = drive.on('scope.changed', () => { library.invalidateReadingState(); scheduleLibraryRefresh('sources') })

  const openDetail = async (
    itemOrUnit: CatalogItem | { unit: ReadingUnit; work?: Work }
  ) => {
    if (currentView) {
      previousView = currentView
    }
    currentView = 'detail'

    homeSection.hidden = true
    librarySection.hidden = true
    detailSection.hidden = false
    meSection.hidden = true

    detailView?.setBackHandler(() => {
      void switchView(previousView)
    })
    navManager?.setActive(previousView)
    await detailView?.render(itemOrUnit)
    navManager?.refreshLibraries()
  }

  const closeApp = async () => {
    capture()
    await store?.flush()
    await drive.ui.close()
  }

  // 持久化偏好存储 (V2 schemaVersion: 2，分格式与作品覆盖)
  const prefStore = new PreferenceStore(drive, options.id === 'reader' ? readerDefaultPreferences : defaultPreferences)
  let globalPrefsSnapshot: PreferencesSnapshot = {
    value: defaultPreferences(),
    revision: null,
    migrated: false,
  }

  // 正文阅读器活动会话状态
  let bookController = new AbortController()
  let bookGeneration = 0
  let currentFile: FileEntry | undefined
  let currentUnit: ReadingUnit | undefined
  let currentUnitNodeId: number | undefined
  let currentUnitState: ValueSnapshot<UnitState> | undefined
  let view: ReaderView | undefined
  let store: ProgressStore | undefined
  let canSave = false
  let readerReady = false
  let navigationQueue = Promise.resolve()
  let bookmarkCursor: string | null = null
  let jumpDirty = false
  let prefQueue = Promise.resolve()
  let readerNav: ReaderNavigation | undefined

  let activeFormat: PreferenceFormat = options.kind === 'comics' ? 'comic' : 'text'
  let activeWork: Work | undefined = undefined
  let workPrefsSnapshot: WorkPreferencesSnapshot | undefined = undefined
  let prefScope: 'format' | 'work' = 'format'
  let comicAutoScroll = false
  let comicShapeDeadline = 0
  // 阅读界面偏好（常驻章节与进度）属于本应用私有设置，不进入分格式阅读偏好记录。
  const UI_KEY = 'reader-ui'
  let uiPrefs: { statusLine: boolean } = { statusLine: true }
  let uiRevision: string | null = null
  let bookmarkLocations: { key: string; revision: string; location: Location }[] = []
  let progressDragging = false
  let quickWorkScope = false
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  function toast(message: string) {
    const element = get('reader-toast')
    element.textContent = message; element.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { element.hidden = true }, 1600)
  }

  /** 同一章内字符偏移相近（文字）或同一页（漫画/PDF）视为当前位置已有书签。 */
  function matchingBookmark(location: Location) {
    return bookmarkLocations.find(({ location: saved }) => saved.index === location.index && (
      saved.offset === undefined || location.offset === undefined ? true : Math.abs(saved.offset - location.offset) < 240))
  }
  function syncBookmarkQuick(location: Location) {
    const button = get('bookmark-quick'), marked = !!matchingBookmark(location)
    button.setAttribute('aria-pressed', String(marked))
    button.setAttribute('aria-label', marked ? '移除书签' : '添加书签'); button.title = marked ? '移除书签' : '添加书签'
    const svg = button.querySelector('svg')
    if (svg && svg.dataset.marked !== String(marked)) { svg.outerHTML = icon(marked ? 'bookmarkFilled' : 'bookmark'); button.querySelector('svg')!.dataset.marked = String(marked) }
  }
  async function loadBookmarkLocations(file: FileEntry, generation: number) {
    const found: typeof bookmarkLocations = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < 10; page++) {
        const records: Awaited<ReturnType<typeof drive.storage.list<Bookmark>>> = await drive.storage.list<Bookmark>({ prefix: `bookmark:${file.id}:`, limit: 100, cursor }, { signal: bookController.signal })
        for (const record of records.records) {
          if (record.value && validLocation(record.value.location) && record.value.content_version === file.content_version) found.push({ key: record.key, revision: record.revision, location: record.value.location })
        }
        cursor = records.next_cursor
        if (!cursor) break
      }
    } catch (error) { if (!isAbort(error)) report(error); return }
    if (generation !== bookGeneration) return
    bookmarkLocations = found
    if (view) syncBookmarkQuick(view.current())
  }
  let prefs: Preferences = resolvePreferences(globalPrefsSnapshot.value, activeFormat)

  const pageGestures = () => {
    if (!view) return false
    const format = view.current().format
    if (format === 'comic') return prefs.mode !== 'scroll' && prefs.zoom <= 1
    return format === 'pdf'
      ? prefs.zoom <= 1 && get('viewport').scrollWidth <= get('viewport').clientWidth + 2
      : ['txt', 'epub'].includes(format) && prefs.mode === 'page'
  }

  chrome = new ReaderChrome(root, {
    immersive: true,
    desktopControls: options.id === 'reader',
    drive,
    context,
    shelf: options.id === 'reader',
    paged: pageGestures,
    drag: (dx) => !!view && readerReady && !!view.dragPage?.(dx),
    settle: (delta) => { if (view?.settlePage) void navigate(() => view!.settlePage!(delta)).catch(report) },
    turn: (delta) => {
      const actualDelta =
        view?.current().format === 'comic' && prefs.direction === 'rtl' ? ((-delta as unknown) as -1 | 1) : delta
      void navigate(() => view!.turn(actualDelta)).catch(report)
    },
    error: report,
    onPanelChange: (panel) => { readerNav?.onPanelChange(panel === 'navigation'); if (panel !== 'navigation') bodySearch?.stop() },
  })

  readerNav = new ReaderNavigation({
    root: get('navigation'),
    view: () => view,
    navigate,
    closePanel: () => chrome?.closePanel(),
    report,
    onJump: () => {
      jumpDirty = false
    },
  })

  bodySearch = new BodySearch(get('body-search'), () => view, navigate, () => chrome?.closePanel())

  const applyTheme = () => {
    document.body.dataset.theme =
      prefs.theme === 'system' ? (dark ? 'dark' : 'light') : prefs.theme
    void chrome?.themeChanged()
  }

  function resolveActivePreferences() {
    prefs = resolvePreferences(
      globalPrefsSnapshot.value,
      activeFormat,
      workPrefsSnapshot?.value
    )
    // 长条漫在本作未手动指定排版时临时按连续滚动显示；只影响显示，不写回偏好。
    if (activeFormat === 'comic' && comicAutoScroll && workPrefsSnapshot?.value?.overrides?.comic?.mode === undefined) {
      prefs = { ...prefs, mode: 'scroll' }
    }
  }

  function syncPreferences() {
    for (const [id, key] of Object.entries({
      theme: 'theme',
      font: 'font',
      'font-size': 'fontSize',
      'line-height': 'lineHeight',
      margin: 'margin',
      width: 'width',
      mode: 'mode',
      'comic-mode': 'mode',
      fit: 'fit',
      direction: 'direction',
      zoom: 'zoom',
    })) {
      const input = get<HTMLInputElement | HTMLSelectElement>(id)
      if (input && key in prefs) {
        input.value = String(prefs[key as keyof Preferences] ?? '')
      }
    }
    const coverAloneInput = get<HTMLInputElement>('cover-alone')
    if (coverAloneInput) {
      coverAloneInput.checked = !!prefs.coverAlone
    }
    const spreadOffsetInput = get<HTMLSelectElement>('spread-offset')
    if (spreadOffsetInput) {
      spreadOffsetInput.value = String(prefs.spreadOffset ?? 0)
    }

    const fsDec = get<HTMLButtonElement>('font-size-decrease')
    const fsInc = get<HTMLButtonElement>('font-size-increase')
    const lhDec = get<HTMLButtonElement>('line-height-decrease')
    const lhInc = get<HTMLButtonElement>('line-height-increase')
    const mgDec = get<HTMLButtonElement>('margin-decrease')
    const mgInc = get<HTMLButtonElement>('margin-increase')
    if (fsDec) fsDec.disabled = prefs.fontSize <= 12
    if (fsInc) fsInc.disabled = prefs.fontSize >= 36
    if (lhDec) lhDec.disabled = prefs.lineHeight <= 1.2
    if (lhInc) lhInc.disabled = prefs.lineHeight >= 2.8
    if (mgDec) mgDec.disabled = (prefs.margin ?? 12) <= 0
    if (mgInc) mgInc.disabled = (prefs.margin ?? 12) >= 64

    // 覆盖状态标签与清除按钮
    const hasWorkOverride =
      !!workPrefsSnapshot?.value?.overrides?.[activeFormat] &&
      Object.keys(workPrefsSnapshot.value.overrides[activeFormat]!).length > 0
    show('pref-scope-work-label', !!activeWork)
    show('pref-clear-work', !!activeWork && hasWorkOverride)

    get('viewport').dataset.mode = prefs.mode
    syncProxies()
    applyTheme()
  }

  /** 分段按钮与色块只是原选择框的快捷入口：选中态始终从选择框读取，单一真源。 */
  function syncProxies() {
    for (const group of root.querySelectorAll<HTMLElement>('[data-proxy]')) {
      const select = get<HTMLSelectElement>(group.dataset.proxy!)
      for (const button of group.querySelectorAll<HTMLButtonElement>('button[data-value]')) {
        button.setAttribute('aria-pressed', String(!!select && select.value === button.dataset.value))
      }
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-line-preset] button')) {
      button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.value) - prefs.lineHeight) < .05))
    }
    text('font-size-value', String(prefs.fontSize))
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-font-step]')) {
      button.disabled = Number(button.dataset.fontStep) < 0 ? prefs.fontSize <= 12 : prefs.fontSize >= 36
    }
    get('status-line-toggle').setAttribute('aria-checked', String(uiPrefs.statusLine))
    get('reader').dataset.statusLine = String(uiPrefs.statusLine)
  }

  function saveActivePreference(
    patch: Partial<TextPreferences & ComicPreferences & PdfPreferences>
  ) {
    const format = activeFormat
    const targetScope = quickWorkScope ? 'work' : prefScope
    quickWorkScope = false

    prefQueue = prefQueue.catch(() => {}).then(async () => {
      try {
        if (targetScope === 'work' && workPrefsSnapshot && activeWork) {
          workPrefsSnapshot = await prefStore.saveWork(
            workPrefsSnapshot,
            format,
            patch,
            bookController.signal
          )
        } else {
          globalPrefsSnapshot = await prefStore.saveFormat(
            globalPrefsSnapshot,
            format,
            patch,
            bookController.signal
          )
        }
        resolveActivePreferences()
        syncPreferences()
        if (view && readerReady) {
          void navigate(() => view!.configure(prefs)).catch(report)
        }
      } catch (error) {
        if (error instanceof PreferenceSaveError) {
          if (error.code === 'storage_conflict') {
            text('notice', error.message)
            show('notice', true)
          } else {
            text('notice', '偏好未确认保存，草稿已保留，请重试')
            show('notice', true)
          }
        } else {
          report(error)
        }
      }
    })
    void prefQueue.catch(report)
  }

  function clearActiveWorkPreference() {
    if (!workPrefsSnapshot || !activeWork) return
    const format = activeFormat
    prefQueue = prefQueue.catch(() => {}).then(async () => {
      try {
        workPrefsSnapshot = await prefStore.clearWork(
          workPrefsSnapshot!,
          format,
          bookController.signal
        )
        resolveActivePreferences()
        syncPreferences()
        if (view && readerReady) {
          void navigate(() => view!.configure(prefs)).catch(report)
        }
      } catch (error) {
        report(error)
      }
    })
    void prefQueue.catch(report)
  }

  function capture(immediate = false) {
    if (!view || !currentFile || !view.sections.length) return
    const location = view.current()
    const state = view.navigationState()
    const flow = ['txt', 'epub'].includes(location.format)

    // 进度摘要不伪造全书百分比
    text(
      'position',
      flow && state.pageIndex !== undefined && state.pageCount !== undefined
        ? `本节 ${state.pageIndex + 1}/${state.pageCount} 页 · ${view.sections[state.sectionIndex]?.label ?? '正文'}`
        : `${location.index + 1} / ${view.sections.length}`
    )
    Object.assign(get('position').dataset, {
      section: String(state.sectionIndex),
      page: String(state.pageIndex ?? 0),
      pages: String(state.pageCount ?? 0),
    })
    get('viewport').dataset.swipe = String(pageGestures())
    text('jump-label', flow ? '章节 / 分段' : '页码')
    text('previous', flow && state.pageIndex === undefined ? '上一节' : '上一页')
    text('next', flow && state.pageIndex === undefined ? '下一节' : '下一页')
    if (!jumpDirty) get<HTMLInputElement>('jump').value = String(location.index + 1)
    get<HTMLInputElement>('jump').max = String(view.sections.length)
    readerNav?.syncLocation(location)
    get<HTMLButtonElement>('previous').disabled = !state.canPrevious
    get<HTMLButtonElement>('next').disabled = !state.canNext
    const count = view.sections.length, label = view.sections[location.index]?.label ?? ''
    const unit = flow ? '章' : '页'
    for (const [id, delta] of [['chapter-prev', -1], ['chapter-next', 1]] as const) {
      const button = get<HTMLButtonElement>(id), name = `${delta < 0 ? '上' : '下'}一${unit}`
      button.disabled = delta < 0 ? location.index <= 0 : location.index >= count - 1
      button.setAttribute('aria-label', name); button.title = name
    }
    const progress = get<HTMLInputElement>('progress')
    progress.max = String(Math.max(1, count))
    if (!progressDragging) progress.value = String(location.index + 1)
    progress.closest<HTMLElement>('.progress-slider')!.hidden = count <= 1
    text('meta-chapter', flow ? label : view.title)
    text('meta-progress', flow
      ? [state.pageIndex !== undefined && state.pageCount !== undefined ? `${state.pageIndex + 1}/${state.pageCount}` : '', count > 1 ? `第 ${location.index + 1}/${count} 章` : ''].filter(Boolean).join(' · ')
      : `${location.index + 1} / ${count}`)
    syncBookmarkQuick(location)

    // 非阻断显示内存降级提示（如双页超预算暂按单页显示），恢复后清除
    const noticeEl = get('layout-notice')
    if (noticeEl) {
      if (state.layoutNotice) {
        noticeEl.textContent = state.layoutNotice
        noticeEl.hidden = false
      } else {
        noticeEl.hidden = true
        noticeEl.textContent = ''
      }
    }

    // 真实末端与显式完成 / 连读下一卷按钮联动（必须 atEnd === true 才显示）
    const completionEl = get('reader-completion')
    if (completionEl) {
      if (state.atEnd === true) {
        completionEl.hidden = false
        const nextBtn = get<HTMLButtonElement>('btn-next-volume')
        const visibleUnitIds = new Set(library.snapshot.units.map((u) => u.nodeId))
        const nextNodeId =
          activeWork && currentUnitNodeId !== undefined
            ? nextWorkUnit(activeWork, currentUnitNodeId, visibleUnitIds)
            : undefined
        const nextUnit =
          nextNodeId !== undefined
            ? library.snapshot.units.find((u) => u.nodeId === nextNodeId)
            : undefined
        if (nextUnit && nextBtn) {
          nextBtn.hidden = false
          nextBtn.disabled = nextVolumeOpening
          nextBtn.textContent = `读完并下一卷：${nextUnit.file.name.replace(/\.[^.]+$/, '')} →`
          nextBtn.onclick = async () => {
            if (nextVolumeOpening) return
            nextVolumeOpening = true
            const generation = bookGeneration
            nextBtn.disabled = true
            try {
              if (currentFile && currentUnitState) {
                currentUnitState = await library.reading.markRead(
                  currentFile,
                  currentUnitState,
                  bookController.signal
                )
              }
              if (generation === bookGeneration) await openReader(nextUnit.nodeId)
            } catch (err) {
              report(err)
            } finally { nextVolumeOpening = false; if (generation === bookGeneration) nextBtn.disabled = false }
          }
        } else if (nextBtn) {
          nextBtn.hidden = true
        }
      } else {
        completionEl.hidden = true
      }
    }

    const encoding = (view as ReaderView & { encoding?: string }).encoding
    if (encoding) get<HTMLSelectElement>('encoding').value = encoding
    if (canSave && validLocation(location)) {
      store?.mark({ file: currentFile, title: view.title, location }, immediate)
    }
  }

  async function closeReader() {
    capture()
    const previous = store
    canSave = false
    readerReady = false
    const closingGeneration = ++bookGeneration
    bookController.abort()
    bodySearch?.update()
    readerNav?.update(undefined)
    view?.destroy()
    previous?.stop()
    view = undefined
    store = undefined
    currentFile = undefined
    currentUnit = undefined
    currentUnitNodeId = undefined
    currentUnitState = undefined
    activeWork = undefined
    workPrefsSnapshot = undefined

    show('reader', false)
    // 进度保存与书库重绘完成前不接收卡片点击，避免按下后节点被替换而漏掉点击。
    get('app-ui').inert = true
    show('app-ui', true)
    show('preferences', false)
    show('bookmarks', false)

    try {
      await Promise.all([previous?.flush(), chrome?.leave()])
      if (stopped || closingGeneration !== bookGeneration) return

      // 恢复书库运行并刷新当前所在视图
      library.resume()
      library.invalidateReadingState()
      if (pendingFull || pendingSources || pendingWorks || pendingPaths.size) scheduleLibraryRefresh(pendingSources ? 'sources' : pendingWorks && !pendingFull && !pendingPaths.size ? 'works' : 'files', pendingFull ? undefined : [...pendingPaths])
      else if (pendingGroups || pendingState) scheduleLibraryRefresh(pendingGroups ? 'groups' : 'state')
      if (currentView === 'detail' && detailView && detailSection) {
        if (detailView['currentItem']) {
          await detailView.render(detailView['currentItem'])
        } else if (detailView['currentUnit']) {
          await detailView.render({
            unit: detailView['currentUnit']!,
            work: detailView['currentWork'],
          })
        }
      } else if (currentView === 'library') {
        await libraryView?.render(true)
      } else if (currentView === 'home') {
        await homeView?.render()
      }
    } finally {
      if (!stopped && closingGeneration === bookGeneration) {
        navManager?.refreshLibraries()
        get('app-ui').inert = false
      }
    }
  }

  function toc() {
    readerNav?.update(view)
  }

  /** 打开后几秒内按已知页形状决定长条漫是否改为连续滚动；之后不再自动改变阅读方式。 */
  function detectComicShape() {
    if (!view || !readerReady || activeFormat !== 'comic' || !comicShapeDeadline) return
    if (Date.now() > comicShapeDeadline) { comicShapeDeadline = 0; return }
    if (workPrefsSnapshot?.value?.overrides?.comic?.mode !== undefined) { comicShapeDeadline = 0; return }
    const shape = view.pageShape?.()
    if (!shape) return
    comicShapeDeadline = 0
    if (shape !== 'tall' || prefs.mode === 'scroll') return
    comicAutoScroll = true
    resolveActivePreferences(); syncPreferences()
    void navigate(() => view!.configure(prefs)).catch(report)
  }

  /** 打开正文阅读器（从图书/漫画卡片、详情开始阅读按钮、按需目录或首页续读卡调用） */
  async function openReader(nodeId: number, targetLocation?: Location) {
    capture()
    library.pause()

    const oldStore = store
    canSave = false
    readerReady = false
    bookController.abort()
    bodySearch?.stop()
    readerNav?.update(undefined)
    view?.destroy()
    oldStore?.stop()
    const flushed = oldStore?.flush()

    view = undefined
    store = undefined
    currentUnitNodeId = nodeId
    const active = ++bookGeneration
    bookController = new AbortController()
    const signal = bookController.signal

    show('app-ui', false)
    show('reader', true)
    show('conflict', false)
    show('retry-reader', false)
    show('bookmarks', false)
    show('reader-completion', false)
    show('layout-notice', false)

    get('viewport').replaceChildren()
    get('viewport').dataset.format = ''
    get('viewport').dataset.mode = ''
    get('viewport').dataset.swipe = 'false'
    get('toc').replaceChildren()
    get('toc-tree')?.replaceChildren()
    jumpDirty = false

    text('position', '')
    text('reading-status', '正在读取内容，请稍候…')
    text('sync', '')

    let owned: ReaderView | undefined
    try {
      await chrome?.enter()
      signal.throwIfAborted()

      // 通过 ReadingLibrary 校验文件身份并获取单位
      const unit = await library.openUnit(nodeId, signal)
      currentUnit = library.snapshot.units.find((candidate) => candidate.nodeId === nodeId)
        ?? { nodeId, file: unit.file, format: unit.format, sourceIds: unit.sourceIds, firstIndexedAt: 0 }
      signal.throwIfAborted()
      currentFile = unit.file
      text('book-title', unit.file.name)
      if (drive.can?.('ui.setTitle')) void drive.ui.setTitle?.(unit.file.name).catch(() => {})

      // 解析对应 Work 及作品级覆盖
      const worksSnapshot = library.snapshot.works
      const rawWork = worksSnapshot.rows.find((w) =>
        w.members.some((m) => m.unitId === unit.file.id)
      )
      activeWork = rawWork ? resolveWork(worksSnapshot.rows, rawWork.id) ?? rawWork : undefined
      activeFormat =
        unit.format === 'cbz' || unit.format === 'zip' || unit.format === 'images'
          ? 'comic'
          : preferenceFormat(unit.format)
      comicAutoScroll = false
      comicShapeDeadline = activeFormat === 'comic' ? Date.now() + 4000 : 0
      bookmarkLocations = []
      void loadBookmarkLocations(unit.file, active)

      // 加载当前作品的偏好覆盖
      workPrefsSnapshot = undefined
      if (activeWork) {
        try {
          workPrefsSnapshot = await prefStore.loadWork(activeWork.id, signal)
        } catch {
          workPrefsSnapshot = undefined
        }
      }
      resolveActivePreferences()
      syncPreferences()

      await flushed
      signal.throwIfAborted()

      const activeStore = new ProgressStore(drive, unit.file, (message: string, conflict: boolean) => {
        if (active === bookGeneration) {
          text('sync', message)
          get('sync').dataset.state = conflict || message.includes('失败') ? 'error' : 'ok'
          if (drive.can?.('ui.setExitMessage')) void drive.ui.setExitMessage?.((conflict || message.includes('失败')) ? '阅读进度尚未同步，离开后可能需要重试保存。' : '').catch(() => {})
          show('conflict', conflict)
          if (conflict || message.includes('失败')) chrome?.reveal()
        }
      })
      store = activeStore

      // 提取阅读状态并决定恢复位置（版本变化不恢复旧位置）
      const readingSnap = await library.reading.load(unit.file, signal)
      signal.throwIfAborted()
      currentUnitState = readingSnap.state
      activeStore.seed(readingSnap.progress)

      const reading: ViewContext = {
        drive,
        file: unit.file,
        signal,
        prefs,
        viewport: get('viewport'),
        navigate,
        changed: () => {
          if (active === bookGeneration) {
            if (readerReady && view && view.sections.length !== navigationSize) { navigationSize = view.sections.length; readerNav?.update(view) }
            detectComicShape()
            capture()
          }
        },
        error: (err) => {
          if (active === bookGeneration) { show('retry-reader', true); report(err) }
        },
      }

      owned = await options.create(reading)
      signal.throwIfAborted()
      view = owned

      const startLoc =
        targetLocation ??
        (readingSnap.reading.versionChanged === false ? readingSnap.reading.location : undefined)

      await owned.open(startLoc)
      signal.throwIfAborted()

      if (reading.prefs !== prefs) await owned.configure(prefs)
      signal.throwIfAborted()

      if (active !== bookGeneration) return

      text('book-title', [owned.title, owned.author].filter(Boolean).join(' · '))
      text('reading-status', '')
      toc()

      const format = owned.current().format
      get('viewport').dataset.format = format
      get('viewport').dataset.mode = prefs.mode

      // 根据格式与 capabilities 控制控件显示
      const caps = owned.capabilities
      const isText = ['txt', 'epub'].includes(format)
      const isComic = format === 'comic'
      const isPdf = format === 'pdf'

      for (const el of document.querySelectorAll<HTMLElement>('.flow-option')) {
        el.hidden = !isText
      }
      show('font-option', isText || !!caps?.fonts)
      show('margin-option', isText || !!caps?.margin)
      show('encoding-option', format === 'txt')
      show('mode-option', isText)
      show('comic-mode-option', isComic)
      show('direction-option', isComic && (caps?.direction ?? true))
      show('cover-alone-option', isComic && (caps?.spreads ?? true))
      show('spread-offset-option', isComic && (caps?.spreads ?? true))
      show('fit-option', (isComic || isPdf) && !!caps?.fits)
      show('zoom-option', isComic || isPdf)
      get('reader').dataset.formatKind = isText ? 'text' : isComic ? 'comic' : 'pdf'
      // 漫画和 PDF 没有文字快捷项，排版面板直接展开全部设置。
      get('preferences').dataset.expanded = String(!isText)
      get('pref-advanced-toggle').setAttribute('aria-expanded', String(!isText))
      syncProxies()
      show('download', !unit.file.is_dir)

      bodySearch?.update()
      navigationSize = view.sections.length
      readerReady = true
      canSave = true
      capture(true)
      chrome?.opened()
    } catch (error) {
      owned?.destroy()
      if (active === bookGeneration && !isAbort(error)) {
        view = undefined
        await chrome?.leave()
        text('reading-status', errorText(error))
        show('retry-reader', true)
        report(error)
      }
    }
  }

  function navigate(work: () => Promise<void>): Promise<void> {
    if (!view || !readerReady) return Promise.resolve()
    const active = bookGeneration
    const target = view
    const operation = navigationQueue.catch(() => {}).then(async () => {
      if (active !== bookGeneration || target !== view) return
      canSave = false
      try {
        await work()
      } finally {
        if (active === bookGeneration) {
          canSave = true
          capture(true)
        }
      }
    })
    navigationQueue = operation
    return operation
  }

  async function bookmarks(reset = false) {
    const file = currentFile
    const active = bookGeneration
    if (!file) return
    if (reset) {
      bookmarkCursor = null
      get('bookmark-items').replaceChildren()
      void loadBookmarkLocations(file, active)
    }
    const records = await drive.storage.list<Bookmark>({
      prefix: `bookmark:${file.id}:`,
      limit: 100,
      cursor: bookmarkCursor,
    })
    if (active !== bookGeneration) return
    for (const record of records.records) {
      if (
        !record.value ||
        !validLocation(record.value.location) ||
        record.value.content_version !== file.content_version
      ) {
        continue
      }
      const row = document.createElement('div')
      row.className = 'bookmark-row'
      const open = document.createElement('button')
      const name = document.createElement('input')
      const rename = document.createElement('button')
      const remove = document.createElement('button')
      name.value =
        typeof record.value.title === 'string'
          ? record.value.title.slice(0, 120)
          : '书签'
      name.maxLength = 120
      name.setAttribute('aria-label', '修改书签名称')
      open.textContent = `跳转到 ${record.value.location.index + 1}`
      rename.textContent = '改名'
      remove.textContent = '删除'
      open.onclick = () => {
        void navigate(() => view!.restore(record.value.location))
          .then(() => chrome?.closePanel())
          .catch(report)
      }
      rename.onclick = () => {
        void drive.storage
          .set(
            record.key,
            { ...record.value, title: name.value.trim() || '书签' },
            record.revision
          )
          .then(() => bookmarks(true))
          .catch(report)
      }
      remove.onclick = () => {
        void drive.storage
          .delete(record.key, record.revision)
          .then(() => bookmarks(true))
          .catch(report)
      }
      row.append(name, open, rename, remove)
      get('bookmark-items').append(row)
    }
    bookmarkCursor = records.next_cursor
    show('bookmark-more', !!bookmarkCursor)
  }

  // 绑定正文阅读器动作
  bind('back', async () => {
    await closeReader()
  })
  bind('retry-reader', () => {
    if (currentFile) return openReader(currentFile.id)
  })
  bind('download', () => {
    if (currentFile && !currentFile.is_dir) return drive.ui.download(currentFile.path)
  })
  // 更多菜单：移动端可在阅读中直达目录设置、作品详情与退出；返回网盘复用宿主退出流程。
  bind('reader-close', () => closeApp())
  bind('btn-reader-settings', () => drive.settings.open())
  bind('btn-reader-detail', async () => {
    const unit = currentUnit, work = activeWork
    if (!unit) return
    await closeReader()
    await openDetail({ unit, work })
  })
  bind('preferences-toggle', () => chrome?.togglePanel('preferences'))
  bind('appearance-toggle', () => chrome?.togglePanel('appearance', get('appearance-toggle')))
  bind('paging-toggle', () => chrome?.togglePanel('paging', get('paging-toggle')))
  bind('pref-advanced-toggle', () => {
    const panel = get('preferences'), expanded = panel.dataset.expanded !== 'true'
    panel.dataset.expanded = String(expanded)
    get('pref-advanced-toggle').setAttribute('aria-expanded', String(expanded))
  })
  // 快捷控件写回原选择框并派发 change，沿用既有保存、冲突与应用流程。
  root.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-proxy] button[data-value]') : null
    if (!button || button.disabled) return
    const id = button.closest<HTMLElement>('[data-proxy]')!.dataset.proxy!
    const select = get<HTMLSelectElement>(id)
    if (!select || select.value === button.dataset.value) return
    // 翻页面板里改漫画排版视为对本作的选择，有作品时记在作品上。
    if (id === 'comic-mode' && activeWork && workPrefsSnapshot) quickWorkScope = true
    select.value = button.dataset.value!
    select.dispatchEvent(new Event('change'))
    syncProxies()
  })
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-line-preset] button')) {
    button.addEventListener('click', () => {
      const value = Number(button.dataset.value)
      if (Math.abs(value - prefs.lineHeight) >= .05) saveActivePreference({ lineHeight: value })
    })
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-font-step]')) {
    button.addEventListener('click', () => get(Number(button.dataset.fontStep) < 0 ? 'font-size-decrease' : 'font-size-increase').click())
  }
  bind('status-line-toggle', async () => {
    const next = { ...uiPrefs, statusLine: !uiPrefs.statusLine }
    uiPrefs = next; syncProxies()
    try {
      const saved = await drive.storage.set(UI_KEY, next, uiRevision)
      uiRevision = saved.revision
    } catch (error) {
      // 其他设备同时修改时以远端为准，避免静默覆盖。
      const remote = await drive.storage.get<{ statusLine?: boolean }>(UI_KEY).catch(() => null)
      uiPrefs = { statusLine: remote?.value?.statusLine !== false }; uiRevision = remote?.revision ?? null
      syncProxies(); report(error)
    }
  })
  get('progress').addEventListener('input', () => {
    progressDragging = true
    const input = get<HTMLInputElement>('progress'), index = Number(input.value) - 1
    const bubble = get('progress-bubble')
    bubble.textContent = view?.sections[index]?.label || `${index + 1} / ${view?.sections.length ?? 0}`
    bubble.hidden = false
    bubble.style.setProperty('--progress', String(index / Math.max(1, Number(input.max) - 1)))
  })
  get('progress').addEventListener('change', () => {
    progressDragging = false
    get('progress-bubble').hidden = true
    const index = Number(get<HTMLInputElement>('progress').value) - 1
    if (view && index !== view.current().index) void navigate(() => view!.go(index)).catch(report)
  })
  bind('chapter-prev', () => view && navigate(() => view!.go(view!.current().index - 1)))
  bind('chapter-next', () => view && navigate(() => view!.go(view!.current().index + 1)))
  bind('bookmark-quick', async () => {
    if (!view || !currentFile || !canSave) return
    const file = currentFile, location = view.current(), active = bookGeneration
    const existing = matchingBookmark(location)
    if (existing) {
      await drive.storage.delete(existing.key, existing.revision)
      bookmarkLocations = bookmarkLocations.filter(item => item !== existing)
      toast('已移除书签')
    } else {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('')
      const saved = await drive.storage.set(`bookmark:${file.id}:${id}`, {
        title: view.sections[location.index]?.label || '书签', location, content_version: file.content_version,
      } satisfies Bookmark)
      if (active !== bookGeneration) return
      bookmarkLocations.push({ key: saved.key, revision: saved.revision, location })
      toast('已添加书签')
    }
    if (active === bookGeneration && view) syncBookmarkQuick(view.current())
  })
  // toc-toggle 由 ReaderChrome 构造函数统一绑定到 navigation 面板，此处不重复监听避免快速重置
  bind('bookmarks-toggle', async () => {
    if (chrome?.togglePanel('bookmarks')) await bookmarks(true)
  })
  bind('bookmark-more', () => bookmarks())
  bind('add-bookmark', async () => {
    if (!view || !currentFile || !canSave) return
    const file = currentFile
    const location = view.current()
    const active = bookGeneration
    const id = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    await drive.storage.set(`bookmark:${file.id}:${id}`, {
      title:
        get<HTMLInputElement>('bookmark-name').value.trim() ||
        view.sections[location.index]?.label ||
        '书签',
      location,
      content_version: file.content_version,
    } satisfies Bookmark)
    if (active === bookGeneration) {
      get<HTMLInputElement>('bookmark-name').value = ''
      await bookmarks(true)
    }
  })
  bind('previous', () => navigate(() => view!.turn(-1)))
  bind('next', () => navigate(() => view!.turn(1)))
  get('jump')?.addEventListener('input', () => {
    jumpDirty = true
  })
  bind('retry-save', () => {
    capture()
    return store?.flush()
  })
  bind('use-cloud', async () => {
    const active = bookGeneration
    const remote = await store?.resolve(true)
    if (active !== bookGeneration || !view) return
    if (remote && validLocation(remote.location)) {
      await navigate(() => view!.restore(remote.location))
    }
  })
  bind('use-current', async () => {
    capture()
    await store?.resolve(false)
  })

  // 显式完成按钮（读完）
  bind('btn-mark-finished', async () => {
    if (!currentFile) return
    try {
      if (!currentUnitState) {
        const snap = await library.reading.load(currentFile, bookController.signal)
        currentUnitState = snap.state
      }
      currentUnitState = await library.reading.markRead(
        currentFile,
        currentUnitState,
        bookController.signal
      )
      text('notice', '已标记为已读')
      show('notice', true)
    } catch (err) {
      report(err)
    }
  })

  // 从头重读按钮（更多操作菜单）
  bind('btn-reader-restart', async () => {
    if (!currentFile || !view) return
    const confirmed = await showConfirmModal({
      title: '从头重读',
      message: '确定从第一页开始重读吗？原阅读进度和所有书签均会保留。',
      confirmText: '从头阅读',
    })
    if (!confirmed) return
    try {
      if (!currentUnitState) {
        const snap = await library.reading.load(currentFile, bookController.signal)
        currentUnitState = snap.state
      }
      const result = await library.reading.restart(
        currentFile,
        currentUnitState,
        view.current().format,
        true,
        bookController.signal
      )
      currentUnitState = result.state
      await navigate(() => view!.go(0))
      chrome?.closePanel()
    } catch (err) {
      report(err)
    }
  })

  // 偏好设置覆盖范围单选监听
  const scopeRadios = document.querySelectorAll<HTMLInputElement>('input[name="pref-scope"]')
  scopeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      prefScope = radio.value as 'format' | 'work'
      syncPreferences()
    })
  })
  bind('pref-clear-work', () => {
    clearActiveWorkPreference()
  })

  // 阅读设置项输入监听
  for (const [id, key] of Object.entries({
    theme: 'theme',
    font: 'font',
    'font-size': 'fontSize',
    'line-height': 'lineHeight',
    margin: 'margin',
    width: 'width',
    mode: 'mode',
    'comic-mode': 'mode',
    fit: 'fit',
    direction: 'direction',
    zoom: 'zoom',
  })) {
    get(id)?.addEventListener('change', () => {
      const raw = get<HTMLInputElement | HTMLSelectElement>(id).value
      saveActivePreference({
        [key]: ['fontSize', 'lineHeight', 'margin', 'width', 'zoom'].includes(key)
          ? Number(raw)
          : raw,
      })
    })
  }

  get('cover-alone')?.addEventListener('change', () => {
    saveActivePreference({
      coverAlone: get<HTMLInputElement>('cover-alone').checked,
    })
  })

  get('spread-offset')?.addEventListener('change', () => {
    saveActivePreference({
      spreadOffset: Number(get<HTMLSelectElement>('spread-offset').value) as 0 | 1,
    })
  })

  const step = (id: string, action: () => unknown) => {
    get(id)?.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        Promise.resolve(action()).catch(report)
      } catch (error) {
        report(error)
      }
    })
  }
  step('font-size-decrease', () => {
    const next = Math.max(12, Math.round(prefs.fontSize - 1))
    if (next !== prefs.fontSize) saveActivePreference({ fontSize: next })
  })
  step('font-size-increase', () => {
    const next = Math.min(36, Math.round(prefs.fontSize + 1))
    if (next !== prefs.fontSize) saveActivePreference({ fontSize: next })
  })
  step('line-height-decrease', () => {
    const next = Math.max(1.2, Math.round((prefs.lineHeight - 0.1) * 10) / 10)
    if (next !== prefs.lineHeight) saveActivePreference({ lineHeight: next })
  })
  step('line-height-increase', () => {
    const next = Math.min(2.8, Math.round((prefs.lineHeight + 0.1) * 10) / 10)
    if (next !== prefs.lineHeight) saveActivePreference({ lineHeight: next })
  })
  step('margin-decrease', () => {
    const next = Math.max(0, Math.round(((prefs.margin ?? 12) - 2)))
    if (next !== prefs.margin) saveActivePreference({ margin: next })
  })
  step('margin-increase', () => {
    const next = Math.min(64, Math.round(((prefs.margin ?? 12) + 2)))
    if (next !== prefs.margin) saveActivePreference({ margin: next })
  })

  const updateStepperDisabled = () => {
    const fs = get<HTMLInputElement>('font-size')
    const lh = get<HTMLInputElement>('line-height')
    const mg = get<HTMLInputElement>('margin')
    const fsDec = get<HTMLButtonElement>('font-size-decrease')
    const fsInc = get<HTMLButtonElement>('font-size-increase')
    const lhDec = get<HTMLButtonElement>('line-height-decrease')
    const lhInc = get<HTMLButtonElement>('line-height-increase')
    const mgDec = get<HTMLButtonElement>('margin-decrease')
    const mgInc = get<HTMLButtonElement>('margin-increase')
    if (fs && fsDec && fsInc) {
      fsDec.disabled = Number(fs.value) <= 12
      fsInc.disabled = Number(fs.value) >= 36
    }
    if (lh && lhDec && lhInc) {
      lhDec.disabled = Number(lh.value) <= 1.2
      lhInc.disabled = Number(lh.value) >= 2.8
    }
    if (mg && mgDec && mgInc) {
      mgDec.disabled = Number(mg.value) <= 0
      mgInc.disabled = Number(mg.value) >= 64
    }
  }
  get('font-size')?.addEventListener('input', updateStepperDisabled)
  get('line-height')?.addEventListener('input', updateStepperDisabled)
  get('margin')?.addEventListener('input', updateStepperDisabled)

  get('encoding')?.addEventListener('change', () => {
    const reader = view as ReaderView & { setEncoding?: (v: string) => Promise<void> }
    if (reader?.setEncoding) {
      void navigate(async () => {
        await reader.setEncoding!(get<HTMLSelectElement>('encoding').value)
        toc()
      }).catch(report)
    }
  })

  const onKey = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (
      event.defaultPrevented ||
      target?.closest(
        'input,select,textarea,button,[role="link"],[role="dialog"],.flow-block-scroll'
      ) ||
      !view ||
      !readerReady
    ) {
      return
    }
    let delta = ['ArrowRight', 'PageDown'].includes(event.key)
      ? 1
      : ['ArrowLeft', 'PageUp'].includes(event.key)
        ? -1
        : 0
    if (
      view.current().format === 'comic' &&
      prefs.direction === 'rtl' &&
      event.key.startsWith('Arrow')
    ) {
      delta *= -1
    }
    if (delta) {
      event.preventDefault()
      void navigate(() => view!.turn(delta as -1 | 1)).catch(report)
    }
  }
  document.addEventListener('keydown', onKey)

  const offTheme = drive.on('theme.changed', ({ dark: nextDark }) => {
    dark = nextDark
    applyTheme()
  })

  const offClose = drive.on('beforeClose', async () => {
    capture()
    await Promise.all([store?.flush(), prefQueue.catch(() => {})])
  })

  const onVisibility = () => {
    if (document.hidden) {
      capture()
      void store?.flush()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  window.addEventListener(
    'pagehide',
    () => {
      stopped = true
      canSave = false
      bookGeneration++
      appLifecycle.abort()
      bookController.abort()
      readerNav?.destroy()
      view?.destroy()
      store?.stop()
      chrome?.destroy()
      unbindLibrary()
      library.destroy()
      homeView?.destroy()
      libraryView?.destroy()
      detailView?.destroy()
      meView?.destroy()
      navManager?.destroy()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onVisibility)
      offTheme()
      offClose()
      clearTimeout(noticeTimer)
    },
    { once: true }
  )

  // 初始化 UI 视图组件
  const uiContext: UiContext = {
    drive,
    library,
    kind: options.kind,
    signal: appLifecycle.signal,
    createShelf: async () => {
      const nodeId = await showShelfModal(uiContext)
      if (nodeId !== null) await switchView('library', { sourceId: nodeId })
    },
    editShelf: async nodeId => { await showShelfModal(uiContext, nodeId) },
    openReader,
    openDetail,
    switchView,
    openLibrary: selection => switchView('library', selection),
    librarySelectionChanged: selection => {
      navManager?.setLibrarySelection(selection)
      navManager?.refreshLibraries()
    },
    reportError: report,
    createReader: options.create,
    closeApp,
  }

  navManager = new NavManager(get('nav-container'), uiContext)
  homeView = new HomeView(homeSection, uiContext)
  libraryView = new LibraryView(librarySection, uiContext)
  detailView = new DetailView(detailSection, uiContext)
  meView = new MeView(meSection, uiContext)

  let initializing = false
  const startupRetry = get('startup-retry') as HTMLButtonElement
  bind('startup-retry', initialize)
  bind('startup-exit', closeApp)
  async function initialize() {
    if (initializing || stopped) return
    initializing = true
    startupRetry.disabled = true
    clearTimeout(noticeTimer)
    show('notice', false)
    get('app-ui').inert = true
    text('startup-message', '正在加载阅读馆…')
    try {
      // 读取持久化偏好设置（使用 PreferenceStore V2 结构）
      globalPrefsSnapshot = await prefStore.load(appLifecycle.signal)
      await loadUiPrefs()
      resolveActivePreferences()
      syncPreferences()

      // 初始化统一阅读馆数据层
      await drive.lifecycle?.migrate(context.data_schema ?? 1, async signal => { await library.initialize(signal) })
      let snapshot = await library.initialize(appLifecycle.signal)
      if (options.kind !== 'comics') {
        await library.bookGroups.load(appLifecycle.signal).catch(report)
        navManager?.refreshLibraries()
      }
      const launchFile = context.launch?.file
      if (launchFile) {
        const file = await drive.files.stat({ id: launchFile.id, content_version: launchFile.content_version }, { signal: appLifecycle.signal })
        const sourcePath = file.is_dir ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/'
        if (manualShelves) {
          const source = snapshot.sources.config.sources.filter(source => file.path === source.path || file.path.startsWith(source.path === '/' ? '/' : source.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0]
          if (!source) {
            await switchView('home')
            report(new Error('请先手动创建书库并绑定此文件所在目录；不会自动创建或扫描书库。'))
            await drive.lifecycle?.report('ready')
            show('startup-error', false); get('app-ui').inert = false
            return
          }
          await switchView('library', { sourceId: source.nodeId })
        } else if (!snapshot.sources.config.sources.some(source => source.path === '/' || file.path === source.path || file.path.startsWith(source.path + '/'))) {
          const added = await library.addSource(sourcePath, { confirmedRoot: sourcePath === '/', signal: appLifecycle.signal })
          void added.scan.catch(report)
        }
        await openReader(file.id)
        await drive.lifecycle?.report('ready')
        show('startup-error', false)
        get('app-ui').inert = false
        return
      }
      if (!manualShelves && !snapshot.sources.config.sources.length && context.scope?.mode === 'selected') {
        for (const path of context.scope.paths.slice(0, 16)) {
          const added = await library.addSource(path, { confirmedRoot: path === '/', signal: appLifecycle.signal })
          await added.scan
        }
        snapshot = library.snapshot
      }
      // 旧版封面缩略图占用私有存储配额，后台回收；失败不影响阅读馆使用。
      void library.purgeLegacyCovers(appLifecycle.signal).catch(() => {})

      // 未配置来源时进入“我的”，只使用当前来源管理
      if (manualShelves) {
        // 授权范围不是书库。打开应用只展示用户创建的书库，不扫全盘或自动采用旧来源。
        await switchView('home')
      } else if (snapshot.sources.config.sources.length === 0) {
        await switchView('me')
      } else {
        // 如果已有来源，缓存优先展示；如果缓存为空，自动触发轻扫描发现新增
        if (snapshot.units.length === 0) {
          await library.refresh(appLifecycle.signal).catch(() => {})
        }
        await switchView('home')
      }
      await drive.lifecycle?.report('ready')
      show('startup-error', false)
      get('app-ui').inert = false
    } catch (error) {
      if (stopped || isAbort(error)) return
      report(error)
      void drive.lifecycle?.report('failed', errorText(error)).catch(() => {})
      text('startup-message', '阅读馆暂时无法加载，请检查连接后重试。')
      show('startup-error', true)
    } finally {
      initializing = false
      startupRetry.disabled = false
    }
  }
  await initialize()
}
