import type { NodeId } from '@tgdrive/page-sdk'
import { testId } from './library/test-fixtures'
import { pageFor } from './library/test-fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { HostClient, PageContext } from '@tgdrive/page-sdk'
import type { ReaderView, ViewContext } from './view'
import type { Location } from './state'
import { file, memoryHost, deferred, sources, shelves } from './library/test-fixtures'
import { SHELVES_KEY } from './library'

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function setup(options: { configured?: boolean; scope?: import('@tgdrive/page-sdk').DirectoryScope; launch?: PageContext['launch'] } = {}) {
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('IntersectionObserver', undefined)
  const books = file(1, '/图书', true), comics = file(2, '/漫画', true)
  const entries = [file(10, '/图书/文字.txt'), file(11, '/图书/文档.pdf'), file(20, '/漫画/漫画.cbz')]
  const mock = await memoryHost([books, comics, ...entries])
  if (options.configured) await mock.seed(SHELVES_KEY, shelves(books, comics).config)
  if (options.scope) await mock.host.setScope(options.scope)
  if (options.launch?.action === 'open') options.launch.file = mock.nodes.get(options.launch.file.id)!
  const create = vi.fn(async (context: ViewContext): Promise<ReaderView> => {
    const format: Location['format'] = context.file.name.endsWith('.cbz') ? 'comic' : context.file.name.endsWith('.pdf') ? 'pdf' : 'txt'
    return { title: context.file.name, sections: [{ label: '正文' }], capabilities: { fits: ['page', 'width'] },
      open: async () => {}, current: () => ({ format, index: 0 }),
      navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
      turn: async () => {}, go: async () => {}, restore: async () => {}, configure: async () => {}, destroy: () => {}, }
  })
  const listeners = new Map<string, (value: unknown) => unknown>()
  window.readerTestHost = (Object.assign(mock.context, { app: { ...mock.context.app, name: '阅读馆' }, theme: false ? 'dark' : 'light', launch: options.launch ?? { action: 'browse' }, }), Object.assign(mock.ui, { close: vi.fn(async () => {}) }), [...mock.listeners].forEach(([name, emit]) => listeners.set(name, emit)), mock.host) as HostClient
  return { ...mock, books, comics, entries, listeners, create, start: () => startApp({ id: 'reader', kind: 'all', create }, pageFor(window.readerTestHost)),
    shortcut: (id: NodeId) => document.querySelector<HTMLButtonElement>(`[data-library-id="source:${id}"]`)!,
    ids: () => [...document.querySelectorAll<HTMLElement>('#items .library-card')].map(card => card.dataset.fileId).sort(), }
}

async function createShelf(name: string, path: string) {
  document.getElementById('btn-home-create-shelf')!.click()
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  dialog.querySelector<HTMLInputElement>('[aria-label="书库名称"]')!.value = name
  dialog.querySelector<HTMLInputElement>('[aria-label="对应目录"]')!.value = path
  ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '创建并扫描')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
}

describe('阅读馆手动书库入口', () => {
  it('旧来源、授权目录和文件变化都不创建书库，首次打开零扫描且不显示图书', async () => {
    const x = await setup({ scope: { mode: 'selected', directories: [{ directory_id: testId(1), access: 'read_only' }, { directory_id: testId(2), access: 'read_only' }] } })
    const previous = await x.seed('library:sources', sources(x.books, x.comics).config)
    await x.start()
    expect(document.querySelectorAll('.shelf-card')).toHaveLength(0)
    expect(document.querySelector('#view-home')?.textContent).toContain('请自己创建书库')
    expect(document.querySelector('[data-library-id]')).toBeNull()
    expect(x.list).not.toHaveBeenCalled(); expect(x.query).not.toHaveBeenCalled(); expect(x.readRange).not.toHaveBeenCalled()
    expect(x.records.get('library:sources')).toEqual(previous)
    expect(x.records.has(SHELVES_KEY)).toBe(false)
    x.listeners.get('files.changed')?.({ paths: ['/图书'] })
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(x.list).not.toHaveBeenCalled()
  })

  it('创建命名书库才扫描并保存该目录，多个书库分别显示而不聚合全盘', async () => {
    const x = await setup()
    await x.start()
    await createShelf('我的小说', '/图书')
    await vi.waitFor(() => expect(x.ids()).toEqual(['10', '11']))
    expect(x.query.mock.calls.every(([params]) => params.roots.includes(x.books.id))).toBe(true)
    expect(x.records.get(SHELVES_KEY)?.value).toMatchObject({ sources: [{ name: '我的小说', nodeId: testId(1), path: '/图书' }] })
    expect(x.records.has('library:cache:shelves:v1:index:source:1000000000000000001')).toBe(true)
    expect(document.querySelector('[data-library-id="kind:books"]')).toBeNull()
    document.getElementById('nav-home')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.shelf-card')).toHaveLength(1))
    x.query.mockClear(); x.list.mockClear()
    await createShelf('我的漫画', '/漫画')
    await vi.waitFor(() => expect(x.ids()).toEqual(['20']))
    expect(x.query.mock.calls.every(([params]) => params.roots.includes(x.comics.id))).toBe(true)
    x.shortcut(testId(1)).click()
    await vi.waitFor(() => expect(x.ids()).toEqual(['10', '11']))
    expect(document.querySelectorAll('#filter-source option')).toHaveLength(3)
    expect(document.querySelector<HTMLElement>('#filter-source')?.hidden).toBe(true)
    expect(document.querySelector('#btn-view-host')?.textContent).toBe('目录全部文件')
    document.getElementById('nav-library')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#view-library .shelf-card')).toHaveLength(2))
    expect(document.querySelectorAll('#items .library-card')).toHaveLength(0)
  })

  it('手动书库之间切换取消旧请求，迟到索引不能覆盖最终选择', async () => {
    const x = await setup({ configured: true })
    await x.start()
    const original = x.get.getMockImplementation()!, delayed = deferred(), started = deferred()
    let previousSignal: AbortSignal | undefined
    x.get.mockImplementation(async (key, options) => {
      if (key === 'library:cache:shelves:v1:index:source:' + x.books.id) { previousSignal = options?.signal; started.resolve(); await delayed.promise }
      return original(key, options)
    })
    x.shortcut(testId(1)).click(); await started.promise
    x.shortcut(testId(2)).click()
    await vi.waitFor(() => expect(x.ids()).toEqual(['20']))
    expect(previousSignal?.aborted).toBe(true)
    delayed.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(x.ids()).toEqual(['20'])
    expect(x.shortcut(testId(2)).getAttribute('aria-current')).toBe('page')
  })

  it('未建书库时从打开方式直接读取启动文件，不隐式保存父目录或扫描全库', async () => {
    const x = await setup({ launch: { action: 'open', file: file(10, '/图书/文字.txt') } })
    await x.start()
    expect(document.getElementById('reading-status')?.textContent).toBe('')
    expect(x.records.has(SHELVES_KEY)).toBe(false)
    expect(x.list).not.toHaveBeenCalled(); expect(x.query).not.toHaveBeenCalled(); expect(x.create).toHaveBeenCalledOnce()
    expect(x.create.mock.calls[0]![0].file.id).toBe('10')
  })

  it('漫画首次默认适宽，打开与返回保留同书库与跨格式进度', async () => {
    const x = await setup({ configured: true })
    await x.start(); x.shortcut(testId(2)).click()
    await vi.waitFor(() => expect(x.ids()).toEqual(['20']))
    document.querySelector<HTMLButtonElement>('#items .library-card')!.click()
    await vi.waitFor(() => expect(x.create.mock.calls.at(-1)?.[0].file.id).toBe(testId(20)))
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))
    expect(x.create.mock.calls.at(-1)![0].prefs).toMatchObject({ mode: 'single', fit: 'width', zoom: 1 })
    document.getElementById('back')!.click()
    await vi.waitFor(() => expect(document.getElementById('app-ui')?.inert).toBe(false))
    expect(x.ids()).toEqual(['20'])
    expect(x.records.has('progress:20')).toBe(true)
    await vi.waitFor(() => expect(x.records.has('library:cache:history')).toBe(true))
    document.getElementById('nav-me')!.click()
    await vi.waitFor(() => expect(document.getElementById('me-tab-history')).not.toBeNull())
    document.getElementById('me-tab-history')!.click()
    await vi.waitFor(() => expect(document.getElementById('history-items-list')?.textContent).toContain('漫画.cbz'))
  })
})
