import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingLibrary } from '../library'
import { file, memoryDrive, sources } from '../library/test-fixtures'
import { SOURCES_KEY } from '../library/sources'
import { LibraryView } from './library-view'
import { DetailView } from './detail-view'
import type { UiContext } from './types'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren() })
async function setup() {
  document.body.innerHTML = '<div id="modal-container"></div><div id="test"></div>'
  const root = file(1, '/书', true), book = file(2, '/书/小说.txt'), other = file(3, '/书/指南.txt')
  const mock = memoryDrive([root, book, other]); mock.seed(SOURCES_KEY, sources(root).config)
  const library = new ReadingLibrary(mock.drive, 'books')
  await library.initialize(); await library.refresh(); await library.bookGroups.load()
  const groupId = await library.bookGroups.create('小说')
  const context = { drive: mock.drive, library, kind: 'books', signal: new AbortController().signal,
    openReader: vi.fn(), openDetail: vi.fn(), switchView: vi.fn(), reportError: vi.fn(), createReader: vi.fn(), closeApp: vi.fn() } satisfies UiContext
  const container = document.getElementById('test')!
  cleanups.push(() => library.destroy())
  const button = (name: string) => [...container.querySelectorAll('button')].find(el => el.textContent === name)!
  const select = (label: string, value: string) => {
    const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    el.value = value; el.dispatchEvent(new Event('change')); return el
  }
  return { ...mock, library, context, container, button, select, groupId }
}
describe('图书分组界面', () => {
  it('切换页面取消分组加载时，不把旧请求错误显示在新页面', async () => {
    const x = await setup(), view = new LibraryView(x.container, x.context)
    cleanups.push(() => view.destroy())
    vi.spyOn(x.library.bookGroups, 'load').mockImplementationOnce(signal => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    }))
    const previous = view.render()
    await view.render(); await previous
    expect(x.context.reportError).not.toHaveBeenCalled()
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(2)
  })
  it('保存失败保留多选，重新加载分组后可重试；切换筛选清空选择', async () => {
    const x = await setup(), view = new LibraryView(x.container, x.context)
    cleanups.push(() => view.destroy()); await view.render()
    x.button('批量分组').click()
    await vi.waitFor(() => expect(x.container.querySelectorAll('.library-card[aria-pressed]')).toHaveLength(2))
    x.container.querySelector<HTMLButtonElement>('[data-file-id="2"]')!.click()
    expect(x.context.openReader).not.toHaveBeenCalled()
    x.select('移动到分组', x.groupId)
    x.set.mockRejectedValueOnce(new Error('网络中断'))
    x.button('移动').click()
    await vi.waitFor(() => expect(x.context.reportError).toHaveBeenCalled())
    expect(x.container.querySelector('#group-selection-count')?.textContent).toBe('已选 1 本')
    expect(x.container.querySelector<HTMLSelectElement>('select[aria-label="移动到分组"]')?.value).toBe(x.groupId)
    x.button('重新加载分组').click()
    await vi.waitFor(() => expect(x.button('重新加载分组').disabled).toBe(false))
    expect(x.container.querySelector('#group-selection-count')?.textContent).toBe('已选 1 本')
    x.select('移动到分组', x.groupId); x.button('移动').click()
    await vi.waitFor(() => expect(x.library.bookGroups.groupFor(2)).toBe(x.groupId))
    await vi.waitFor(() => expect(x.button('全选当前页').disabled).toBe(false))
    x.button('全选当前页').click()
    expect(x.container.querySelector('#group-selection-count')?.textContent).toBe('已选 2 本')
    x.select('筛选分组', x.groupId)
    await vi.waitFor(() => expect(x.container.querySelectorAll('.library-card')).toHaveLength(1))
    expect(x.container.querySelector('#group-selection-count')?.textContent).toBe('已选 0 本')
  })
  it('详情页保存单本书分组，返回书库仍显示归属', async () => {
    const x = await setup(), detail = new DetailView(x.container, x.context)
    cleanups.push(() => detail.destroy())
    await detail.render({ unit: x.library.snapshot.units.find(unit => unit.nodeId === 2)! })
    x.select('书籍分组', x.groupId); x.button('保存分组').click()
    await vi.waitFor(() => expect(x.library.bookGroups.groupFor(2)).toBe(x.groupId))
    detail.destroy()
    const view = new LibraryView(x.container, x.context); cleanups.push(() => view.destroy())
    await view.render()
    expect(x.container.querySelector('[data-file-id="2"] .book-group-badge')?.textContent).toBe('小说')
  })
  it('文件视图对尚未索引文件同样按稳定标识筛选；未分组不混入已有分组', async () => {
    const x = await setup(), extra = file(99, '/书/新书.txt')
    await x.library.bookGroups.assign([99], x.groupId)
    vi.spyOn(x.library.access, 'list').mockResolvedValue({ entries: [extra], directory: file(1, '/书', true), sourceIds: [1], has_more: false, next_cursor: null, path: '/书' })
    const view = new LibraryView(x.container, x.context); cleanups.push(() => view.destroy())
    view.setState({ view: 'files', groupId: x.groupId }); await view.render()
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(1)
    expect(x.container.querySelector('.library-card')?.getAttribute('data-file-id')).toBe('99')
    x.select('筛选分组', '')
    await vi.waitFor(() => expect(x.container.querySelectorAll('.library-card')).toHaveLength(2))
    expect(x.container.querySelector('[data-file-id="99"]')).toBeNull()
  })
})
