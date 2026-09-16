/** 阅读馆非正文界面单元测试：首页/书库/详情/我的、来源管理、人工归组CAS与阅读桥接。 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Drive, FileEntry } from '../../sdk/types'
import { ReadingLibrary, type Work } from '../library'
import { HomeView } from './home'
import { LibraryView } from './library-view'
import { DetailView } from './detail-view'
import { MeView } from './me-view'
import { showConfirmModal, showSplitWorkModal } from './modals'
import type { UiContext } from './types'

describe('阅读馆 UI 模块', () => {
  let drive: Drive
  let library: ReadingLibrary
  let context: UiContext
  let container: HTMLElement
  let openedReaderNodeId: number | undefined
  let openedReaderLocation: any
  let openedDetailItem: any
  let currentViewName: string

  const mockFile1: FileEntry = {
    id: 101,
    name: '三体.epub',
    path: '/书库/三体.epub',
    is_dir: false,
    size: 204800,
    content_version: 'v1',
    created_at: 1000,
    modified_at: 1000,
    favorite: false,
  }

  const mockComic1: FileEntry = {
    id: 201,
    name: '海贼王_第01卷.cbz',
    path: '/书库/海贼王_第01卷.cbz',
    is_dir: false,
    size: 5000000,
    content_version: 'v1',
    created_at: 2000,
    modified_at: 2000,
    favorite: false,
  }

  const mockComic2: FileEntry = {
    id: 202,
    name: '海贼王_第02卷.cbz',
    path: '/书库/海贼王_第02卷.cbz',
    is_dir: false,
    size: 5100000,
    content_version: 'v1',
    created_at: 2010,
    modified_at: 2010,
    favorite: false,
  }

  const mockRootDir: FileEntry = {
    id: 1,
    name: '书库',
    path: '/书库',
    is_dir: true,
    size: 0,
    content_version: 'v0',
    created_at: 1,
    modified_at: 1,
    favorite: false,
  }

  let storageStore = new Map<string, any>()

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><div id="modal-container"></div><div id="test-container"></div></div>'
    container = document.getElementById('test-container')!
    storageStore.clear()
    openedReaderNodeId = undefined
    openedReaderLocation = undefined
    openedDetailItem = undefined
    currentViewName = 'home'

    drive = {
      ready: Promise.resolve({
        id: 'books',
        name: '图书',
        version: '1.0.0',
        api_version: 2,
        dark: false,
      }),
      settings: { get: async () => ({ source_dir: '/书库' }) },
      storage: {
        get: async (key: string) =>
          storageStore.has(key) ? { value: storageStore.get(key), revision: 'r1' } : null,
        set: vi.fn(async (key: string, value: any) => {
          storageStore.set(key, value)
          return { key, value, revision: 'r1' }
        }),
        delete: vi.fn(async (key: string) => {
          storageStore.delete(key)
        }),
        list: async ({ prefix }: { prefix?: string }) => {
          const records = [...storageStore.entries()]
            .filter(([k]) => !prefix || k.startsWith(prefix))
            .map(([key, value]) => ({ key, value, revision: 'r1', updated_at: 1000 }))
          return { records, next_cursor: null }
        },
      },
      files: {
        list: async ({ path }: { path: string }) => ({
          entries: [mockFile1],
          path,
          next_cursor: null,
        }),
        stat: async (p: { id?: number; path?: string }) => {
          if (p.id === mockFile1.id || p.path === mockFile1.path) return mockFile1
          if (p.id === mockComic1.id || p.path === mockComic1.path) return mockComic1
          if (p.id === mockComic2.id || p.path === mockComic2.path) return mockComic2
          return mockRootDir
        },
        searchPage: vi.fn(async () => ({
          results: [],
          has_more: false,
          next_cursor: null,
        })),
      },
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    } as unknown as Drive

    library = new ReadingLibrary(drive, 'books')

    context = {
      drive,
      library,
      kind: 'books',
      signal: new AbortController().signal,
      openReader: async (nodeId, loc) => {
        openedReaderNodeId = nodeId
        openedReaderLocation = loc
      },
      openDetail: (item) => {
        openedDetailItem = item
      },
      switchView: (v) => {
        currentViewName = v
      },
      reportError: vi.fn(),
      createReader: vi.fn(),
      closeApp: vi.fn(),
    }
  })

  afterEach(() => {
    library.destroy()
    document.body.replaceChildren()
  })

  it('首页在无历史时展示友好空态并支持前往书库，有历史时展示续读卡并直接进入阅读', async () => {
    await library.initialize()
    await library.refresh()

    const homeView = new HomeView(container, context)
    await homeView.render()

    // 1. 无历史时的空态
    expect(container.querySelector('.empty-continue-card')).not.toBeNull()
    const goBtn = container.querySelector<HTMLButtonElement>('#btn-go-library')
    expect(goBtn).not.toBeNull()
    goBtn?.click()
    expect(currentViewName).toBe('library')

    // 2. 模拟写入一条阅读进度
    storageStore.set(`progress:${mockFile1.id}`, {
      file: mockFile1,
      title: '三体',
      location: { format: 'epub', index: 3 },
      summary: { label: '第一章 疯狂年代' },
    })

    await homeView.render()

    // 续读卡应展示标题与进度
    const continueCard = container.querySelector('.continue-card')
    expect(continueCard).not.toBeNull()
    expect(container.querySelector('.continue-title')?.textContent).toContain('三体')
    expect(container.querySelector('.continue-progress')?.textContent).toContain('第一章 疯狂年代')

    // 点击续读卡或其内部按钮应直接调用 openReader，不经过详情
    container.querySelector<HTMLButtonElement>('#btn-continue-reading')!.click()
    await vi.waitFor(() => expect(openedReaderNodeId).toBe(mockFile1.id))
    expect(openedDetailItem).toBeUndefined()

    homeView.destroy()
  })

  it('书库支持名称与作者搜索、格式与状态筛选、排序以及作品/文件视图切换', async () => {
    await library.initialize()
    await library.refresh()

    const libraryView = new LibraryView(container, context)
    await libraryView.render()

    // 初始展示
    await vi.waitFor(() => expect(container.querySelectorAll('#items button')).toHaveLength(1))
    expect(container.querySelector('.card-title')?.textContent).toContain('三体')

    // 搜索不匹配的词，应显示空提示
    const searchInput = container.querySelector<HTMLInputElement>('#library-search')!
    searchInput.value = '不存在的书名'
    searchInput.dispatchEvent(new Event('input'))

    await vi.waitFor(() => expect(container.querySelectorAll('#items button')).toHaveLength(0))
    expect(container.querySelector('#library-status')?.textContent).toContain('没有匹配')

    // 清空搜索恢复展示
    searchInput.value = ''
    searchInput.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(container.querySelectorAll('#items button')).toHaveLength(1))

    // 切换到文件视图
    container.querySelector<HTMLButtonElement>('#btn-view-files')!.click()
    await vi.waitFor(() => expect(container.querySelector('#btn-view-files')?.classList.contains('active')).toBe(true))

    // 保存与恢复筛选状态
    const savedState = libraryView.getState()
    expect(savedState.view).toBe('files')

    libraryView.setState({ sort: 'recent' })
    expect(libraryView.getState().sort).toBe('recent')

    libraryView.destroy()
  })

  it('图书详情支持想读/收藏切换、显式已读、重读弹窗确认，以及按需独立目录解析', async () => {
    await library.initialize()
    await library.refresh()

    const unit = library.snapshot.units[0]!
    const detailView = new DetailView(container, context)

    // 模拟独立 loadNavigation 目录解析
    const mockNav = [
      { label: '引子', location: { format: 'epub' as const, index: 0 }, depth: 0 },
      { label: '第一章 科学边界', location: { format: 'epub' as const, index: 1 }, depth: 1 },
    ]
    context.createReader = vi.fn(async () => ({
      title: '三体',
      sections: [{ label: '引子' }],
      loadNavigation: vi.fn(async () => mockNav),
      open: vi.fn(),
      current: () => ({ format: 'epub' as const, index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
      turn: vi.fn(),
      go: vi.fn(),
      restore: vi.fn(),
      configure: vi.fn(),
      destroy: vi.fn(),
    }))

    await detailView.render({ unit })

    // 标题与格式展示
    expect(container.querySelector('#detail-title')?.textContent).toContain('三体')
    expect(container.querySelector('#detail-format-badge')?.textContent).toBe('EPUB')

    // 1. 想读与收藏切换
    const wantBtn = container.querySelector<HTMLButtonElement>('#btn-flag-want')!
    wantBtn.click()
    await vi.waitFor(() => expect(wantBtn.classList.contains('active')).toBe(true))

    const favBtn = container.querySelector<HTMLButtonElement>('#btn-flag-fav')!
    favBtn.click()
    await vi.waitFor(() => expect(favBtn.classList.contains('active')).toBe(true))

    // 2. 标记为已读
    const markReadBtn = container.querySelector<HTMLButtonElement>('#btn-mark-read')!
    markReadBtn.click()
    await vi.waitFor(() => expect(container.querySelector('#detail-status-badge')?.textContent).toBe('已读'))

    // 3. 从头重读弹窗确认
    const rereadBtn = container.querySelector<HTMLButtonElement>('#btn-reread')!
    rereadBtn.click()
    await vi.waitFor(() => expect(document.querySelector('.modal-dialog')).not.toBeNull())

    // 点击确认重读
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-primary')!.click()
    await vi.waitFor(() => expect(openedReaderNodeId).toBe(unit.nodeId))
    expect(openedReaderLocation).toEqual({ format: 'epub', index: 0 })

    // 4. 按需目录解析
    const loadTocBtn = container.querySelector<HTMLButtonElement>('#btn-load-toc')!
    loadTocBtn.click()
    await vi.waitFor(() => expect(container.querySelectorAll('.toc-item-btn')).toHaveLength(2))

    // 点击某一章节直接打开阅读
    container.querySelectorAll<HTMLButtonElement>('.toc-item-btn')[1]!.click()
    expect(openedReaderLocation).toEqual(mockNav[1]!.location)

    detailView.destroy()
  })

  it('漫画详情正篇与番外分卷明确，人工拆分弹窗包含已批准法定文案并执行CAS更新', async () => {
    // 切换为漫画模式
    const comicLibrary = new ReadingLibrary(drive, 'comics')
    await comicLibrary.initialize()

    // 注入合成的两卷漫画单元
    const unit1 = {
      nodeId: mockComic1.id,
      file: mockComic1,
      format: 'cbz' as const,
      sourceIds: [1],
      firstIndexedAt: 1000,
    }
    const unit2 = {
      nodeId: mockComic2.id,
      file: mockComic2,
      format: 'cbz' as const,
      sourceIds: [1],
      firstIndexedAt: 1010,
    }

    comicLibrary['state'].units = [unit1, unit2]
    const work = {
      id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      kind: 'comics' as const,
      members: [
        { unitId: unit1.nodeId, role: 'main' as const, firstIndexedAt: 1000 },
        { unitId: unit2.nodeId, role: 'extra' as const, firstIndexedAt: 1010 },
      ],
      grouping: 'manual' as const,
      orderConfirmed: true,
      firstIndexedAt: 1000,
      overrides: { title: '海贼王' },
    }
    comicLibrary['state'].works.rows = [work]

    const comicContext = { ...context, library: comicLibrary, kind: 'comics' as const }
    const detailView = new DetailView(container, comicContext)
    await detailView.render({ unit: unit1, work })

    // 正篇与番外篇分别展示
    expect(container.querySelector('#comic-main-chapters')?.textContent).toContain('01卷')
    expect(container.querySelector('#comic-extra-chapters')?.textContent).toContain('02卷')

    // 打开拆分弹窗
    container.querySelector<HTMLButtonElement>('#btn-comic-split')!.click()
    await vi.waitFor(() => expect(document.querySelector('.modal-dialog')).not.toBeNull())

    // 校验已批准的法定确认文案
    const noticeEl = document.querySelector('.contract-notice')
    expect(noticeEl).not.toBeNull()
    expect(noticeEl?.textContent).toBe('第一组保留原作品标记，其余为新作品；各卷阅读进度和书签均保留。')

    // 确认拆分
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-primary')!.click()
    await vi.waitFor(() => expect(comicLibrary.snapshot.works.rows).toHaveLength(2))

    // 第一组保留原 Work ID
    expect(comicLibrary.snapshot.works.rows[0]?.id).toBe(work.id)
    // 第二组分配新 ID
    expect(comicLibrary.snapshot.works.rows[1]?.id).not.toBe(work.id)

    detailView.destroy()
    comicLibrary.destroy()
  })

  it('我的页面提供来源管理、根目录显式确认、扫描控制与缓存配额展示', async () => {
    await library.initialize()

    const meView = new MeView(container, context)
    await meView.render('sources')

    // 来源列表应展示已添加来源
    await vi.waitFor(() => expect(container.querySelectorAll('.source-list-item')).toHaveLength(1))
    expect(container.querySelector('.source-item-path')?.textContent).toBe('/书库')

    // 添加根目录触发显式确认框
    const pathInput = container.querySelector<HTMLInputElement>('#input-source-path')!
    pathInput.value = '/'
    container.querySelector<HTMLFormElement>('#form-add-source')!.dispatchEvent(new Event('submit'))

    await vi.waitFor(() => expect(document.querySelector('.modal-dialog')).not.toBeNull())
    expect(document.querySelector('.modal-message')?.textContent).toContain('添加根目录（/）将授权扫描整个网盘')

    // 点击取消不添加
    document.querySelector<HTMLButtonElement>('.modal-actions .btn-secondary')!.click()

    // 切换到缓存与设置标签
    container.querySelector<HTMLButtonElement>('#me-tab-settings')!.click()
    await vi.waitFor(() => expect(container.querySelector('.quota-card')).not.toBeNull())

    expect(container.querySelector('.quota-card')?.textContent).toContain('封面缩略图缓存（上限 8 MiB）')
    expect(container.querySelector('.quota-card')?.textContent).toContain('元数据缓存（上限 4 MiB）')

    meView.destroy()
  })

  it('UI-03: 文件视图在不完整索引下通过 SDK 游标分页发现未索引单元，支持下一页游标与安全打开', async () => {
    // 1. 初始化书库，但模拟索引不完整（complete: false）
    await library.initialize()
    await library.refresh()
    vi.spyOn(library, 'snapshot', 'get').mockReturnValue({
      ...library.snapshot,
      complete: false,
    })

    // 2. 模拟来源下存在尚未被索引的文件 mockFile2 和 mockFile3
    const unindexedFile2: FileEntry = {
      id: 102,
      name: '流浪地球.epub',
      path: '/书库/流浪地球.epub',
      is_dir: false,
      size: 100000,
      content_version: 'v1',
      created_at: 2000,
      modified_at: 2000,
      favorite: false,
    }
    const unindexedFile3: FileEntry = {
      id: 103,
      name: '球状闪电.epub',
      path: '/书库/球状闪电.epub',
      is_dir: false,
      size: 100000,
      content_version: 'v1',
      created_at: 3000,
      modified_at: 3000,
      favorite: false,
    }

    // mock access.list 返回第 1 页包含 unindexedFile2，并具有下一页游标 'cursor-p2'
    const listSpy = vi.spyOn(library.access, 'list').mockResolvedValueOnce({
      entries: [mockFile1, unindexedFile2],
      directory: mockRootDir,
      sourceIds: [1],
      has_more: true,
      next_cursor: 'cursor-p2',
      path: '/书库',
    } as any).mockResolvedValueOnce({
      entries: [unindexedFile3],
      directory: mockRootDir,
      sourceIds: [1],
      has_more: false,
      next_cursor: null,
      path: '/书库',
    } as any)

    const libraryView = new LibraryView(container, context)
    // 切换到文件视图
    libraryView.setState({ view: 'files' })
    await libraryView.render()

    // 提示条应展示不完整范围提示
    const scopeNotice = container.querySelector<HTMLElement>('#scope-notice')
    expect(scopeNotice?.hidden).toBe(false)

    // 文件列表应包含已索引的三体和 SDK 发现的未索引流浪地球
    await vi.waitFor(() => {
      const cards = container.querySelectorAll<HTMLElement>('.library-card')
      expect(cards.length).toBeGreaterThanOrEqual(2)
    })
    expect(container.textContent).toContain('流浪地球')

    // 下一页按钮因 has_more=true 处于启用状态
    const nextBtn = container.querySelector<HTMLButtonElement>('#btn-next-page')
    expect(nextBtn?.disabled).toBe(false)

    // 点击下一页，使用下一页游标拉取第 2 页
    nextBtn!.click()
    await vi.waitFor(() => {
      expect(listSpy).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('球状闪电')
    })

    // 3. 点击未索引单元卡片进入详情，并通过 openUnit 成功核验打开
    vi.spyOn(drive.files, 'stat').mockImplementation(async (p) => {
      if ('id' in p && p.id === unindexedFile3.id) return unindexedFile3
      return mockRootDir
    })

    const unindexedCard = [...container.querySelectorAll<HTMLElement>('.library-card')].find(
      (c) => c.textContent?.includes('球状闪电')
    )
    expect(unindexedCard).toBeDefined()
    unindexedCard!.click()
    expect(openedDetailItem).toBeDefined()
    expect(openedDetailItem.units[0].nodeId).toBe(unindexedFile3.id)

    // 4. 越界结果拒绝：当驱动返回不在来源范围内的节点（如 path 在 /私密/ 下），openUnit 必须抛出 outside_sources 并拒绝
    const outsideFile: FileEntry = {
      id: 999,
      name: '越界文件.epub',
      path: '/私密/越界文件.epub',
      is_dir: false,
      size: 50000,
      content_version: 'v1',
      created_at: 1,
      modified_at: 1,
      favorite: false,
    }
    vi.spyOn(drive.files, 'stat').mockImplementation(async (p) => {
      if ('id' in p && p.id === outsideFile.id) return outsideFile
      return mockRootDir
    })
    await expect(library.openUnit(outsideFile.id)).rejects.toMatchObject({
      code: 'outside_sources',
    })

    libraryView.destroy()
  })

  it('UI-05 & UI-08: 拆分作品第1组非空保护、弹窗signal取消与人工编辑草稿保留重试', async () => {
    // 1. 拆分作品表单：第 1 组为空时确认按钮必须禁用，不能私自将第 2 组变成新第 1 组
    const member1 = { unitId: 201, role: 'main' as const, firstIndexedAt: 1000 }
    const member2 = { unitId: 202, role: 'extra' as const, firstIndexedAt: 1010 }
    const workId = 'c001c002c003c004c001c002c003c004'
    const splitPromise = showSplitWorkModal(
      {
        id: workId,
        kind: 'comics',
        members: [member1, member2],
        grouping: 'single',
        orderConfirmed: true,
        firstIndexedAt: 1000,
        overrides: {},
      },
      new Map([[201, '第1卷'], [202, '第2卷']])
    )

    const splitDialog = document.querySelector<HTMLElement>('.modal-dialog')!
    expect(splitDialog).not.toBeNull()

    const confirmBtn = splitDialog.querySelector<HTMLButtonElement>('.modal-actions .btn-primary')!
    expect(confirmBtn.disabled).toBe(false)

    // 把第1卷也分配给第2组，导致第1组为空
    const select1 = splitDialog.querySelectorAll<HTMLSelectElement>('.split-group-select')[0]!
    select1.value = '2'
    select1.dispatchEvent(new Event('change'))

    // 此时第1组为空，确认按钮必须被禁用！
    expect(confirmBtn.disabled).toBe(true)

    // 取消弹窗
    splitDialog.querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    expect(await splitPromise).toBeNull()

    // 2. 弹窗 signal 取消测试：传入页面 signal 并在 abort 时自动清理弹窗且恢复原焦点
    const controller = new AbortController()
    const confirmPromise = showConfirmModal({
      title: '可取消弹窗',
      message: '测试取消',
      signal: controller.signal,
    })
    expect(document.querySelector('.modal-dialog')).not.toBeNull()
    controller.abort()
    expect(await confirmPromise).toBe(false)
    expect(document.querySelector('.modal-dialog')).toBeNull()

    // 3. 人工修改元数据 CAS 冲突与草稿保留重试
    const comicLibrary = new ReadingLibrary(drive, 'comics')
    await comicLibrary.initialize()
    const cUnit1 = { nodeId: 201, file: mockComic1, format: 'cbz' as const, sourceIds: [1], firstIndexedAt: 1000 }
    const work: Work = {
      id: 'c001c002c003c004c001c002c003c004',
      kind: 'comics',
      members: [member1],
      grouping: 'single',
      orderConfirmed: true,
      firstIndexedAt: 1000,
      overrides: { title: '原标题' },
    }
    comicLibrary['state'].units = [cUnit1]
    comicLibrary['state'].works.rows = [work]

    const comicContext = { ...context, library: comicLibrary, kind: 'comics' as const }
    const detailView = new DetailView(container, comicContext)
    await detailView.render({ unit: cUnit1, work })

    // 首次点击编辑并填写新标题
    container.querySelector<HTMLButtonElement>('#btn-comic-edit')!.click()
    const editDialog = document.querySelector<HTMLElement>('.modal-dialog')!
    const titleInput = editDialog.querySelector<HTMLInputElement>('input[type="text"]')!
    titleInput.value = '草稿新标题'

    // 模拟 publishWorks 发生冲突抛出异常
    vi.spyOn(comicLibrary, 'publishWorks').mockRejectedValueOnce(
      Object.assign(new Error('存储冲突'), { code: 'storage_conflict' })
    )

    // 提交保存，触发冲突
    editDialog.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'))
    await vi.waitFor(() => expect(context.reportError).toHaveBeenCalled())

    // 再次点击编辑按钮：草稿必须保留在表单输入框中，不能丢失！
    container.querySelector<HTMLButtonElement>('#btn-comic-edit')!.click()
    const retryDialog = document.querySelector<HTMLElement>('.modal-dialog')!
    const retryTitleInput = retryDialog.querySelector<HTMLInputElement>('input[type="text"]')!
    expect(retryTitleInput.value).toBe('草稿新标题')

    // 取消重试弹窗
    retryDialog.querySelector<HTMLButtonElement>('.btn-secondary')!.click()

    detailView.destroy()
    comicLibrary.destroy()
  })

  it('UI-06: 详情停留期间来源移除后，点击重读或目录时被安全拒绝且报告错误', async () => {
    await library.initialize()
    await library.refresh()

    const unit = library.snapshot.units[0]!
    const detailView = new DetailView(container, context)
    await detailView.render({ unit })

    // 模拟在详情页停留期间，来源被移除（access.file 校验抛出 outside_sources）
    vi.spyOn(library, 'openUnit').mockRejectedValueOnce(
      Object.assign(new Error('文件已不在当前来源范围内'), { code: 'outside_sources' })
    )

    // 点击加载目录
    const loadTocBtn = container.querySelector<HTMLButtonElement>('#btn-load-toc')!
    loadTocBtn.click()

    await vi.waitFor(() => {
      const errorMsg = container.querySelector<HTMLElement>('.toc-error')
      expect(errorMsg?.textContent).toContain('文件已不在当前来源范围内')
    })

    detailView.destroy()
  })
})
