import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingLibrary } from '../library'
import { file, memoryDrive, shelves } from '../library/test-fixtures'
import { SHELVES_KEY } from '../library/sources'
import { LibraryView } from './library-view'
import type { UiContext } from './types'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function setup(mobile = true) {
  const media = new EventTarget() as EventTarget & { matches: boolean }
  media.matches = mobile
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  document.body.innerHTML = '<div id="modal-container"></div><main class="ui-content"><div id="library"></div></main>'
  const root = file(1, '/阅读/小说', true), other = file(2, '/阅读/漫画', true)
  const mock = memoryDrive([root, other, file(10, '/阅读/小说/文字.txt'), file(11, '/阅读/小说/文档.pdf'), file(20, '/阅读/漫画/漫画.cbz')])
  mock.seed(SHELVES_KEY, shelves(root, other).config)
  const library = new ReadingLibrary(mock.drive, 'all', {}, undefined, true)
  await library.initialize()
  await library.selectSource(root.id)
  await library.refresh()
  await library.bookGroups.load()
  const groupId = await library.bookGroups.create('小说')
  await library.bookGroups.assign([10], groupId)
  const context = {
    drive: mock.drive, library, kind: 'all', signal: new AbortController().signal,
    openReader: vi.fn(async () => {}), openDetail: vi.fn(), switchView: vi.fn(),
    reportError: vi.fn(), createReader: vi.fn(), closeApp: vi.fn(async () => {}),
  } satisfies UiContext
  const container = document.getElementById('library')!
  const view = new LibraryView(container, context)
  cleanups.push(() => library.destroy(), () => view.destroy())
  view.setState({ sourceId: root.id })
  await view.render()
  const get = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!
  const select = (id: string, value: string) => {
    const element = get<HTMLSelectElement>(id)
    element.value = value; element.dispatchEvent(new Event('change'))
  }
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === name)!
  return { ...mock, library, view, context, container, media, get, select, button, groupId }
}

describe('书库紧凑工具栏', () => {
  it('手机默认收起筛选与分组，展开及收起不丢失条件，已启用条件显示计数', async () => {
    const x = await setup()
    const toggle = x.get<HTMLButtonElement>('btn-library-filters')
    expect(toggle.hidden).toBe(false)
    expect(toggle.getAttribute('aria-controls')).toBe('library-filter-panel')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(x.get('library-filter-count').hidden).toBe(true)
    expect(x.get('filter-book-group').closest('#library-filter-panel')).not.toBeNull()
    expect(x.get('book-group-controls').closest('#library-filter-panel')).not.toBeNull()
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(2)
    expect(x.container.querySelector('.library-heading-path')?.textContent).toBe('/阅读/小说')
    expect(x.container.querySelector('.library-heading-meta h2')?.textContent).toBe('小说')
    toggle.click()
    expect(x.get('library-filter-panel').hidden).toBe(false)
    x.select('filter-format', 'txt')
    await vi.waitFor(() => expect(x.container.querySelectorAll('.library-card')).toHaveLength(1))
    x.select('filter-book-group', x.groupId)
    await vi.waitFor(() => expect(x.get('items').getAttribute('aria-busy')).toBe('false'))
    x.select('sort-select', 'recent')
    expect(x.get('library-filter-count').textContent).toBe('3')
    expect(x.get('library-filter-count').hidden).toBe(false)
    x.get<HTMLButtonElement>('btn-library-filters-done').click()
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    await x.view.render(true)
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(x.get<HTMLSelectElement>('filter-format').value).toBe('txt')
    expect(x.get<HTMLSelectElement>('filter-book-group').value).toBe(x.groupId)
    expect(x.get<HTMLSelectElement>('sort-select').value).toBe('recent')
    expect(x.get('library-filter-count').textContent).toBe('3')
    expect(x.context.reportError).not.toHaveBeenCalled()
  })

  it('重置筛选保留当前手动书库与搜索，切换书库默认收起并清空旧条件', async () => {
    const x = await setup()
    x.view.setState({ query: '文字', kind: 'books', format: 'txt', groupId: x.groupId, sort: 'recent' })
    await x.view.render()
    x.get<HTMLButtonElement>('btn-library-filters').click()
    x.get<HTMLButtonElement>('btn-library-clear-filters').click()
    await vi.waitFor(() => expect(x.get('library-filter-count').hidden).toBe(true))
    await vi.waitFor(() => expect(x.get('items').getAttribute('aria-busy')).toBe('false'))
    expect(x.view.getState()).toMatchObject({ sourceId: 1, query: '文字', kind: undefined, format: undefined, groupId: undefined, sort: 'title', offset: 0 })
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(1)
    expect(x.get('library-filter-panel').hidden).toBe(false)
    expect(x.get<HTMLButtonElement>('btn-library-clear-filters').disabled).toBe(true)
    await x.view.selectLibrary({ sourceId: 2 })
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(x.get<HTMLInputElement>('library-search').value).toBe('')
    expect(x.get('library-filter-count').hidden).toBe(true)
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(1)
    expect(x.container.querySelector('.library-card')?.getAttribute('data-file-id')).toBe('20')
  })

  it('进入多选收起筛选，移动栏独立可用，收起与展开筛选不清空选择', async () => {
    const x = await setup()
    x.get<HTMLButtonElement>('btn-library-filters').click()
    x.button('批量分组').click()
    await vi.waitFor(() => expect(x.container.querySelectorAll('.library-card[aria-pressed]')).toHaveLength(2))
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(x.get('book-group-selection').closest('#library-filter-panel')).toBeNull()
    x.container.querySelector<HTMLButtonElement>('[data-file-id="11"]')!.click()
    expect(x.get('group-selection-count').textContent).toBe('已选 1 本')
    x.get<HTMLButtonElement>('btn-library-filters').click()
    x.get<HTMLButtonElement>('btn-library-filters-done').click()
    expect(x.get('group-selection-count').textContent).toBe('已选 1 本')
    const target = x.container.querySelector<HTMLSelectElement>('select[aria-label="移动到分组"]')!
    target.value = x.groupId; target.dispatchEvent(new Event('change'))
    x.get<HTMLButtonElement>('btn-move-group').click()
    await vi.waitFor(() => expect(x.library.bookGroups.groupFor(11)).toBe(x.groupId))
    await vi.waitFor(() => expect(x.button('退出多选').disabled).toBe(false))
    x.button('退出多选').click()
    expect(x.container.querySelector('#book-group-selection')).toBeNull()
    expect(x.get('library-filter-panel').hidden).toBe(true)
    expect(x.context.openReader).not.toHaveBeenCalled()
  })

  it('桌面常驻显示筛选，视口切换同步显隐且销毁后移除响应监听', async () => {
    const x = await setup(false)
    expect(x.get<HTMLButtonElement>('btn-library-filters').hidden).toBe(true)
    expect(x.get('library-filter-panel').hidden).toBe(false)
    x.media.matches = true; x.media.dispatchEvent(new Event('change'))
    expect(x.get<HTMLButtonElement>('btn-library-filters').hidden).toBe(false)
    expect(x.get('library-filter-panel').hidden).toBe(true)
    x.get<HTMLButtonElement>('btn-library-filters').click()
    x.media.matches = false; x.media.dispatchEvent(new Event('change'))
    expect(x.get('library-filter-panel').hidden).toBe(false)
    x.media.matches = true; x.media.dispatchEvent(new Event('change'))
    expect(x.get('library-filter-panel').hidden).toBe(false)
    x.get<HTMLButtonElement>('btn-library-filters').click()
    x.view.destroy()
    x.media.matches = false; x.media.dispatchEvent(new Event('change'))
    expect(x.get('library-filter-panel').hidden).toBe(true)
  })
})
