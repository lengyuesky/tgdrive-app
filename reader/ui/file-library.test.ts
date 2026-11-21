import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilePage, JsonValue } from '@tgdrive/page-sdk'
import { ReadingLibrary } from '../library'
import { deferred, file, memoryHost, sources, testBindings } from '../library/test-fixtures'
import { FileLibraryView } from './file-library'
import type { UiContext } from './types'

const views: FileLibraryView[] = [], libraries: ReadingLibrary[] = []
afterEach(() => { for (const view of views.splice(0)) view.destroy(); for (const library of libraries.splice(0)) library.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren() })
async function setup(kind: UiContext['kind'] = 'books', count = 85) {
  vi.stubGlobal('IntersectionObserver', undefined)
  const root = file(1, '/书', true), entries = Array.from({ length: count }, (_, index) => file(index + 2001, `/书/书${String(index).padStart(4, '0')}.txt`))
  const mock = await memoryHost([root, ...entries, file(99, '/书/漫画.cbz')])
  await mock.seed('library:sources', sources(root).config)
  const library = new ReadingLibrary(mock.host, kind); libraries.push(library); await library.initialize()
  const context: UiContext = { ...testBindings(mock.host), host: mock.host, library, kind, signal: new AbortController().signal, openReader: vi.fn(async () => {}), openDetail: vi.fn(async () => {}), switchView: vi.fn(async () => {}), reportError: vi.fn(), createReader: vi.fn(), closeApp: vi.fn(async () => {}) }
  const container = document.createElement('div'); document.body.append(container)
  const back = vi.fn(), create = () => { const view = new FileLibraryView(container, context, back); views.push(view); return view }
  const view = create(), click = (id: string) => container.querySelector<HTMLButtonElement>(`#host-${id}`)!.click()
  return { ...mock, root, entries, library, context, container, view, create, click, back, saved: () => mock.records.get('reader:browse:v1') }
}

describe('应用自己的通用文件分页视图', () => {
  it('混合应用筛选图书和漫画，重开恢复筛选范围，切换时清空旧格式与游标', async () => {
    const x = await setup('all'); await x.view.render()
    expect(x.query.mock.calls[0]![0].filter.extensions).toEqual(['txt', 'epub', 'pdf', 'cbz', 'zip'])
    expect(x.directoriesWithFiles).toHaveBeenCalled()
    expect(x.container.querySelectorAll('#host-format option')).toHaveLength(7)
    const kind = x.container.querySelector<HTMLSelectElement>('#host-kind')!
    kind.value = 'books'; kind.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(x.saved()?.value).toMatchObject({ query: { kind: 'books', cursor: null } }))
    expect(x.container.querySelectorAll('#host-format option')).toHaveLength(4)
    x.view.destroy(); await x.create().render()
    expect(x.container.querySelector<HTMLSelectElement>('#host-kind')!.value).toBe('books')
    x.container.querySelector<HTMLSelectElement>('#host-kind')!.value = 'comics'
    x.container.querySelector<HTMLSelectElement>('#host-kind')!.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(x.saved()?.value).toMatchObject({ query: { kind: 'comics', cursor: null } }))
    expect(x.container.querySelector('.card-title')?.textContent).toBe('漫画.cbz'); expect(x.context.reportError).not.toHaveBeenCalled()
  })
  it('格式筛选范围外的条目被拒绝，不保存无效页面', async () => {
    const x = await setup(); await x.view.render()
    const read = x.query.getMockImplementation()!
    x.query.mockImplementationOnce(async (...args) => ({ ...await read(...args), items: [x.nodes.get('99')!] }))
    x.click('refresh')
    await vi.waitFor(() => expect(x.context.reportError).toHaveBeenCalled())
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(0)
    expect(x.saved()?.value).toMatchObject({ query: { kind: 'books' } })
  })
  it('DOM 只驻留本页，保存及重开恢复双路位置，不依赖旧 2000 项索引', async () => {
    const x = await setup(); await x.view.render()
    expect(x.query).toHaveBeenCalledWith(expect.objectContaining({ roots: [x.root.id], limit: 200, cursor: null }), expect.anything())
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(40)
    x.container.querySelector<HTMLButtonElement>('.library-card')!.click()
    expect(x.context.openReader).toHaveBeenCalledWith('2001')
    x.click('next'); await vi.waitFor(() => expect(x.saved()?.value).toMatchObject({ page: 2 }))
    const saved = x.saved()!.value as unknown as { query: { cursor: unknown } }
    expect(saved.query.cursor).toMatchObject({ files: { skipped: 40 } })
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(40)
    x.view.destroy(); await x.create().render()
    expect(x.container.querySelector('[data-file-id="2041"]')).not.toBeNull()
    expect(x.container.querySelector('#host-page')!.textContent).toContain('2')
    expect(x.container.querySelector<HTMLButtonElement>('#host-prev')!.disabled).toBe(true)
    x.click('refresh'); await vi.waitFor(() => expect(x.saved()?.value).toMatchObject({ page: 1, query: { cursor: null } }))
  })
  it('过期游标不静默跳页，刷新保留字面搜索，文本不注入 HTML', async () => {
    const x = await setup(); await x.view.render()
    x.query.mockRejectedValueOnce(Object.assign(new Error('游标已失效'), { code: 'cursor_expired' }))
    x.click('next'); await vi.waitFor(() => expect(x.container.textContent).toContain('分页位置已失效'))
    expect(x.container.querySelector<HTMLButtonElement>('#host-next')!.disabled).toBe(true); expect(x.set).toHaveBeenCalledOnce()
    const search = x.container.querySelector<HTMLInputElement>('#host-search')!
    search.value = '<img src=x onerror=bad()>.txt'
    await x.host.addNode({ id: '999', parent_id: x.root.id, name: search.value, kind: 'file', bytes: [] })
    x.click('apply'); await vi.waitFor(() => expect(x.container.querySelector('.card-title')?.textContent).toBe(search.value))
    expect(x.container.querySelector('img')).toBeNull()
    expect(x.query.mock.calls.at(-1)![0]).toMatchObject({ filter: { name_contains: search.value }, cursor: null })
  })
  it('新查询取消旧请求，迟到响应和权限变化不留下旧卡片', async () => {
    const x = await setup(); await x.view.render()
    const started = deferred(), waiting = deferred<FilePage>(), read = x.query.getMockImplementation()!
    let old!: FilePage
    x.query.mockImplementationOnce(async (...args) => { old = await read(...args); started.resolve(); return waiting.promise })
    x.click('next'); await started.promise
    const oldSignal = x.query.mock.calls.at(-1)![1]!.signal!
    x.click('refresh'); await vi.waitFor(() => expect(x.container.querySelector('[data-file-id="2001"]')).not.toBeNull())
    expect(oldSignal.aborted).toBe(true)
    waiting.resolve(old); await Promise.resolve(); await Promise.resolve()
    expect(x.container.querySelector('[data-file-id="2041"]')).toBeNull()
    await x.emitEvent('scope.changed', { revision: 'changed' })
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(0); expect(x.container.textContent).toContain('权限已变化')
    x.view.destroy(); await x.emitEvent('scope.changed', { revision: 'next' })
  })
  it('读取位置失败不覆盖远端，保存冲突仍可继续阅读但不盲目重试', async () => {
    const x = await setup(); x.get.mockRejectedValueOnce(new Error('断网'))
    await x.view.render(); expect(x.set).not.toHaveBeenCalled(); expect(x.container.textContent).toContain('本次不覆盖已有位置')
    const y = await setup(); y.set.mockRejectedValueOnce(new Error('冲突'))
    await y.view.render(); expect(y.container.querySelector('.library-card')).not.toBeNull(); expect(y.container.textContent).toContain('未覆盖远端位置')
    y.click('next'); await vi.waitFor(() => expect(y.container.querySelector('[data-file-id="2041"]')).not.toBeNull())
    expect(y.set).toHaveBeenCalledOnce()
  })
  it('重复节点、过大宿主页与越界来源被拒绝，重复游标不能制造循环', async () => {
    for (const variant of ['duplicate', 'outside', 'large'] as const) {
      const x = await setup(), read = x.query.getMockImplementation()!
      x.query.mockImplementationOnce(async (...args) => {
        const page = await read(...args), entry = page.items[0]!
        const items = variant === 'duplicate' ? [entry, entry] : variant === 'outside' ? [{ ...entry, path: '/别处/秘密.txt' }] : Array.from({ length: 201 }, (_, index) => ({ ...entry, id: String(index + 10000) }))
        return { ...page, items }
      })
      await x.view.render(); expect(x.container.querySelector('.library-card')).toBeNull(); expect(x.set).not.toHaveBeenCalled(); expect(x.context.reportError).toHaveBeenCalled()
    }
    const x = await setup('books', 205), read = x.query.getMockImplementation()!
    x.query.mockImplementation(async (...args) => { const page = await read(...args); return args[0].cursor ? { ...page, next_cursor: args[0].cursor } : page })
    await x.view.render()
    for (let page = 2; page <= 4; page++) { x.click('next'); await vi.waitFor(() => expect(x.saved()?.value).toMatchObject({ page })) }
    x.click('next'); await vi.waitFor(() => expect(x.context.reportError).toHaveBeenCalled())
    expect(x.set).toHaveBeenCalledTimes(4)
  })
  it('未知位置版本或无来源时不回退到授权全盘，也不覆盖原位置', async () => {
    const x = await setup(); const old = await x.seed('reader:browse:v1', { schemaVersion: 42 } as JsonValue)
    await x.view.render(); expect(x.set).not.toHaveBeenCalled(); expect(x.records.get(old.key)).toEqual(old)
    const y = await setup(); const base = y.library.snapshot.sources
    await y.library.removeSource(y.root.id, base)
    y.query.mockClear(); await y.view.render()
    expect(y.query).not.toHaveBeenCalled(); expect(y.container.textContent).toContain('请先创建书库')
  })
})
