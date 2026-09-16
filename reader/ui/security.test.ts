/**
 * UI-02 安全显示与防注入回归测试套件
 *
 * 验证对不可信输入（搜索词、来源路径、作品标题、作者、简介、分卷名、各类错误消息、人工整理表单）：
 * 1. 原始文本按字符串完整显示（textContent / input.value / option.textContent）
 * 2. 不产生注入节点（如 <b id="injected">、<script>、<iframe>、<img onerror>）
 * 3. 不触发内联事件属性（如 onerror、onload，window.pwned 永不被赋值）
 * 4. 不产生外链资源请求（在 JSDOM/浏览器 DOM 树中不创建带有外部 src 的 img 等节点）
 *
 * 使用真实 memoryDrive、CAS 发布、真实 DOM 渲染与事件，不依赖 grep、不依赖私有反射。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Drive, FileEntry } from '../../sdk/types'
import {
  ReadingLibrary,
  type ReadingUnit,
  type Work,
} from '../library'
import { file, memoryDrive, signal } from '../library/test-fixtures'
import { HomeView } from './home'
import { LibraryView } from './library-view'
import { DetailView } from './detail-view'
import { MeView } from './me-view'
import {
  showConfirmModal,
  showEditMetadataModal,
  showReorderMembersModal,
  showMergeWorksModal,
  showSplitWorkModal,
} from './modals'
import type { UiContext, UiView } from './types'

declare global {
  interface Window {
    pwned?: number
  }
}

describe('UI-02: 界面文本防注入与安全显示回归', () => {
  let container: HTMLElement
  let modalContainer: HTMLElement
  let context: UiContext
  let mockDrive: ReturnType<typeof memoryDrive>
  let library: ReadingLibrary
  let currentView: UiView = 'home'
  let openedDetailItem: Parameters<UiContext['openDetail']>[0] | undefined
  let openedReaderNodeId: number | undefined

  // 典型 XSS 探测向量：包含单双引号、尖括号、DOM 注入节点 ID 与 onerror / script 探测
  const XSS_SEARCH = '<b id="injected-search">"XSS-Query\'</b><img src=x onerror=window.pwned=1>'
  const XSS_SOURCE_NAME = '<b id="injected-source">"EvilSource\'</b><script>window.pwned=1</script>'
  const XSS_SOURCE_PATH = `/书库/${XSS_SOURCE_NAME}`
  const XSS_RAW_NAME = '<b id="injected-raw">"RawTitle\'</b><img src=x onerror=window.pwned=1>'
  const XSS_TITLE = '<b id="injected-title">"EvilTitle\'</b><img src=x onerror=window.pwned=1>'
  const XSS_AUTHOR_1 = '<b id="injected-author1">"Author\'</b>'
  const XSS_AUTHOR_2 = '<img id="injected-author2" src=x onerror=window.pwned=1>'
  const XSS_DESC = '<div id="injected-desc">"Summary\'</div><iframe src="about:blank"></iframe>'
  const XSS_ERROR_MSG = '<b id="injected-error">"ErrorOccurred\'</b><img src=x onerror=window.pwned=1>'

  let rootDir: FileEntry
  let evilSourceDir: FileEntry
  let evilBook: FileEntry

  beforeEach(() => {
    // 重置全局 window.pwned 标记
    delete window.pwned

    document.body.innerHTML = `
      <div id="app">
        <div id="modal-container"></div>
        <div id="test-container"></div>
      </div>
    `
    container = document.getElementById('test-container')!
    modalContainer = document.getElementById('modal-container')!

    // 创建根目录和带 XSS 向量路径的来源目录及文件
    rootDir = file(1, '/书库', true)
    evilSourceDir = file(2, XSS_SOURCE_PATH, true)
    evilBook = file(101, `/书库/book-101.epub`, false, 'v1', 102400)
    evilBook.name = `${XSS_RAW_NAME}.epub`

    mockDrive = memoryDrive([rootDir, evilSourceDir, evilBook], {
      source_dir: '/书库',
    })

    const drive = Object.assign(mockDrive.drive, {
      ready: Promise.resolve({
        id: 'books',
        name: '图书',
        version: '1.0.0',
        api_version: 2,
        dark: false,
      }),
      settings: {
        get: async () => ({ source_dir: '/书库' }),
        patch: vi.fn(),
        open: vi.fn(),
      },
      ui: {
        close: vi.fn(async () => {}),
        download: vi.fn(async () => {}),
      },
      on: () => () => {},
    }) as unknown as Drive

    library = new ReadingLibrary(drive, 'books')

    openedDetailItem = undefined
    openedReaderNodeId = undefined
    currentView = 'home'

    context = {
      drive,
      library,
      kind: 'books',
      signal: signal(),
      openReader: async (nodeId) => {
        openedReaderNodeId = nodeId
      },
      openDetail: (item) => {
        openedDetailItem = item
      },
      switchView: (v) => {
        currentView = v
      },
      reportError: vi.fn(),
      createReader: vi.fn(),
      closeApp: vi.fn(),
    }
  })

  afterEach(() => {
    library.destroy()
    document.body.replaceChildren()
    delete window.pwned
  })

  it('1. 书库视图：搜索输入含引号尖括号时，原文本以字符串保留，不产生注入节点与请求', async () => {
    await library.initialize()
    await library.refresh()

    const libraryView = new LibraryView(container, context)
    // 初始状态即带有恶意搜索词
    libraryView.setState({ query: XSS_SEARCH })
    await libraryView.render()

    const searchInput = container.querySelector<HTMLInputElement>('#library-search')
    expect(searchInput).not.toBeNull()
    // 搜索框中必须完整保留原输入字符串（包括双引号、单引号与尖括号）
    expect(searchInput?.value).toBe(XSS_SEARCH)

    // 断言 DOM 中绝无由搜索词解析生成的注入标签或外链图片
    expect(document.getElementById('injected-search')).toBeNull()
    expect(container.querySelector('b#injected-search')).toBeNull()
    expect(container.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 搜索不匹配时的状态提示
    const statusMsg = container.querySelector<HTMLElement>('#library-status')
    expect(statusMsg?.textContent).toContain('没有匹配的图书或漫画')
    expect(statusMsg?.querySelector('b')).toBeNull()

    // 用户在输入框动态输入恶意内容
    const dynamicInput = '<script id="dynamic-script">window.pwned=2</script>'
    searchInput!.value = dynamicInput
    searchInput!.dispatchEvent(new Event('input'))

    // 真正等待防抖（300ms）触发并更新视图查询状态，而非断言未存在的节点
    await vi.waitFor(() => {
      expect(libraryView.getState().query).toBe(dynamicInput)
    })
    expect(document.getElementById('dynamic-script')).toBeNull()
    expect(window.pwned).toBeUndefined()

    libraryView.destroy()
  })

  it('2. 来源筛选与来源列表：来源路径含引号尖括号与脚本标签时，原文本按字符串显示且不执行注入', async () => {
    // 为书库添加带有恶意路径的来源，并显式观测其扫描任务
    await library.initialize()
    const added = await library.addSource(XSS_SOURCE_PATH)
    await added.scan

    // 2.1 书库来源下拉框
    const libraryView = new LibraryView(container, context)
    await libraryView.render()

    const sourceSelect = container.querySelector<HTMLSelectElement>('#filter-source')
    expect(sourceSelect).not.toBeNull()

    const option = [...sourceSelect!.options].find((opt) => opt.value === '2')
    expect(option).toBeDefined()
    // option 的展示文本必须为完整原路径字符串
    expect(option?.textContent).toBe(XSS_SOURCE_PATH)
    // 下拉框内不得产生注入标签
    expect(sourceSelect?.querySelector('b#injected-source')).toBeNull()
    expect(document.getElementById('injected-source')).toBeNull()
    expect(window.pwned).toBeUndefined()
    libraryView.destroy()

    // 2.2 “我的”来源管理子视图
    const meView = new MeView(container, context)
    await meView.render('sources')

    const pathTitle = [...container.querySelectorAll<HTMLElement>('.source-item-path')]
      .find((el) => el.textContent?.includes(XSS_SOURCE_NAME))
    expect(pathTitle).toBeDefined()
    expect(pathTitle?.textContent).toBe(XSS_SOURCE_PATH)
    expect(pathTitle?.querySelector('b#injected-source')).toBeNull()
    expect(document.getElementById('injected-source')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 点击移除来源，触发确认弹窗
    const removeBtns = container.querySelectorAll<HTMLButtonElement>('.btn-danger')
    const evilRemoveBtn = removeBtns[removeBtns.length - 1]
    expect(evilRemoveBtn).toBeDefined()
    evilRemoveBtn!.click()

    await vi.waitFor(() => {
      expect(modalContainer.querySelector('.modal-dialog')).not.toBeNull()
    })

    // 弹窗消息包含不可信来源路径，断言以纯文本显示且不注入 DOM
    const modalMsg = modalContainer.querySelector<HTMLElement>('.modal-message')
    expect(modalMsg?.textContent).toContain(XSS_SOURCE_PATH)
    expect(modalMsg?.querySelector('b#injected-source')).toBeNull()
    expect(document.getElementById('injected-source')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 取消弹窗
    modalContainer.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    meView.destroy()
  })

  it('3. 书库卡片与详情：标题、作者、简介含恶意标签时，纯文本渲染且不发起外链资源请求', async () => {
    await library.initialize()
    await library.refresh()

    const rawUnit = library.snapshot.units.find((u) => u.nodeId === evilBook.id)
    expect(rawUnit).toBeDefined()

    // 3.1 验证无人工元数据时，原始文件名（含标签与引号）通过 textContent 安全直出
    const libraryView = new LibraryView(container, context)
    await libraryView.render()

    const rawCard = container.querySelector<HTMLElement>('.library-card')
    expect(rawCard).not.toBeNull()

    const rawTitleEl = rawCard?.querySelector('.card-title')
    // 原始文件名作为回退标题，完整保留尖括号与引号字符串
    expect(rawTitleEl?.textContent).toBe(XSS_RAW_NAME)
    expect(rawTitleEl?.querySelector('b#injected-raw')).toBeNull()
    expect(document.getElementById('injected-raw')).toBeNull()
    expect(container.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()
    libraryView.destroy()

    // 3.2 验证人工元数据覆盖（含标签与引号）被安全净化且以纯文本展示
    const initialWorks = library.snapshot.works
    const baseWork = initialWorks.rows[0]!
    const evilWork: Work = {
      ...baseWork,
      overrides: {
        title: XSS_TITLE,
        authors: [XSS_AUTHOR_1, XSS_AUTHOR_2],
        description: XSS_DESC,
      },
    }
    await library.publishWorks({
      ...initialWorks,
      rows: [evilWork],
    })

    const detailView = new DetailView(container, context)
    await detailView.render({ unit: rawUnit!, work: evilWork })

    const detailTitle = container.querySelector<HTMLElement>('#detail-title')
    // 经 DOMPurify 净化后剥离 HTML 标签，纯文本与单双引号完整保留
    expect(detailTitle?.textContent).toContain('EvilTitle')
    expect(detailTitle?.querySelector('b#injected-title')).toBeNull()

    const detailAuthor = container.querySelector<HTMLElement>('#detail-author')
    expect(detailAuthor?.textContent).toContain('Author')
    expect(detailAuthor?.querySelector('b#injected-author1')).toBeNull()
    expect(detailAuthor?.querySelector('img')).toBeNull()

    const detailDesc = container.querySelector<HTMLElement>('#detail-desc-text')
    expect(detailDesc?.textContent).toContain('Summary')
    expect(detailDesc?.querySelector('div#injected-desc')).toBeNull()
    expect(detailDesc?.querySelector('iframe')).toBeNull()

    // 文件信息表格
    const fileInfo = container.querySelector<HTMLElement>('#detail-file-info')
    expect(fileInfo?.textContent).toContain(rawUnit!.file.path)
    expect(fileInfo?.querySelector('b#injected-raw')).toBeNull()

    // 检查绝无注入节点和外链资源（在 JSDOM 环境中验证 DOM 树无注入节点）
    expect(document.getElementById('injected-title')).toBeNull()
    expect(document.getElementById('injected-author1')).toBeNull()
    expect(document.getElementById('injected-author2')).toBeNull()
    expect(document.getElementById('injected-desc')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()
    detailView.destroy()
  })

  it('4. 首页视图：最新续读卡与最近加入含恶意标签时，纯文本渲染且不注入 DOM', async () => {
    await library.initialize()
    await library.refresh()

    const evilUnit = library.snapshot.units.find((u) => u.nodeId === evilBook.id)!
    expect(evilUnit).toBeDefined()

    const initialWorks = library.snapshot.works
    const baseWork = initialWorks.rows[0]!
    await library.publishWorks({
      ...initialWorks,
      rows: [{ ...baseWork, overrides: { title: '测试作品' } }],
    })

    // 模拟历史进度记录带有恶意标签
    const progressSummary = '<b id="injected-progress">"第 1 卷\'</b>'
    mockDrive.seed(
      `progress:${evilUnit.nodeId}`,
      {
        file: evilUnit.file,
        title: '测试作品',
        location: { format: 'epub', index: 0 },
        summary: { label: progressSummary },
      },
      2000
    )

    const homeView = new HomeView(container, context)
    await homeView.render()

    // 续读卡标题与进度文案
    const continueTitle = container.querySelector<HTMLElement>('.continue-title')
    expect(continueTitle?.textContent).toBe('测试作品')

    const continueProg = container.querySelector<HTMLElement>('.continue-progress')
    expect(continueProg?.textContent).toContain(progressSummary)
    expect(continueProg?.querySelector('b#injected-progress')).toBeNull()

    // aria-label 属性文本包含原字符串但保持纯属性
    const continueCard = container.querySelector<HTMLElement>('.continue-card')
    expect(continueCard?.getAttribute('aria-label')).toBe('继续阅读 测试作品')

    // 最近加入列表卡片
    const recentCardTitle = container.querySelector<HTMLElement>('#home-recent-grid .card-title')
    expect(recentCardTitle?.textContent).toBe('测试作品')

    expect(document.getElementById('injected-progress')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    homeView.destroy()
  })

  it('5. 错误消息防注入：目录加载、添加来源、历史、想读、收藏错误均以纯文本展示', async () => {
    await library.initialize()
    await library.refresh()

    const testUnit = library.snapshot.units.find((u) => u.nodeId === evilBook.id)!
    expect(testUnit).toBeDefined()

    // 5.1 详情目录加载失败消息注入测试
    const detailView = new DetailView(container, context)
    // 模拟 createReader 抛出含有 HTML 标签的错误
    context.createReader = vi.fn(async () => {
      throw new Error(XSS_ERROR_MSG)
    })

    await detailView.render({ unit: testUnit })

    const loadTocBtn = container.querySelector<HTMLButtonElement>('#btn-load-toc')
    expect(loadTocBtn).not.toBeNull()
    loadTocBtn!.click()

    await vi.waitFor(() => {
      expect(container.querySelector('.toc-error')).not.toBeNull()
    })

    const tocErrorEl = container.querySelector<HTMLElement>('.toc-error')
    // 错误消息以纯文本呈现
    expect(tocErrorEl?.textContent).toContain(XSS_ERROR_MSG)
    expect(tocErrorEl?.querySelector('b#injected-error')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    detailView.destroy()

    // 5.2 “我的”来源管理：添加来源失败错误消息
    const meView = new MeView(container, context)
    await meView.render('sources')

    // 模拟 addSource 抛出含有 HTML 标签的错误
    vi.spyOn(library, 'addSource').mockRejectedValueOnce(new Error(XSS_ERROR_MSG))

    const pathInput = container.querySelector<HTMLInputElement>('#input-source-path')!
    pathInput.value = '/新来源'
    container.querySelector<HTMLFormElement>('#form-add-source')!.dispatchEvent(new Event('submit'))

    await vi.waitFor(() => {
      const errEl = container.querySelector<HTMLElement>('#add-source-error')
      expect(errEl?.hidden).toBe(false)
    })

    const addSrcErrorEl = container.querySelector<HTMLElement>('#add-source-error')
    expect(addSrcErrorEl?.textContent).toContain(XSS_ERROR_MSG)
    expect(addSrcErrorEl?.querySelector('b#injected-error')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 5.3 “我的”阅读历史：加载失败错误消息（通过公开 render('history') 触发，无需私有反射）
    vi.spyOn(library.history, 'page').mockRejectedValueOnce(new Error(XSS_ERROR_MSG))
    await meView.render('history')

    const histErrorEl = container.querySelector<HTMLElement>('#history-items-list .error-text')
    expect(histErrorEl).not.toBeNull()
    expect(histErrorEl?.textContent).toContain(XSS_ERROR_MSG)
    expect(histErrorEl?.querySelector('b#injected-error')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 5.4 “我的”想读清单：加载失败错误消息
    vi.spyOn(library, 'loadReadingState').mockRejectedValueOnce(new Error(XSS_ERROR_MSG))
    await meView.render('want')

    const wantErrorEl = container.querySelector<HTMLElement>('#want-items-list .error-text')
    expect(wantErrorEl).not.toBeNull()
    expect(wantErrorEl?.textContent).toContain(XSS_ERROR_MSG)
    expect(wantErrorEl?.querySelector('b#injected-error')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    // 5.5 “我的”收藏夹：加载失败错误消息
    vi.spyOn(library, 'loadReadingState').mockRejectedValueOnce(new Error(XSS_ERROR_MSG))
    await meView.render('fav')

    const favErrorEl = container.querySelector<HTMLElement>('#fav-items-list .error-text')
    expect(favErrorEl).not.toBeNull()
    expect(favErrorEl?.textContent).toContain(XSS_ERROR_MSG)
    expect(favErrorEl?.querySelector('b#injected-error')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    meView.destroy()
  })

  it('6. 人工整理表单模态框：输入与选项含特殊字符时，原文本完整保留且不产生注入节点', async () => {
    // 6.1 通用确认框 showConfirmModal
    const confirmPromise = showConfirmModal({
      title: '<h1 id="injected-confirm-title">"ConfirmTitle\'</h1>',
      message: XSS_ERROR_MSG,
      confirmText: '<span id="injected-confirm-ok">"OK\'</span>',
      cancelText: '<span id="injected-confirm-cancel">"Cancel\'</span>',
    })

    const dialog = modalContainer.querySelector<HTMLElement>('.modal-dialog')
    expect(dialog).not.toBeNull()

    const modalTitle = dialog?.querySelector('.modal-title')
    expect(modalTitle?.textContent).toContain('ConfirmTitle')
    expect(modalTitle?.querySelector('h1')).toBeNull()

    const modalMsg = dialog?.querySelector('.modal-message')
    expect(modalMsg?.textContent).toContain(XSS_ERROR_MSG)
    expect(modalMsg?.querySelector('b#injected-error')).toBeNull()

    const okBtn = dialog?.querySelector<HTMLButtonElement>('.btn-primary')
    expect(okBtn?.textContent).toContain('OK')
    expect(okBtn?.querySelector('span#injected-confirm-ok')).toBeNull()

    expect(document.getElementById('injected-confirm-title')).toBeNull()
    expect(document.getElementById('injected-confirm-ok')).toBeNull()
    expect(document.getElementById('injected-error')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(window.pwned).toBeUndefined()

    okBtn!.click()
    expect(await confirmPromise).toBe(true)

    // 6.2 修改元数据表单 showEditMetadataModal
    const editPromise = showEditMetadataModal({
      title: XSS_TITLE,
      series: '<b id="injected-series">"Series\'</b>',
      authors: [XSS_AUTHOR_1],
      description: XSS_DESC,
    })

    const editDialog = modalContainer.querySelector<HTMLElement>('.modal-dialog')
    expect(editDialog).not.toBeNull()

    const inputs = editDialog!.querySelectorAll<HTMLInputElement>('input[type="text"]')
    const textarea = editDialog!.querySelector<HTMLTextAreaElement>('textarea')

    // 输入框的 value 必须完整保存原字符串
    expect(inputs[0]?.value).toBe(XSS_TITLE)
    expect(inputs[1]?.value).toBe('<b id="injected-series">"Series\'</b>')
    expect(inputs[2]?.value).toBe(XSS_AUTHOR_1)
    expect(textarea?.value).toBe(XSS_DESC)

    // 不产生注入 DOM
    expect(document.getElementById('injected-title')).toBeNull()
    expect(document.getElementById('injected-series')).toBeNull()
    expect(document.getElementById('injected-author1')).toBeNull()
    expect(document.getElementById('injected-desc')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    expect(window.pwned).toBeUndefined()

    editDialog!.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    expect(await editPromise).toBeNull()

    // 6.3 调整卷话顺序表单 showReorderMembersModal
    const unitNameMap = new Map<number, string>([
      [101, '<b id="injected-member1">"第01卷\'</b>'],
      [102, '<b id="injected-member2">"第02卷\'</b>'],
    ])
    const reorderPromise = showReorderMembersModal(
      [
        { unitId: 101, role: 'main', firstIndexedAt: 1000 },
        { unitId: 102, role: 'extra', firstIndexedAt: 1010 },
      ],
      unitNameMap
    )

    const reorderDialog = modalContainer.querySelector<HTMLElement>('.modal-dialog')
    expect(reorderDialog).not.toBeNull()

    const memberNames = reorderDialog!.querySelectorAll<HTMLElement>('.reorder-name')
    expect(memberNames[0]?.textContent).toBe('<b id="injected-member1">"第01卷\'</b>')
    expect(memberNames[1]?.textContent).toBe('<b id="injected-member2">"第02卷\'</b>')

    expect(document.getElementById('injected-member1')).toBeNull()
    expect(document.getElementById('injected-member2')).toBeNull()
    expect(window.pwned).toBeUndefined()

    reorderDialog!.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    expect(await reorderPromise).toBeNull()

    // 6.4 合并作品表单 showMergeWorksModal
    const workTitles = new Map<string, string>([
      ['w1', '<b id="injected-w1">"作品A\'</b>'],
      ['w2', '<b id="injected-w2">"作品B\'</b>'],
    ])
    const currentWork: Work = {
      id: 'w1',
      kind: 'comics',
      members: [{ unitId: 101, role: 'main', firstIndexedAt: 1000 }],
      grouping: 'single',
      orderConfirmed: true,
      firstIndexedAt: 1000,
      overrides: {},
    }
    const otherWork: Work = {
      id: 'w2',
      kind: 'comics',
      members: [{ unitId: 102, role: 'main', firstIndexedAt: 1000 }],
      grouping: 'single',
      orderConfirmed: true,
      firstIndexedAt: 1000,
      overrides: {},
    }

    const mergePromise = showMergeWorksModal(currentWork, [currentWork, otherWork], workTitles)
    const mergeDialog = modalContainer.querySelector<HTMLElement>('.modal-dialog')
    expect(mergeDialog).not.toBeNull()

    const mergeHint = mergeDialog!.querySelector<HTMLElement>('.modal-hint')
    expect(mergeHint?.textContent).toContain('<b id="injected-w1">"作品A\'</b>')

    const checkboxLabel = mergeDialog!.querySelector<HTMLElement>('.modal-checkbox-label span')
    expect(checkboxLabel?.textContent).toContain('<b id="injected-w2">"作品B\'</b>')

    expect(document.getElementById('injected-w1')).toBeNull()
    expect(document.getElementById('injected-w2')).toBeNull()
    expect(window.pwned).toBeUndefined()

    mergeDialog!.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    expect(await mergePromise).toBeNull()

    // 6.5 拆分作品表单 showSplitWorkModal
    const splitPromise = showSplitWorkModal(
      {
        id: 'w1',
        kind: 'comics',
        members: [
          { unitId: 101, role: 'main', firstIndexedAt: 1000 },
          { unitId: 102, role: 'main', firstIndexedAt: 1000 },
        ],
        grouping: 'single',
        orderConfirmed: true,
        firstIndexedAt: 1000,
        overrides: {},
      },
      unitNameMap
    )

    const splitDialog = modalContainer.querySelector<HTMLElement>('.modal-dialog')
    expect(splitDialog).not.toBeNull()

    // 校验已批准法定文案
    const legalNotice = splitDialog!.querySelector<HTMLElement>('.contract-notice')
    expect(legalNotice?.textContent).toBe('第一组保留原作品标记，其余为新作品；各卷阅读进度和书签均保留。')

    const splitNames = splitDialog!.querySelectorAll<HTMLElement>('.split-name')
    expect(splitNames[0]?.textContent).toContain('<b id="injected-member1">"第01卷\'</b>')
    expect(splitNames[1]?.textContent).toContain('<b id="injected-member2">"第02卷\'</b>')

    expect(document.getElementById('injected-member1')).toBeNull()
    expect(document.getElementById('injected-member2')).toBeNull()
    expect(window.pwned).toBeUndefined()

    splitDialog!.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    expect(await splitPromise).toBeNull()
  })

  it('7. 漫画正番外章节列表与审核提示含不可信文本时安全显示', async () => {
    const comicFile1 = file(201, `/书库/comic-201.cbz`, false, 'v1', 1000)
    comicFile1.name = `${XSS_RAW_NAME}.cbz`
    const comicFile2 = file(202, `/书库/comic-202.cbz`, false, 'v1', 1000)
    comicFile2.name = `<b id="injected-extra">"番外篇'</b>.cbz`

    mockDrive.nodes.set(comicFile1.id, comicFile1)
    mockDrive.nodes.set(comicFile2.id, comicFile2)

    const comicLibrary = new ReadingLibrary(context.drive, 'comics')
    await comicLibrary.initialize()
    await comicLibrary.refresh()

    const unit1 = comicLibrary.snapshot.units.find((u) => u.nodeId === comicFile1.id)!
    const unit2 = comicLibrary.snapshot.units.find((u) => u.nodeId === comicFile2.id)!
    expect(unit1).toBeDefined()
    expect(unit2).toBeDefined()

    const initialWorks = comicLibrary.snapshot.works
    const work: Work = {
      id: initialWorks.rows[0]?.id || 'c001c002c003c004c001c002c003c004',
      kind: 'comics',
      members: [
        { unitId: unit1.nodeId, role: 'main', firstIndexedAt: 1000 },
        { unitId: unit2.nodeId, role: 'extra', firstIndexedAt: 1010 },
      ],
      grouping: 'manual',
      orderConfirmed: false,
      reviewReason: '<b id="injected-reason">"需要人工审核卷话顺序\'</b><script>window.pwned=1</script>',
      firstIndexedAt: 1000,
      overrides: {},
    }
    await comicLibrary.publishWorks({
      ...initialWorks,
      rows: [work],
    })

    const comicContext = { ...context, library: comicLibrary, kind: 'comics' as const }
    const detailView = new DetailView(container, comicContext)
    await detailView.render({ unit: unit1, work })

    // 审核提示条
    const noticeEl = container.querySelector<HTMLElement>('#comic-review-notice')
    expect(noticeEl?.hidden).toBe(false)
    expect(noticeEl?.textContent).toContain('<b id="injected-reason">"需要人工审核卷话顺序\'</b>')
    expect(noticeEl?.querySelector('b#injected-reason')).toBeNull()

    // 正篇章节标题
    const mainTitle = container.querySelector<HTMLElement>('#comic-main-chapters .chapter-title')
    expect(mainTitle?.textContent).toBe(XSS_RAW_NAME)
    expect(mainTitle?.querySelector('b#injected-raw')).toBeNull()

    // 番外章节标题
    const extraTitle = container.querySelector<HTMLElement>('#comic-extra-chapters .chapter-title')
    expect(extraTitle?.textContent).toBe('<b id="injected-extra">"番外篇\'</b>')
    expect(extraTitle?.querySelector('b#injected-extra')).toBeNull()

    // 检查绝无注入
    expect(document.getElementById('injected-reason')).toBeNull()
    expect(document.getElementById('injected-raw')).toBeNull()
    expect(document.getElementById('injected-extra')).toBeNull()
    expect(window.pwned).toBeUndefined()

    detailView.destroy()
    comicLibrary.destroy()
  })
})
