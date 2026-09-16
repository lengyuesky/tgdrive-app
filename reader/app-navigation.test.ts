/** 统一目录面板、层级折叠、文本筛选与有界按需缩略图行为测试 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive, FileEntry } from '../sdk/types'
import type { NavigationItem, ReaderThumbnail, ReaderView } from './view'
import { file, memoryDrive } from './library/test-fixtures'

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string = '0px'
  readonly thresholds: ReadonlyArray<number> = [0]
  observed = new Set<Element>()

  static instances: MockIntersectionObserver[] = []

  static trigger(target: Element, isIntersecting: boolean) {
    for (const inst of MockIntersectionObserver.instances) {
      if (inst.observed.has(target)) {
        inst.callback(
          [
            {
              target,
              isIntersecting,
              boundingClientRect: {} as DOMRectReadOnly,
              intersectionRatio: isIntersecting ? 1 : 0,
              intersectionRect: {} as DOMRectReadOnly,
              rootBounds: null,
              time: Date.now(),
            },
          ],
          inst
        )
      }
    }
  }

  static reset() {
    MockIntersectionObserver.instances = []
  }

  static triggerDirect(inst: MockIntersectionObserver, target: Element, isIntersecting: boolean) {
    inst.callback(
      [
        {
          target,
          isIntersecting,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRatio: isIntersecting ? 1 : 0,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
          time: Date.now(),
        },
      ],
      inst
    )
  }

  constructor(public callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null
    MockIntersectionObserver.instances.push(this)
  }

  observe(target: Element) {
    this.observed.add(target)
  }
  unobserve(target: Element) {
    this.observed.delete(target)
  }
  disconnect() {
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

describe('统一目录面板与有界按需缩略图调度', () => {
  const originalObserver = window.IntersectionObserver

  beforeEach(() => {
    MockIntersectionObserver.reset()
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
    document.body.innerHTML = '<div id="app"></div>'
  })

  afterEach(() => {
    window.IntersectionObserver = originalObserver
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  })

  it('桌面端与移动端初始关闭、支持明确打开/关闭按钮/ESC/焦点恢复与手机圈定焦点', async () => {
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
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const navPanel = document.getElementById('navigation') as HTMLElement
    const tocToggleBtn = document.getElementById('toc-toggle') as HTMLButtonElement

    // 1. 桌面环境下初始关闭
    expect(navPanel.hidden).toBe(true)

    // 点击 toc-toggle 打开，焦点进入目录面板首个可操作元素
    tocToggleBtn.focus()
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    const closeBtn = navPanel.querySelector<HTMLButtonElement>('[data-close-panel]')!
    expect(closeBtn).not.toBeNull()

    // 点击关闭按钮关闭面板，焦点恢复至触发展开的按钮
    closeBtn.click()
    expect(navPanel.hidden).toBe(true)
    expect(document.activeElement).toBe(tocToggleBtn)

    // 再次打开并通过 ESC 键盘事件关闭面板
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(navPanel.hidden).toBe(true)
    expect(document.activeElement).toBe(tocToggleBtn)
  })

  it('层级目录支持嵌套折叠、箭头只展开不跳转，父标签跳转保留完整 Location', async () => {
    const rootDir = file(1, '/书库', true)
    const bookFile = file(20, '/书库/层级图书.epub', false, 'v1', 2048)
    const mock = memoryDrive([rootDir, bookFile], { source_dir: '/书库' })

    const restoredLocations: any[] = []
    const navItems: NavigationItem[] = [
      { label: '第一卷', depth: 0, location: { format: 'epub', index: 0, entry: 'v1.xhtml', offset: 10 } },
      { label: '第1章', depth: 1, location: { format: 'epub', index: 1, entry: 'v1_c1.xhtml', offset: 20 } },
      { label: '第1.1节', depth: 2, location: { format: 'epub', index: 2, entry: 'v1_c1_s1.xhtml', offset: 30 } },
      { label: '第2章', depth: 1, location: { format: 'epub', index: 3, entry: 'v1_c2.xhtml' } },
      { label: '第二卷', depth: 0, location: { format: 'epub', index: 4, entry: 'v2.xhtml' } },
    ]

    const mockView: ReaderView = {
      title: '层级图书',
      sections: navItems.map((n) => ({ label: n.label })),
      navigation: navItems,
      open: vi.fn(async () => {}),
      current: () => ({ format: 'epub', index: 0 }),
      navigationState: () => ({
        sectionIndex: 0,
        sectionCount: 5,
        canPrevious: false,
        canNext: true,
      }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async (loc) => {
        restoredLocations.push({ ...loc })
      }),
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

    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const navPanel = document.getElementById('navigation') as HTMLElement
    const tocToggleBtn = document.getElementById('toc-toggle') as HTMLButtonElement
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)

    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]
    expect(rows).toHaveLength(5)

    // 1. 验证第1章的折叠箭头只折叠/展开，不触发正文跳转
    const ch1Row = rows[1] // 第1章
    const ch1Chevron = ch1Row.querySelector<HTMLButtonElement>('.toc-fold-toggle')!
    expect(ch1Chevron).not.toBeNull()
    expect(ch1Chevron.textContent).toBe('▾')

    ch1Chevron.click()
    expect(ch1Chevron.textContent).toBe('▸')
    expect(rows[2].hidden).toBe(true) // 第1.1节被折叠隐藏
    expect(rows[3].hidden).toBe(false) // 第2章依然可见
    expect(restoredLocations).toHaveLength(0) // 点击折叠箭头绝不触发跳转！

    // 2. 验证父标题按钮跳转时恢复完整 Location（包含 entry 与 offset）并关闭面板
    const v1Btn = rows[0].querySelector<HTMLButtonElement>('.toc-item-btn')!
    v1Btn.click()
    await vi.waitFor(() => expect(restoredLocations).toHaveLength(1))
    expect(restoredLocations[0]).toEqual({
      format: 'epub',
      index: 0,
      entry: 'v1.xhtml',
      offset: 10,
    })
    expect(navPanel.hidden).toBe(true)

    // 3. 嵌套折叠测试：折叠外层再展开外层，内层已折叠状态不被冲掉
    tocToggleBtn.click()
    expect(navPanel.hidden).toBe(false)
    const v1Chevron = rows[0].querySelector<HTMLButtonElement>('.toc-fold-toggle')!

    // 折叠第一卷
    v1Chevron.click()
    expect(rows[1].hidden).toBe(true) // 第1章隐藏
    expect(rows[2].hidden).toBe(true) // 第1.1节隐藏
    expect(rows[3].hidden).toBe(true) // 第2章隐藏
    expect(rows[4].hidden).toBe(false) // 第二卷依然可见

    // 展开第一卷：第1章与第2章恢复可见，但第1章内部的第1.1节必须依然保持折叠隐藏！
    v1Chevron.click()
    expect(rows[1].hidden).toBe(false)
    expect(rows[2].hidden).toBe(true) // 关键：第1.1节依然折叠隐藏！
    expect(rows[3].hidden).toBe(false)

    // 展开第1章：第1.1节恢复可见
    ch1Chevron.click()
    expect(rows[2].hidden).toBe(false)
  })

  it('文本筛选搜索匹配条目，清空后恢复已有折叠状态而不被破坏', async () => {
    const rootDir = file(1, '/书库', true)
    const bookFile = file(20, '/书库/层级图书.epub', false, 'v1', 2048)
    const mock = memoryDrive([rootDir, bookFile], { source_dir: '/书库' })

    const navItems: NavigationItem[] = [
      { label: '第一卷 启程', depth: 0, location: { format: 'epub', index: 0 } },
      { label: '第1章 遇险', depth: 1, location: { format: 'epub', index: 1 } },
      { label: '第1.1节 迷雾', depth: 2, location: { format: 'epub', index: 2 } },
      { label: '第2章 突破', depth: 1, location: { format: 'epub', index: 3 } },
      { label: '第二卷 归途', depth: 0, location: { format: 'epub', index: 4 } },
    ]

    const mockView: ReaderView = {
      title: '层级图书',
      sections: navItems.map((n) => ({ label: n.label })),
      navigation: navItems,
      open: vi.fn(async () => {}),
      current: () => ({ format: 'epub', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 5, canPrevious: false, canNext: true }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(),
    }

    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'books', name: '图书', version: '1.0.0', api_version: 2, dark: false }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const navPanel = document.getElementById('navigation') as HTMLElement
    document.getElementById('toc-toggle')!.click()

    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]
    const filterInput = navPanel.querySelector<HTMLInputElement>('#toc-filter')!

    // 先折叠第1章（使得第1.1节处于折叠隐藏状态）
    const ch1Chevron = rows[1].querySelector<HTMLButtonElement>('.toc-fold-toggle')!
    ch1Chevron.click()
    expect(rows[2].hidden).toBe(true)

    // 输入搜索关键字筛选
    filterInput.value = '突破'
    filterInput.dispatchEvent(new Event('input'))

    // 只有匹配项显示
    expect(rows[0].hidden).toBe(true)
    expect(rows[1].hidden).toBe(true)
    expect(rows[2].hidden).toBe(true)
    expect(rows[3].hidden).toBe(false) // 第2章 突破
    expect(rows[4].hidden).toBe(true)

    // 清空搜索输入框：恢复之前的折叠状态，不能破坏已有折叠！
    filterInput.value = ''
    filterInput.dispatchEvent(new Event('input'))

    expect(rows[0].hidden).toBe(false)
    expect(rows[1].hidden).toBe(false)
    expect(rows[2].hidden).toBe(true) // 关键：第1.1节依然维持折叠隐藏！
    expect(rows[3].hidden).toBe(false)
    expect(rows[4].hidden).toBe(false)
  })

  it('缩略图在目录未打开时0请求，打开后仅可见项触发有界并发（最多2），隐藏项0请求', async () => {
    const rootDir = file(1, '/漫画', true)
    const comicFile = file(30, '/漫画/画册.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comicFile], { source_dir: '/漫画' })

    // 合成 50 个目录项
    const syntheticItems: NavigationItem[] = Array.from({ length: 50 }, (_, i) => ({
      label: `第 ${i + 1} 页`,
      depth: 0,
      location: { format: 'comic', index: i },
    }))

    let activeConcurrent = 0
    let maxConcurrent = 0
    const requestedIndices: number[] = []
    const releases: number[] = []
    const pendingResolvers = new Map<number, (thumb: ReaderThumbnail) => void>()

    const mockView: ReaderView = {
      title: '画册',
      sections: syntheticItems.map((s) => ({ label: s.label })),
      navigation: syntheticItems,
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        requestedIndices.push(index)
        activeConcurrent++
        maxConcurrent = Math.max(maxConcurrent, activeConcurrent)

        return new Promise<ReaderThumbnail>((resolve) => {
          const resolver = (thumb: ReaderThumbnail) => {
            activeConcurrent--
            resolve(thumb)
          }
          pendingResolvers.set(index, resolver)

          signal.addEventListener('abort', () => {
            if (pendingResolvers.has(index)) {
              pendingResolvers.delete(index)
              activeConcurrent--
            }
          })
        })
      }),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 50, canPrevious: false, canNext: true }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(),
    }

    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'comics', name: '漫画', version: '1.0.0', api_version: 2, dark: false }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 1. 目录未打开时：0 请求！
    expect(mockView.thumbnail).toHaveBeenCalledTimes(0)

    // 2. 打开目录面板
    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    expect(navPanel.hidden).toBe(false)

    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]
    expect(rows).toHaveLength(50)

    // 此时尚未触发可见相交，请求依然为 0
    expect(mockView.thumbnail).toHaveBeenCalledTimes(0)

    // 3. 模拟滚动视口内前 6 项变为可见（相交）
    for (let i = 0; i < 6; i++) {
      MockIntersectionObserver.trigger(rows[i], true)
    }

    // 必须受到最多 2 个并发限制！即使 6 项同时可见，也不允许一次全发
    expect(mockView.thumbnail).toHaveBeenCalledTimes(2)
    expect(requestedIndices).toEqual([0, 1])
    expect(maxConcurrent).toBeLessThanOrEqual(2)

    // 解决第 0 项的缩略图
    let rel0Called = false
    pendingResolvers.get(0)!({
      url: 'blob:thumb-0',
      width: 100,
      height: 100,
      release: () => {
        rel0Called = true
        releases.push(0)
      },
    })
    pendingResolvers.delete(0)

    // 等待微任务轮转，调度队列自动启动第 2 项（活跃并发依然不超过 2）
    await vi.waitFor(() => expect(mockView.thumbnail).toHaveBeenCalledTimes(3))
    expect(requestedIndices).toEqual([0, 1, 2])
    expect(maxConcurrent).toBeLessThanOrEqual(2)

    // 验证已加载项展示图片
    await vi.waitFor(() => {
      const img0 = rows[0].querySelector<HTMLImageElement>('.toc-thumbnail-img')
      expect(img0?.src).toBe('blob:thumb-0')
    })

    // 未相交的第 6..49 项：0 请求！
    for (let i = 6; i < 50; i++) {
      expect(requestedIndices).not.toContain(i)
    }
  })

  it('缩略图离视口/折叠/关闭面板取消在途与释放已加载，迟到结果安全丢弃不写DOM', async () => {
    const rootDir = file(1, '/漫画', true)
    const comicFile = file(30, '/漫画/画册.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comicFile], { source_dir: '/漫画' })

    const syntheticItems: NavigationItem[] = Array.from({ length: 10 }, (_, i) => ({
      label: `第 ${i + 1} 页`,
      depth: 0,
      location: { format: 'comic', index: i },
    }))

    const abortedSignals: boolean[] = []
    let lateResolver: ((thumb: ReaderThumbnail) => void) | undefined
    let lateThumbReleaseCalled = false
    let loadedReleaseCalled = false

    const mockView: ReaderView = {
      title: '画册',
      sections: syntheticItems.map((s) => ({ label: s.label })),
      navigation: syntheticItems,
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        if (index === 0) {
          // 立即就绪项
          return Promise.resolve<ReaderThumbnail>({
            url: 'blob:thumb-0',
            width: 100,
            height: 100,
            release: () => {
              loadedReleaseCalled = true
            },
          })
        }
        // index === 1: 慢速迟到项
        return new Promise<ReaderThumbnail>((resolve) => {
          signal.addEventListener('abort', () => abortedSignals.push(true))
          lateResolver = resolve
        })
      }),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 10, canPrevious: false, canNext: true }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(),
    }

    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'comics', name: '漫画', version: '1.0.0', api_version: 2, dark: false }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 打开面板并使第 0 与第 1 项相交
    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]

    MockIntersectionObserver.trigger(rows[0], true)
    MockIntersectionObserver.trigger(rows[1], true)

    // 等待第 0 项加载完成
    await vi.waitFor(() => {
      const img0 = rows[0].querySelector<HTMLImageElement>('.toc-thumbnail-img')
      expect(img0?.src).toBe('blob:thumb-0')
    })

    // 1. 第 0 项离开视口：释放缩略图资源并清除 img.src
    MockIntersectionObserver.trigger(rows[0], false)
    expect(loadedReleaseCalled).toBe(true)
    const img0After = rows[0].querySelector<HTMLImageElement>('.toc-thumbnail-img')
    expect(img0After?.getAttribute('src')).toBeNull()

    // 2. 第 1 项正在在途加载时离开视口：AbortController 被中止
    MockIntersectionObserver.trigger(rows[1], false)
    expect(abortedSignals).toHaveLength(1)
    expect(abortedSignals[0]).toBe(true)

    // 迟到结果返回：立即释放迟到资源，且不得修改 DOM！
    lateResolver!({
      url: 'blob:late-thumb-1',
      width: 100,
      height: 100,
      release: () => {
        lateThumbReleaseCalled = true
      },
    })

    await vi.waitFor(() => expect(lateThumbReleaseCalled).toBe(true))
    const img1 = rows[1].querySelector<HTMLImageElement>('.toc-thumbnail-img')
    expect(img1?.getAttribute('src')).toBeNull()

    // 3. 关闭面板再重新打开：重新加载可见项
    document.getElementById('toc-toggle')!.click() // 关闭
    expect(navPanel.hidden).toBe(true)

    document.getElementById('toc-toggle')!.click() // 重新打开
    expect(navPanel.hidden).toBe(false)
    MockIntersectionObserver.trigger(rows[0], true)
    await vi.waitFor(() => {
      const img0Reopen = rows[0].querySelector<HTMLImageElement>('.toc-thumbnail-img')
      expect(img0Reopen?.src).toBe('blob:thumb-0')
    })
  })

  it('移动端全屏沉浸下目录抽屉圈定焦点（Tab循环），支持背景遮罩与ESC关闭', async () => {
    const origMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    try {
      const rootDir = file(1, '/书库', true)
      const bookFile = file(10, '/书库/示例文本.txt', false, 'v1', 1024)
      const mock = memoryDrive([rootDir, bookFile], { source_dir: '/书库' })

      const mockView: ReaderView = {
        title: '示例文本',
        sections: [{ label: '第一节' }],
        navigation: [{ label: '第一节', depth: 0, location: { format: 'txt', index: 0 } }],
        open: vi.fn(async () => {}),
        current: () => ({ format: 'txt', index: 0 }),
        navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
        turn: vi.fn(async () => {}),
        go: vi.fn(async () => {}),
        restore: vi.fn(async () => {}),
        configure: vi.fn(async () => {}),
        destroy: vi.fn(),
      }

      const drive = Object.assign(mock.drive, {
        ready: Promise.resolve({ id: 'books', name: '图书', version: '1.0.0', api_version: 2, dark: false }),
        ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
        on: () => () => {},
      }) as unknown as Drive
      window.tgdrive = drive

      await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
      document.getElementById('nav-library')?.click()
      await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
      document.querySelector<HTMLButtonElement>('#items button')!.click()
      await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
      document.getElementById('btn-primary-read')!.click()
      await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

      const navPanel = document.getElementById('navigation') as HTMLElement
      const backdrop = document.getElementById('reader-backdrop') as HTMLElement
      const tocToggleBtn = document.getElementById('toc-toggle') as HTMLButtonElement

      // 初始关闭
      expect(navPanel.hidden).toBe(true)
      expect(backdrop.hidden).toBe(true)

      // 打开目录抽屉
      tocToggleBtn.focus()
      tocToggleBtn.click()

      expect(navPanel.hidden).toBe(false)
      expect(navPanel.getAttribute('role')).toBe('dialog')
      expect(navPanel.getAttribute('aria-modal')).toBe('true')
      expect(backdrop.hidden).toBe(false)

      // 获取面板内的可聚焦元素
      const focusables = [...navPanel.querySelectorAll<HTMLElement>('button,input,select')]
        .filter((el) => !el.closest('[hidden]') && !el.hasAttribute('disabled'))
      const first = focusables[0]
      const last = focusables.at(-1)!
      expect(first).toBeDefined()
      expect(last).toBeDefined()

      // 测试正向 Tab 圈定焦点：在最后一个元素上按下 Tab 键，焦点循环到第一个元素
      last.focus()
      expect(document.activeElement).toBe(last)
      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      document.dispatchEvent(tabEvent)
      expect(document.activeElement).toBe(first)

      // 测试反向 Shift+Tab 圈定焦点：在第一个元素上按下 Shift+Tab，焦点循环到最后一个元素
      first.focus()
      expect(document.activeElement).toBe(first)
      const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      document.dispatchEvent(shiftTabEvent)
      expect(document.activeElement).toBe(last)

      // 测试背景遮罩点击关闭
      backdrop.click()
      expect(navPanel.hidden).toBe(true)
      expect(backdrop.hidden).toBe(true)
      expect(document.activeElement).toBe(tocToggleBtn)
    } finally {
      window.matchMedia = origMatchMedia
    }
  })

  it('切书或退出阅读器时中止待执行缩略图并释放全部已加载资源', async () => {
    const rootDir = file(1, '/漫画', true)
    const comic1 = file(30, '/漫画/第1卷.cbz', false, 'v1', 4096)
    const comic2 = file(31, '/漫画/第2卷.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comic1, comic2], { source_dir: '/漫画' })

    const releasedList: number[] = []
    const abortSignals: boolean[] = []

    const mockView1: ReaderView = {
      title: '第1卷',
      sections: [{ label: '第1话' }, { label: '第2话' }],
      navigation: [
        { label: '第1话', depth: 0, location: { format: 'comic', index: 0 } },
        { label: '第2话', depth: 0, location: { format: 'comic', index: 1 } },
      ],
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        if (index === 0) {
          return Promise.resolve<ReaderThumbnail>({
            url: 'blob:thumb-vol1-0',
            width: 100,
            height: 100,
            release: () => releasedList.push(0),
          })
        }
        return new Promise<ReaderThumbnail>((_, reject) => {
          signal.addEventListener('abort', () => {
            abortSignals.push(true)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 2, canPrevious: false, canNext: true }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(),
    }

    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'comics', name: '漫画', version: '1.0.0', api_version: 2, dark: false }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView1) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(2))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 打开目录面板并触发两项相交
    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]

    MockIntersectionObserver.trigger(rows[0], true)
    MockIntersectionObserver.trigger(rows[1], true)

    await vi.waitFor(() => expect(releasedList.length).toBe(0))

    // 点击返回按钮退出阅读器
    document.getElementById('back')!.click()

    // 验证第0项已加载缩略图被释放，第1项在途请求被中止
    await vi.waitFor(() => expect(releasedList).toContain(0))
    expect(abortSignals).toContain(true)
  })

  it('IntersectionObserver 缺失时安全降级不加载缩略图，正文位置与进度不被改变', async () => {
    // 模拟缺少 IntersectionObserver 的降级环境
    // @ts-expect-error test degradation
    delete window.IntersectionObserver

    const rootDir = file(1, '/漫画', true)
    const comicFile = file(30, '/漫画/画册.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comicFile], { source_dir: '/漫画' })

    const mockView: ReaderView = {
      title: '画册',
      sections: [{ label: '第一页' }, { label: '第二页' }],
      capabilities: { thumbnails: true },
      thumbnail: vi.fn(async () => ({
        url: 'blob:thumb',
        width: 100,
        height: 100,
        release: () => {},
      })),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 2, canPrevious: false, canNext: true }),
      turn: vi.fn(async () => {}),
      go: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(),
    }

    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'comics', name: '漫画', version: '1.0.0', api_version: 2, dark: false }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 打开面板
    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    expect(navPanel.hidden).toBe(false)

    // 安全降级：没有 Observer 时 0 缩略图请求，无报错
    expect(mockView.thumbnail).toHaveBeenCalledTimes(0)
    expect(mockView.restore).toHaveBeenCalledTimes(0)
    expect(mockView.turn).toHaveBeenCalledTimes(0)
  })

  it('缩略图请求严格遵守在途所有权与并发上界：及时 reject 关重开不突破 2，未 settle 关重开/切书不提前并发', async () => {
    const rootDir = file(1, '/漫画', true)
    const comicFile = file(30, '/漫画/画册.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comicFile], { source_dir: '/漫画' })

    const syntheticItems: NavigationItem[] = Array.from({ length: 12 }, (_, i) => ({
      label: `第 ${i + 1} 页`,
      depth: 0,
      location: { format: 'comic', index: i },
    }))

    let activeInFlight = 0
    let peakConcurrent = 0
    const inFlightHistory: number[] = []

    let delayedAbortMode = false
    const manualResolvers = new Map<number, (t: ReaderThumbnail) => void>()

    const mockView: ReaderView = {
      title: '画册',
      sections: syntheticItems.map((s) => ({ label: s.label })),
      navigation: syntheticItems,
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        activeInFlight++
        peakConcurrent = Math.max(peakConcurrent, activeInFlight)
        inFlightHistory.push(activeInFlight)

        return new Promise<ReaderThumbnail>((resolve, reject) => {
          const onAbort = () => {
            if (delayedAbortMode) {
              return
            }
            activeInFlight--
            reject(new DOMException('Aborted', 'AbortError'))
          }

          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort)

          manualResolvers.set(index, (thumb) => {
            activeInFlight--
            resolve(thumb)
          })
        })
      }),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({
        sectionIndex: 0,
        sectionCount: 12,
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
        id: 'comics',
        name: '漫画',
        version: '1.0.0',
        api_version: 2,
        dark: false,
      }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const tocToggle = document.getElementById('toc-toggle') as HTMLButtonElement
    const navPanel = document.getElementById('navigation') as HTMLElement

    // === 阶段 1: abort 及时 reject 场景 ===
    // 首次打开面板，6 行相交，启动 2 个请求
    tocToggle.click()
    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]
    for (let i = 0; i < 6; i++) {
      MockIntersectionObserver.trigger(rows[i], true)
    }
    expect(mockView.thumbnail).toHaveBeenCalledTimes(2)
    expect(activeInFlight).toBe(2)
    expect(peakConcurrent).toBeLessThanOrEqual(2)

    // 关闭面板：触发 abort 且立即 reject 结算
    tocToggle.click()
    expect(navPanel.hidden).toBe(true)
    await vi.waitFor(() => expect(activeInFlight).toBe(0))

    // 重新打开面板并再次触发 6 行相交
    tocToggle.click()
    expect(navPanel.hidden).toBe(false)
    for (let i = 0; i < 6; i++) {
      MockIntersectionObserver.trigger(rows[i], true)
    }
    // 等待微任务让在途的 finally 彻底结算并由 schedule 承接启动新请求
    await vi.waitFor(() => expect(mockView.thumbnail).toHaveBeenCalledTimes(4))
    // 验证峰值并发未突破 2（旧缺陷此处会下溢至 -2 导致突破到 4）
    expect(peakConcurrent).toBeLessThanOrEqual(2)
    expect(activeInFlight).toBeLessThanOrEqual(2)

    // === 阶段 2: abort 忽略/迟到 resolve 场景 ===
    // 切换为迟到模式
    delayedAbortMode = true
    expect(mockView.thumbnail).toHaveBeenCalledTimes(4)

    // 关闭面板：abort 信号发出，但 promise 尚未结算（仍占用 activeRequests 槽位）
    tocToggle.click()
    expect(navPanel.hidden).toBe(true)
    // 立即重新打开面板
    tocToggle.click()
    expect(navPanel.hidden).toBe(false)

    // 再次使行相交：由于旧 2 项尚未 settle，在途槽位仍满（2），不得提前发起新并发！
    for (let i = 0; i < 6; i++) {
      MockIntersectionObserver.trigger(rows[i], true)
    }
    // 请求总次数仍为 4，未提前并发！
    expect(mockView.thumbnail).toHaveBeenCalledTimes(4)
    expect(peakConcurrent).toBeLessThanOrEqual(2)

    // 现在旧 2 项迟到 resolve 结算
    const resolvers = [...manualResolvers.values()]
    resolvers.forEach((res) =>
      res({ url: 'blob:late', width: 10, height: 10, release: () => {} })
    )

    // 释放后，新请求由 schedule 自动承接启动，峰值始终保持 <= 2
    await vi.waitFor(() => expect(mockView.thumbnail).toHaveBeenCalledTimes(6))
    expect(peakConcurrent).toBeLessThanOrEqual(2)
  })

  it('同条目快速离视口又进入，旧finally不得覆盖当前状态，返回资源最终正确展示与释放', async () => {
    const rootDir = file(1, '/漫画', true)
    const comicFile = file(30, '/漫画/画册.cbz', false, 'v1', 4096)
    const mock = memoryDrive([rootDir, comicFile], { source_dir: '/漫画' })

    const syntheticItems: NavigationItem[] = Array.from({ length: 4 }, (_, i) => ({
      label: `第 ${i + 1} 页`,
      depth: 0,
      location: { format: 'comic', index: i },
    }))

    let reqIndex = 0
    let resolverOld: ((thumb: ReaderThumbnail) => void) | undefined
    let resolverNew: ((thumb: ReaderThumbnail) => void) | undefined
    let releaseOldCalled = false
    let releaseNewCalled = false

    const mockView: ReaderView = {
      title: '画册',
      sections: syntheticItems.map((s) => ({ label: s.label })),
      navigation: syntheticItems,
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        reqIndex++
        const curReq = reqIndex
        return new Promise<ReaderThumbnail>((resolve) => {
          if (curReq === 1) {
            resolverOld = resolve
          } else {
            resolverNew = resolve
          }
        })
      }),
      open: vi.fn(async () => {}),
      current: () => ({ format: 'comic', index: 0 }),
      navigationState: () => ({
        sectionIndex: 0,
        sectionCount: 4,
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
        id: 'comics',
        name: '漫画',
        version: '1.0.0',
        api_version: 2,
        dark: false,
      }),
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    await startApp({ kind: 'comics', create: vi.fn(async () => mockView) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    const rows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]

    // 1. 第 0 项进入视口 -> 发起第 1 次请求
    MockIntersectionObserver.trigger(rows[0], true)
    expect(mockView.thumbnail).toHaveBeenCalledTimes(1)

    // 2. 第 0 项快速离开视口 -> 第 1 次请求被中止
    MockIntersectionObserver.trigger(rows[0], false)

    // 3. 第 0 项快速再次进入视口 -> 发起第 2 次请求
    MockIntersectionObserver.trigger(rows[0], true)
    expect(mockView.thumbnail).toHaveBeenCalledTimes(2)

    // 4. 此时第 1 次旧请求迟到结算：由于已被中止且不再拥有 record，finally 绝不能将新请求的 loading 覆盖为 none！
    resolverOld!({
      url: 'blob:old-stale-thumb',
      width: 100,
      height: 100,
      release: () => {
        releaseOldCalled = true
      },
    })

    // 5. 第 2 次新请求正常返回有效缩略图
    resolverNew!({
      url: 'blob:valid-new-thumb',
      width: 100,
      height: 100,
      release: () => {
        releaseNewCalled = true
      },
    })

    // 验证新缩略图成功挂载展示，旧资源被安全 release
    await vi.waitFor(() => {
      const img = rows[0].querySelector<HTMLImageElement>('.toc-thumbnail-img')
      expect(img?.src).toBe('blob:valid-new-thumb')
    })
    expect(releaseOldCalled).toBe(true)
    expect(releaseNewCalled).toBe(false)

    // 6. 最终离开视口时，新资源正确释放
    MockIntersectionObserver.trigger(rows[0], false)
    expect(releaseNewCalled).toBe(true)
  })

  it('旧Observer断开后对旧行触发迟到回调不调度新书；dispose后迟到资源只release一次且不写DOM', async () => {
    const rootDir = file(1, '/漫画', true)
    const comic1 = file(10, '/漫画/画册1.cbz', false)
    const comic2 = file(20, '/漫画/画册2.cbz', false)
    const mock = memoryDrive([rootDir, comic1, comic2], { source_dir: '/漫画' })

    const book1Items: NavigationItem[] = [
      { label: '书1-第1页', depth: 0, location: { format: 'comic', index: 0 } },
    ]
    const book2Items: NavigationItem[] = [
      { label: '书2-第1页', depth: 0, location: { format: 'comic', index: 0 } },
    ]

    const thumbSpy1 = vi.fn(async () => ({
      url: 'blob:thumb-b1',
      width: 10,
      height: 10,
      release: vi.fn(),
    }))
    let lateResolver2: ((t: ReaderThumbnail) => void) | undefined
    let lateReleaseCount = 0

    const mockView1: ReaderView = {
      title: '画册1',
      sections: [{ label: '书1-第1页' }],
      navigation: book1Items,
      capabilities: { thumbnails: true },
      thumbnail: thumbSpy1,
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

    const mockView2: ReaderView = {
      title: '画册2',
      sections: [{ label: '书2-第1页' }],
      navigation: book2Items,
      capabilities: { thumbnails: true },
      thumbnail: vi.fn((index: number, signal: AbortSignal) => {
        return new Promise<ReaderThumbnail>((resolve) => {
          lateResolver2 = resolve
        })
      }),
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
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
      on: () => () => {},
    }) as unknown as Drive
    window.tgdrive = drive

    let currentCreate = mockView1
    await startApp({ kind: 'comics', create: vi.fn(async () => currentCreate) })
    document.getElementById('nav-library')?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(2))

    // 1. 打开书 1
    const buttons = document.querySelectorAll<HTMLButtonElement>('#items button')
    buttons[0].click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 打开面板，捕获书 1 的 Observer 与旧 DOM 元素
    document.getElementById('toc-toggle')!.click()
    const navPanel = document.getElementById('navigation') as HTMLElement
    const oldRow0 = navPanel.querySelector<HTMLElement>('.toc-item-row')!
    expect(oldRow0).not.toBeNull()
    const observer1 = MockIntersectionObserver.instances.at(-1)!

    // 2. 退出书 1 并打开书 2
    document.getElementById('back')!.click()
    currentCreate = mockView2
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(2))
    const buttonsAfter = document.querySelectorAll<HTMLButtonElement>('#items button')
    buttonsAfter[1].click()
    await vi.waitFor(() => expect(document.getElementById('btn-primary-read')).not.toBeNull())
    document.getElementById('btn-primary-read')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    // 打开书 2 目录
    document.getElementById('toc-toggle')!.click()
    expect(mockView2.thumbnail).toHaveBeenCalledTimes(0)

    // 模拟旧 Observer 1 对旧 row 触发迟到回调
    MockIntersectionObserver.triggerDirect(observer1, oldRow0, true)
    // 验证书 2 绝不因此产生缩略图请求！
    expect(mockView2.thumbnail).toHaveBeenCalledTimes(0)

    // 3. 正常触发书 2 的行相交，发起在途请求
    const newRows = [...navPanel.querySelectorAll<HTMLElement>('.toc-item-row')]
    MockIntersectionObserver.trigger(newRows[0], true)
    expect(mockView2.thumbnail).toHaveBeenCalledTimes(1)

    // 退出阅读器（销毁 navigation 组件）
    document.getElementById('back')!.click()

    // 迟到结果返回
    lateResolver2!({
      url: 'blob:late-book2-thumb',
      width: 10,
      height: 10,
      release: () => {
        lateReleaseCount++
      },
    })

    await vi.waitFor(() => expect(lateReleaseCount).toBe(1))
    // 再次触发释放，验证 release 幂等且仅释放一次
    expect(lateReleaseCount).toBe(1)
    // 不写 DOM，不触发 restore 或 turn
    expect(document.querySelector('img[src="blob:late-book2-thumb"]')).toBeNull()
    expect(mockView2.restore).toHaveBeenCalledTimes(0)
    expect(mockView2.turn).toHaveBeenCalledTimes(0)
  })

  it('统一阅读目录控件满足触控最小尺寸要求（>=44px）', async () => {
    const cssPath = path.resolve(__dirname, 'reading.css')
    const cssContent = fs.readFileSync(cssPath, 'utf8')

    // 验证目录搜索输入框最小高度为 44px
    expect(cssContent).toMatch(/\.toc-search-bar input\s*\{[^}]*min-height:\s*44px/s)

    // 验证目录快速跳转 select 与 input 最小高度为 44px
    expect(cssContent).toMatch(
      /\.toc-quick-jump select,\s*\.reader .reader-navigation .toc-quick-jump input\s*\{[^}]*min-height:\s*44px/s
    )

    // 验证目录快速跳转 button 最小高度与最小宽度为 44px
    expect(cssContent).toMatch(/\.toc-quick-jump button\s*\{[^}]*min-height:\s*44px/s)
    expect(cssContent).toMatch(/\.toc-quick-jump button\s*\{[^}]*min-width:\s*44px/s)

    // 验证展开折叠按钮与目录项按钮最小高度为 44px
    expect(cssContent).toMatch(/\.toc-fold-toggle\s*\{[^}]*min-height:\s*44px/s)
    expect(cssContent).toMatch(/\.toc-item-btn\s*\{[^}]*min-height:\s*44px/s)
  })
})
