import { expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive, FileEntry } from '../sdk/types'
import type { ReaderView } from './view'
import { file, memoryDrive } from './library/test-fixtures'

it('最近阅读包含取材目录本身的图片章节，但不混入同名前缀的外部目录', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir = file(1, '/漫画', true)
  const chapter = file(2, '/漫画/第一章', true)
  const page = file(21, '/漫画/第一章/01.jpg', false)
  const outside = file(3, '/漫画/第一章节外部', true)
  const outsidePage = file(31, '/漫画/第一章节外部/01.jpg', false)
  const mock = memoryDrive([rootDir, chapter, page, outside, outsidePage], {
    source_dir: chapter.path,
  })

  mock.seed(
    'progress:2',
    {
      file: chapter,
      title: chapter.name,
      location: { format: 'comic', index: 0 },
    },
    100
  )
  mock.seed(
    'progress:3',
    {
      file: outside,
      title: outside.name,
      location: { format: 'comic', index: 0 },
    },
    200
  )

  const mockView: ReaderView = {
    title: '第一章',
    sections: [{ label: '第一页' }],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'comic', index: 0 }),
    navigationState: () => ({
      sectionIndex: 0,
      sectionCount: 1,
      canPrevious: false,
      canNext: false,
    }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    destroy: vi.fn(),
  }

  const drive = Object.assign(mock.drive, {
    ready: Promise.resolve({
      id: 'comics',
      name: '漫画',
      version: '1.0.0',
      api_version: 2,
      dark: false,
    }),
    ui: {
      close: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
    },
    on: () => () => {},
  }) as unknown as Drive
  window.tgdrive = drive

  try {
    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })

    // 1. 可见首页路径：继续阅读卡展示第一章，排除同名前缀外部章节
    await vi.waitFor(() =>
      expect(document.getElementById('home-continue-card')?.textContent).toContain('第一章')
    )
    expect(document.getElementById('home-continue-card')?.textContent).not.toContain('外部章节')
    expect(document.querySelector('#home-continue-card .continue-title')?.textContent).toBe('第一章')
    expect(document.getElementById('btn-continue-reading')).not.toBeNull()

    // 2. 可见书库路径：书库卡片包含第一章，排除同名前缀外部章节
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    expect(document.querySelector('#items button')?.getAttribute('data-file-id')).toBe(
      String(chapter.id)
    )
    expect(document.getElementById('items')!.textContent).toContain('第一章')
    expect(document.getElementById('items')!.textContent).not.toContain('外部章节')
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('图书阅读设置中的字号与行距支持加减按钮精确调控与边界禁用', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir: FileEntry = {
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
  const bookFile: FileEntry = {
    id: 10,
    name: '示例文本.txt',
    path: '/书库/示例文本.txt',
    is_dir: false,
    size: 1024,
    content_version: 'v1',
    created_at: 1,
    modified_at: 1,
    favorite: false,
  }
  const configuredPrefs: any[] = []
  const mockView: ReaderView = {
    title: '示例文本',
    sections: [{ label: '第一节' }],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'txt', index: 0 }),
    navigationState: () => ({
      sectionIndex: 0,
      sectionCount: 1,
      canPrevious: false,
      canNext: false,
    }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async (prefs) => {
      configuredPrefs.push({ ...prefs })
    }),
    destroy: vi.fn(),
  }
  let savedStoragePref: any = null
  const drive = {
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
        key === 'preferences' && savedStoragePref
          ? { value: savedStoragePref, revision: 'r1' }
          : null,
      set: vi.fn(async (key: string, value: any) => {
        if (key === 'preferences') savedStoragePref = value
        return { key, value, revision: 'r1' }
      }),
      list: async () => ({ records: [], next_cursor: null }),
    },
    files: {
      list: async ({ path }: { path: string }) => ({ entries: [bookFile], path, next_cursor: null }),
      stat: async (p: { id?: number; path?: string }) =>
        p.id === bookFile.id || p.path === bookFile.path ? bookFile : rootDir,
    },
    ui: {
      close: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
    },
    on: () => () => {},
  } as unknown as Drive
  window.tgdrive = drive
  try {
    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    // 切换到书库并等待书籍卡片出现
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))

    // 打开图书详情并点击开始阅读，等待阅读就绪
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const fontSizeInput = document.getElementById('font-size') as HTMLInputElement
    const fontSizeDec = document.getElementById('font-size-decrease') as HTMLButtonElement
    const fontSizeInc = document.getElementById('font-size-increase') as HTMLButtonElement

    const lineHeightInput = document.getElementById('line-height') as HTMLInputElement
    const lineHeightDec = document.getElementById('line-height-decrease') as HTMLButtonElement
    const lineHeightInc = document.getElementById('line-height-increase') as HTMLButtonElement

    // 默认字号为 18，加减按钮正常可用
    expect(fontSizeInput.value).toBe('18')
    expect(fontSizeDec.disabled).toBe(false)
    expect(fontSizeInc.disabled).toBe(false)

    // 点击增大字号按钮
    fontSizeInc.click()
    await vi.waitFor(() => expect(fontSizeInput.value).toBe('19'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(19))

    // 点击减小字号按钮
    fontSizeDec.click()
    await vi.waitFor(() => expect(fontSizeInput.value).toBe('18'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(18))

    // 默认行距为 1.8，加减按钮正常可用
    expect(lineHeightInput.value).toBe('1.8')
    expect(lineHeightDec.disabled).toBe(false)
    expect(lineHeightInc.disabled).toBe(false)

    // 点击增大行距按钮
    lineHeightInc.click()
    await vi.waitFor(() => expect(lineHeightInput.value).toBe('1.9'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.9))

    // 点击减小行距按钮
    lineHeightDec.click()
    await vi.waitFor(() => expect(lineHeightInput.value).toBe('1.8'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.8))

    // 滑块输入事件同步加减按钮的禁用状态（测试最小值与最大值边界）
    fontSizeInput.value = '12'
    fontSizeInput.dispatchEvent(new Event('input'))
    expect(fontSizeDec.disabled).toBe(true)
    expect(fontSizeInc.disabled).toBe(false)
    fontSizeInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(12))
    fontSizeDec.click()
    expect(fontSizeInput.value).toBe('12')

    fontSizeInput.value = '36'
    fontSizeInput.dispatchEvent(new Event('input'))
    expect(fontSizeDec.disabled).toBe(false)
    expect(fontSizeInc.disabled).toBe(true)
    fontSizeInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(36))
    fontSizeInc.click()
    expect(fontSizeInput.value).toBe('36')

    lineHeightInput.value = '1.2'
    lineHeightInput.dispatchEvent(new Event('input'))
    expect(lineHeightDec.disabled).toBe(true)
    expect(lineHeightInc.disabled).toBe(false)
    lineHeightInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.2))
    lineHeightDec.click()
    expect(lineHeightInput.value).toBe('1.2')

    lineHeightInput.value = '2.8'
    lineHeightInput.dispatchEvent(new Event('input'))
    expect(lineHeightDec.disabled).toBe(false)
    expect(lineHeightInc.disabled).toBe(true)
    lineHeightInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(2.8))
    lineHeightInc.click()
    expect(lineHeightInput.value).toBe('2.8')
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('目录按钮通过 ReaderChrome 正确打开导航面板，支持关闭按钮与ESC并避免重复监听关闭', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir = file(1, '/书库', true)
  const bookFile = file(10, '/书库/示例文本.txt', false, 'v1', 1024)
  const mock = memoryDrive([rootDir, bookFile], { source_dir: '/书库' })

  const mockView: ReaderView = {
    title: '示例文本',
    sections: [{ label: '第一节' }, { label: '第二节' }],
    navigation: [
      { label: '第一节', depth: 0, location: { format: 'txt', index: 0 } },
      { label: '第二节', depth: 0, location: { format: 'txt', index: 1 } },
    ],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'txt', index: 0 }),
    navigationState: () => ({
      sectionIndex: 0,
      sectionCount: 2,
      canPrevious: false,
      canNext: true,
    }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    destroy: vi.fn(),
  }

  const drive = Object.assign(mock.drive, {
    ready: Promise.resolve({
      id: 'books',
      name: '图书',
      version: '1.0.0',
      api_version: 2,
      dark: false,
    }),
    ui: {
      close: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
    },
    on: () => () => {},
  }) as unknown as Drive
  window.tgdrive = drive

  try {
    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const navPanel = document.getElementById('navigation') as HTMLElement
    const tocToggleBtn = document.getElementById('toc-toggle') as HTMLButtonElement

    // 桌面与手机初始均为关闭状态
    expect(navPanel.hidden).toBe(true)

    // 1. 单次点击 toc-toggle 切换面板状态，避免因重复绑定立即被二次关闭
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    expect(navPanel.querySelectorAll('.toc-item-row')).toHaveLength(2)

    // 再次点击恢复面板初始状态
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(true)

    // 2. 再次打开并验证通过 [data-close-panel] 按钮关闭
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    const closeBtn = navPanel.querySelector<HTMLButtonElement>('[data-close-panel]')!
    expect(closeBtn).not.toBeNull()
    closeBtn.click()
    expect(navPanel.hidden).toBe(true)

    // 3. 打开后通过 ESC 键盘事件关闭面板
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(navPanel.hidden).toBe(true)
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('真实末端出现读完并下一卷按钮，点击后使用正确节点标识连读下一卷，不自动跳转', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir = file(1, '/漫画', true)
  const vol1 = file(101, '/漫画/星河 第1卷.cbz', false)
  const vol2 = file(102, '/漫画/星河 第2卷.cbz', false)
  const mock = memoryDrive([rootDir, vol1, vol2], { source_dir: '/漫画' })

  let atEnd = false
  let notifyChanged: (() => void) | undefined
  let currentTitle = '星河 第1卷'

  const mockView: ReaderView = {
    get title() {
      return currentTitle
    },
    sections: [{ label: '第1话' }],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'comic', index: 0 }),
    navigationState: () => ({
      sectionIndex: 0,
      sectionCount: 1,
      canPrevious: false,
      canNext: false,
      atEnd,
    }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    destroy: vi.fn(),
  }

  const drive = Object.assign(mock.drive, {
    ready: Promise.resolve({
      id: 'comics',
      name: '漫画',
      version: '1.0.0',
      api_version: 2,
      dark: false,
    }),
    ui: {
      close: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
    },
    on: () => () => {},
  }) as unknown as Drive
  window.tgdrive = drive

  try {
    await startApp({
      kind: 'comics',
      create: vi.fn(async (ctx) => {
        notifyChanged = ctx.changed
        currentTitle = ctx.file.name.replace(/\.[^.]+$/, '')
        return mockView
      }),
    })

    // 多卷作品点击仍进入详情，从「开始阅读」进入第 1 卷；单卷作品则直接开读。
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))
    expect(document.getElementById('book-title')?.textContent).toContain('星河 第1卷')

    // 未到末端时，读完区域与下一卷按钮均保持隐藏
    expect(document.getElementById('reader-completion')?.hidden).toBe(true)
    expect(document.getElementById('btn-next-volume')?.hidden).toBe(true)

    // 触达末端（atEnd === true）且触发视图状态变化通知
    atEnd = true
    notifyChanged?.()

    await vi.waitFor(() => expect(document.getElementById('reader-completion')?.hidden).toBe(false))
    const nextBtn = document.getElementById('btn-next-volume') as HTMLButtonElement
    expect(nextBtn.hidden).toBe(false)
    expect(nextBtn.textContent).toBe('读完并下一卷：星河 第2卷 →')

    // 验证显式点击前不会自动跳转，仍停留在第1卷
    expect(document.getElementById('book-title')?.textContent).toContain('星河 第1卷')

    // 显式点击下一卷按钮：记录第1卷已读状态并打开第2卷
    nextBtn.click()
    await vi.waitFor(() =>
      expect(document.getElementById('book-title')?.textContent).toContain('星河 第2卷')
    )
    const readingStateRecord = mock.records.get('library:reading:101')
    expect(readingStateRecord?.value).toMatchObject({ status: 'read' })
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('快捷跳转在有效提交后复位脏标记以同步翻页，未提交时保留输入草稿', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir = file(1, '/图书', true)
  const bookFile = file(10, '/图书/测试书.txt', false, 'v1', 1024)
  const mock = memoryDrive([rootDir, bookFile], { source_dir: '/图书' })

  let currentIndex = 0
  let notifyChanged: (() => void) | undefined
  const mockView: ReaderView = {
    title: '测试书',
    sections: [
      { label: '第一章', entry: '0' },
      { label: '第二章', entry: '1' },
      { label: '第三章', entry: '2' },
      { label: '第四章', entry: '3' },
      { label: '第五章', entry: '4' },
    ],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'txt', index: currentIndex }),
    navigationState: () => ({
      sectionIndex: currentIndex,
      sectionCount: 5,
      canPrevious: currentIndex > 0,
      canNext: currentIndex < 4,
    }),
    turn: vi.fn(async (delta) => {
      currentIndex = Math.max(0, Math.min(4, currentIndex + delta))
      notifyChanged?.()
    }),
    go: vi.fn(async (target) => {
      currentIndex = Math.max(0, Math.min(4, target))
      notifyChanged?.()
    }),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    destroy: vi.fn(),
  }

  const drive = Object.assign(mock.drive, {
    ready: Promise.resolve({
      id: 'books',
      name: '图书',
      version: '1.0.0',
      api_version: 2,
      dark: false,
    }),
    ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
    on: () => () => {},
  }) as unknown as Drive
  window.tgdrive = drive

  try {
    await startApp({
      kind: 'books',
      create: vi.fn(async (ctx) => {
        notifyChanged = ctx.changed
        return mockView
      }),
    })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const jumpInput = document.getElementById('jump') as HTMLInputElement
    const jumpBtn = document.getElementById('jump-button') as HTMLButtonElement
    const nextBtn = document.getElementById('next') as HTMLButtonElement
    const prevBtn = document.getElementById('previous') as HTMLButtonElement

    // 初始位置为 1
    expect(jumpInput.value).toBe('1')

    // 1. 用户输入未提交草稿：输入 "4" 但不点击跳转按钮
    jumpInput.value = '4'
    jumpInput.dispatchEvent(new Event('input', { bubbles: true }))

    // 翻到下一页（当前页变为 2）
    nextBtn.click()
    await vi.waitFor(() => expect(mockView.turn).toHaveBeenCalledTimes(1))

    // 未提交草稿不能被覆盖：输入框依然保留草稿 "4"
    expect(jumpInput.value).toBe('4')

    // 2. 有效手动跳转提交：在输入框输入 "3" 并点击“跳转”
    jumpInput.value = '3'
    jumpInput.dispatchEvent(new Event('input', { bubbles: true }))
    jumpBtn.click()
    await vi.waitFor(() => expect(mockView.go).toHaveBeenCalledWith(2))

    // 验证当前页已同步为 3
    expect(jumpInput.value).toBe('3')

    // 3. 跳转提交后恢复同步：点击下一页（到第 4 页），输入框跟随更新为 "4"
    nextBtn.click()
    await vi.waitFor(() => expect(mockView.turn).toHaveBeenCalledTimes(2))
    expect(jumpInput.value).toBe('4')

    // 点击上一页（到第 3 页），输入框跟随更新为 "3"
    prevBtn.click()
    await vi.waitFor(() => expect(mockView.turn).toHaveBeenCalledTimes(3))
    expect(jumpInput.value).toBe('3')
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('桌面端更多操作入口真实可见，支持下载与从头重读入口，并与目录面板互斥开闭', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const rootDir = file(1, '/图书', true)
  const bookFile = file(10, '/图书/长篇.txt', false, 'v1', 2048)
  const mock = memoryDrive([rootDir, bookFile], { source_dir: '/图书' })

  const mockView: ReaderView = {
    title: '长篇',
    sections: [
      { label: '第一章', entry: '0' },
      { label: '第二章', entry: '1' },
    ],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'txt', index: 0 }),
    navigationState: () => ({
      sectionIndex: 0,
      sectionCount: 2,
      canPrevious: false,
      canNext: true,
    }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    destroy: vi.fn(),
  }

  const downloadSpy = vi.fn(async () => {})
  const drive = Object.assign(mock.drive, {
    ready: Promise.resolve({
      id: 'books',
      name: '图书',
      version: '1.0.0',
      api_version: 2,
      dark: false,
    }),
    ui: {
      close: vi.fn(async () => {}),
      download: downloadSpy,
    },
    on: () => () => {},
  }) as unknown as Drive
  window.tgdrive = drive

  try {
    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const moreToggle = document.getElementById('reader-more-toggle') as HTMLButtonElement
    const morePanel = document.getElementById('reader-more') as HTMLElement
    const navPanel = document.getElementById('navigation') as HTMLElement
    const tocToggle = document.getElementById('toc-toggle') as HTMLButtonElement

    // 1. 桌面端入口真实可见，不带有 mobile-only 类
    expect(moreToggle).not.toBeNull()
    expect(moreToggle.classList.contains('mobile-only')).toBe(false)
    expect(morePanel.hidden).toBe(true)

    // 2. 点击更多按钮展开面板
    moreToggle.click()
    expect(morePanel.hidden).toBe(false)

    // 3. 点击下载按钮：调用 drive.ui.download 并传入正确当前文件路径
    const downloadBtn = document.getElementById('download') as HTMLButtonElement
    downloadBtn.click()
    expect(downloadSpy).toHaveBeenCalledWith('/图书/长篇.txt')

    // 4. 从头重读按钮：点击后弹出确认弹窗入口
    const restartBtn = document.getElementById('btn-reader-restart') as HTMLButtonElement
    restartBtn.click()
    await vi.waitFor(() => {
      const modal = document.querySelector('.modal-dialog')
      expect(modal).not.toBeNull()
      expect(modal?.textContent).toContain('从头重读')
    })
    // 取消弹窗
    const cancelModalBtn = document.querySelector<HTMLButtonElement>(
      '.modal-actions .btn-secondary'
    )
    cancelModalBtn?.click()

    // 5. 与目录面板互斥开闭：当前更多面板处于打开状态，点击目录按钮
    expect(morePanel.hidden).toBe(false)
    expect(navPanel.hidden).toBe(true)
    tocToggle.click()
    // 目录打开，更多面板关闭
    expect(navPanel.hidden).toBe(false)
    expect(morePanel.hidden).toBe(true)

    // 再次点击更多按钮：目录面板关闭，更多面板打开
    moreToggle.click()
    expect(morePanel.hidden).toBe(false)
    expect(navPanel.hidden).toBe(true)

    // 6. ESC 关闭更多面板，焦点恢复至更多按钮
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(morePanel.hidden).toBe(true)
    expect(document.activeElement).toBe(moreToggle)
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})
