import { afterEach, describe, expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive } from '../sdk/types'
import type { ReaderView, ViewContext } from './view'
import type { Location } from './state'
import { file, memoryDrive, deferred, sources } from './library/test-fixtures'
import { BookGroupsStore } from './library'

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('阅读馆统一应用入口', () => {
  it('同一个书库跨书漫打开、使用各自默认偏好，返回后保留混合导航和历史', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('IntersectionObserver', undefined)
    const root = file(1, '/阅读', true)
    const entries = [file(2, '/阅读/文字.txt'), file(3, '/阅读/漫画.cbz'), file(4, '/阅读/文档.pdf'), file(5, '/阅读/电子.epub')]
    const mock = memoryDrive([root, ...entries], { source: '/阅读' })
    const drive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'reader', name: '阅读馆', api_version: 2, version: '1.0.0', dark: false }),
      on: () => () => {}, ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
    }) as Drive
    window.tgdrive = drive
    const create = vi.fn(async (context: ViewContext): Promise<ReaderView> => {
      const format: Location['format'] = context.file.name.endsWith('.cbz') ? 'comic' : context.file.name.endsWith('.pdf') ? 'pdf' : context.file.name.endsWith('.epub') ? 'epub' : 'txt'
      return {
        title: context.file.name, sections: [{ label: '正文' }], capabilities: { fits: ['page', 'width'] },
        open: async () => {}, current: () => ({ format, index: 0 }),
        navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
        turn: async () => {}, go: async () => {}, restore: async () => {}, configure: async () => {}, destroy: () => {},
      }
    })
    await startApp({ id: 'reader', kind: 'all', create })
    expect(document.querySelector('.sidebar-title')?.textContent).toBe('阅读馆')
    expect(document.getElementById('app')?.dataset.app).toBe('reader')
    document.getElementById('nav-library')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items .library-card')).toHaveLength(4))
    expect(document.querySelectorAll('#filter-format option')).toHaveLength(7)
    for (const [nodeId, mode, fit] of [[2, 'page', undefined], [3, 'single', 'page'], [4, 'scroll', 'page'], [5, 'page', undefined]] as const) {
      document.querySelector<HTMLButtonElement>(`#items [data-file-id="${nodeId}"]`)!.click()
      await vi.waitFor(() => expect(create.mock.calls.at(-1)?.[0].file.id).toBe(nodeId))
      await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))
      expect(create.mock.calls.at(-1)![0].prefs).toMatchObject({ mode, fit })
      expect(document.getElementById('app')?.dataset.controls).toBe('visible')
      expect(document.getElementById('comic-mode-option')?.hidden).toBe(nodeId !== 3)
      document.getElementById('back')!.click()
      await vi.waitFor(() => expect(document.getElementById('app-ui')?.inert).toBe(false))
      await vi.waitFor(() => expect(document.querySelectorAll('#items .library-card')).toHaveLength(4))
    }
    expect([...mock.records.keys()].filter(key => key.startsWith('progress:')).sort()).toEqual(['progress:2', 'progress:3', 'progress:4', 'progress:5'])
    const kind = document.querySelector<HTMLSelectElement>('#filter-kind')!
    kind.value = 'comics'; kind.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(document.querySelectorAll('#items .library-card')).toHaveLength(1))
    expect(document.querySelector('#items .library-card')?.getAttribute('data-file-id')).toBe('3')
  })

  it('首页侧栏按类型、来源和自定义分组切换，清空旧搜索，返回阅读后保留选择并刷新分组', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('IntersectionObserver', undefined)
    const root = file(1, '/阅读', true), comics = file(6, '/漫画', true)
    const mock = memoryDrive([root, comics, file(2, '/阅读/文字.txt'), file(3, '/漫画/漫画.cbz'), file(4, '/阅读/文档.pdf')])
    mock.seed('library:sources', sources(root, comics).config)
    const groups = new BookGroupsStore(mock.drive)
    await groups.load()
    const groupId = await groups.create('小说')
    await groups.assign([2], groupId)
    const listeners = new Map<string, (value: unknown) => unknown>()
    const setImmersive = vi.fn(async () => {})
    window.tgdrive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'reader', name: '阅读馆', api_version: 2, version: '1.0.0', dark: false, capabilities: ['ui.setImmersive'] }),
      on: (event: string, callback: (value: unknown) => unknown) => { listeners.set(event, callback); return () => listeners.delete(event) },
      ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}), setImmersive },
    }) as Drive
    const create = vi.fn(async (context: ViewContext): Promise<ReaderView> => ({
      title: context.file.name, sections: [{ label: '正文' }],
      open: async () => {}, current: () => ({ format: context.file.name.endsWith('.cbz') ? 'comic' : 'txt', index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
      turn: async () => {}, go: async () => {}, restore: async () => {}, configure: async () => {}, destroy: () => {},
    }))
    await startApp({ id: 'reader', kind: 'all', create })
    const shortcut = (id: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-library-id]')].find(button => button.dataset.libraryId === id)!
    const ids = () => [...document.querySelectorAll<HTMLElement>('#items .library-card')].map(card => card.dataset.fileId).sort()
    expect(document.getElementById('view-home')?.hidden).toBe(false)
    expect(shortcut(`group:${groupId}`).textContent).toContain('小说')
    shortcut('kind:comics').click()
    await vi.waitFor(() => expect(ids()).toEqual(['3']))
    expect(document.querySelector<HTMLSelectElement>('#filter-kind')?.value).toBe('comics')
    expect(shortcut('kind:comics').getAttribute('aria-current')).toBe('page')
    const search = document.querySelector<HTMLInputElement>('#library-search')!
    search.value = '不匹配'; search.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(ids()).toEqual([]))
    shortcut('source:1').click()
    await vi.waitFor(() => expect(ids()).toEqual(['2', '4']))
    expect(document.querySelector<HTMLInputElement>('#library-search')?.value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('#filter-kind')?.value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('#filter-source')?.value).toBe('1')
    shortcut(`group:${groupId}`).click()
    await vi.waitFor(() => expect(ids()).toEqual(['2']))
    expect(document.querySelector<HTMLSelectElement>('#filter-source')?.value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('#filter-book-group')?.value).toBe(groupId)
    document.querySelector<HTMLButtonElement>('#items .library-card')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))
    expect(create.mock.calls.at(-1)?.[0].file.id).toBe(2)
    expect(setImmersive).toHaveBeenCalledWith(true, undefined)
    document.getElementById('back')!.click()
    await vi.waitFor(() => expect(document.getElementById('app-ui')?.inert).toBe(false))
    expect(document.querySelector<HTMLSelectElement>('#filter-book-group')?.value).toBe(groupId)
    expect(shortcut(`group:${groupId}`).getAttribute('aria-current')).toBe('page')
    expect(setImmersive).toHaveBeenLastCalledWith(false, undefined)
    document.getElementById('nav-home')!.click()
    await vi.waitFor(() => expect(document.getElementById('view-home')?.hidden).toBe(false))
    await groups.rename(groupId, '文学')
    listeners.get('storage.changed')?.({ key: 'library:book-groups' })
    await vi.waitFor(() => expect(shortcut(`group:${groupId}`).textContent).toContain('文学'))
    document.getElementById('nav-library')!.click()
    await vi.waitFor(() => expect(ids()).toEqual(['2', '3', '4']))
    expect(document.querySelector<HTMLSelectElement>('#filter-book-group')?.value).toBe('*')
  })

  it('快速切换来源时取消旧读取，迟到响应不能覆盖最终书库选择', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('IntersectionObserver', undefined)
    const left = file(1, '/图书', true), right = file(2, '/漫画', true)
    const mock = memoryDrive([left, right, file(10, '/图书/小说.txt'), file(20, '/漫画/连载.cbz')])
    mock.seed('library:sources', sources(left, right).config)
    window.tgdrive = Object.assign(mock.drive, {
      ready: Promise.resolve({ id: 'reader', name: '阅读馆', api_version: 2, version: '1.0.0', dark: false }),
      on: () => () => {}, ui: { close: vi.fn(async () => {}), download: vi.fn(async () => {}) },
    }) as Drive
    await startApp({ id: 'reader', kind: 'all', create: vi.fn() })
    const original = mock.get.getMockImplementation()!, delayed = deferred(), started = deferred()
    let previousSignal: AbortSignal | undefined
    mock.get.mockImplementation(async (key, options) => {
      if (key === 'library:cache:index:source:1') {
        previousSignal = options?.signal; started.resolve(); await delayed.promise
      }
      return original(key, options)
    })
    const shortcut = (id: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-library-id]')].find(button => button.dataset.libraryId === id)!
    shortcut('source:1').click(); await started.promise
    shortcut('source:2').click()
    await vi.waitFor(() => expect(document.querySelector('#items .library-card')?.getAttribute('data-file-id')).toBe('20'))
    expect(previousSignal?.aborted).toBe(true)
    delayed.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(document.querySelectorAll('#items .library-card')).toHaveLength(1)
    expect(document.querySelector('#items .library-card')?.getAttribute('data-file-id')).toBe('20')
    expect(document.querySelector<HTMLSelectElement>('#filter-source')?.value).toBe('2')
    expect(shortcut('source:2').getAttribute('aria-current')).toBe('page')
  })
})
