import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostLibraryView } from './host-library'
import type { UiContext } from './types'
import type { HostLibraryPage } from '../../sdk/types'

const active: HostLibraryView[] = []
afterEach(() => { for (const view of active.splice(0)) view.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const entry = (id: number, name = `${id}.txt`) => ({ file: { id, name, path: `/书/${name}`, is_dir: false, size: 1, content_version: 'v1', created_at: 1, modified_at: 1, favorite: false }, format: 'txt', source_ids: [1] })
const result = (id: number, cursor: string | null = null): HostLibraryPage => ({ entries: [entry(id)], revision: 'revision', has_more: cursor !== null, next_cursor: cursor })
function setup() {
  vi.stubGlobal('IntersectionObserver', undefined)
  const container = document.createElement('div'); document.body.append(container)
  let saved: any = null
  const listeners = new Map<string, () => void>()
  const page = vi.fn().mockResolvedValue(result(2001, 'page-two'))
  const storage = { get: vi.fn(async () => saved), set: vi.fn(async (key, value, revision) => {
    if ((saved?.revision ?? null) !== revision) throw new Error('冲突')
    saved = { key, value: structuredClone(value), revision: String(Number(saved?.revision ?? 0) + 1), updated_at: 1 }; return saved
  }) }
  const context = { kind: 'books', signal: new AbortController().signal, library: { snapshot: { sources: { config: { sources: [{ nodeId: 1, path: '/书' }] } } } },
    drive: { library: { page }, storage, on: (event: string, fn: () => void) => { listeners.set(event, fn); return () => listeners.delete(event) } },
    openReader: vi.fn().mockResolvedValue(undefined), reportError: vi.fn() } as unknown as UiContext
  const back = vi.fn()
  const view = new HostLibraryView(container, context, back); active.push(view)
  const click = (id: string) => container.querySelector<HTMLButtonElement>(`#host-${id}`)!.click()
  return { view, context, container, page, storage, listeners, click, back, saved: () => saved }
}
describe('宿主全库分页', () => {
  it('只读取当前页、按文件名显示并开读；保存及重开恢复游标，不依赖本地 2000 项索引', async () => {
    const x = setup(); await x.view.render()
    expect(x.page).toHaveBeenCalledWith(expect.objectContaining({ roots: [1], kind: 'books', limit: 40, cursor: null }), expect.anything())
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(1)
    ;(x.container.querySelector('.library-card') as HTMLButtonElement).click()
    expect(x.context.openReader).toHaveBeenCalledWith(2001)
    x.page.mockResolvedValueOnce(result(2041))
    x.click('next')
    await vi.waitFor(() => expect(x.storage.set).toHaveBeenCalledTimes(2))
    expect(x.page.mock.calls.at(-1)![0].cursor).toBe('page-two')
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(1)
    expect(x.saved().value.page).toBe(2)
    x.view.destroy(); x.page.mockResolvedValue(result(2041))
    const reopened = new HostLibraryView(x.container, x.context, x.back); active.push(reopened); await reopened.render()
    expect(x.page.mock.calls.at(-1)![0].cursor).toBe('page-two')
    expect(x.container.querySelector('#host-page')!.textContent).toContain('2')
    expect((x.container.querySelector('#host-prev') as HTMLButtonElement).disabled).toBe(true)
    x.click('refresh'); await vi.waitFor(() => expect(x.page.mock.calls.at(-1)![0].cursor).toBeNull())
  })

  it('变更游标不静默跳页，刷新保留查询；文本不注入 HTML', async () => {
    const x = setup(); await x.view.render()
    x.page.mockRejectedValueOnce(Object.assign(new Error('目录已变化'), { code: 'reading_index_changed' }))
    x.click('next'); await vi.waitFor(() => expect(x.container.textContent).toContain('旧位置已失效'))
    expect((x.container.querySelector('#host-next') as HTMLButtonElement).disabled).toBe(true)
    expect(x.storage.set).toHaveBeenCalledTimes(1)
    const search = x.container.querySelector<HTMLInputElement>('#host-search')!
    search.value = '<img src=x onerror=bad()>.txt'
    x.page.mockResolvedValueOnce({ ...result(1), entries: [entry(1, search.value)] })
    x.click('apply'); await vi.waitFor(() => expect(x.container.querySelector('.card-title')?.textContent).toBe(search.value))
    expect(x.container.querySelector('img')).toBeNull()
    expect(x.page.mock.calls.at(-1)![0]).toMatchObject({ q: search.value, cursor: null })
  })

  it('新查询取消旧请求；迟到响应和权限变化不留下旧卡片', async () => {
    const x = setup(); await x.view.render()
    let finish!: (value: HostLibraryPage) => void
    x.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    x.click('next')
    const oldSignal = x.page.mock.calls.at(-1)![1].signal
    x.page.mockResolvedValueOnce(result(99)); x.click('refresh')
    await vi.waitFor(() => expect(x.container.querySelector('[data-file-id="99"]')).not.toBeNull())
    expect(oldSignal.aborted).toBe(true)
    finish(result(5)); await Promise.resolve(); await Promise.resolve()
    expect(x.container.querySelector('[data-file-id="5"]')).toBeNull()
    x.listeners.get('scope.changed')!()
    expect(x.container.querySelectorAll('.library-card')).toHaveLength(0)
    expect(x.container.textContent).toContain('权限已变化')
    x.view.destroy(); expect(x.listeners.size).toBe(0)
  })

  it('读取位置失败不覆盖旧位置，保存冲突仍可阅读', async () => {
    const x = setup(); x.storage.get.mockRejectedValueOnce(new Error('断网'))
    await x.view.render(); expect(x.storage.set).not.toHaveBeenCalled()
    expect(x.container.textContent).toContain('本次不覆盖已有位置')
    const y = setup(); y.storage.set.mockRejectedValueOnce(new Error('冲突'))
    await y.view.render()
    expect(y.container.querySelector('.library-card')).not.toBeNull()
    expect(y.container.textContent).toContain('未覆盖远端位置')
    y.page.mockResolvedValueOnce(result(2)); y.click('next')
    await vi.waitFor(() => expect(y.container.querySelector('[data-file-id="2"]')).not.toBeNull())
    expect(y.storage.set).toHaveBeenCalledTimes(1)
  })

  it('重复节点、重复游标与越界来源被拒绝，不保存无效页面', async () => {
    for (const invalid of [
      { ...result(1), entries: [entry(1), entry(1)] },
      { ...result(1), entries: [{ ...entry(1), source_ids: [999] }] },
      { ...result(1), entries: Array.from({ length: 41 }, (_, id) => entry(id + 1)) },
    ]) {
      const x = setup(); x.page.mockResolvedValueOnce(invalid)
      await x.view.render()
      expect(x.container.querySelector('.library-card')).toBeNull()
      expect(x.storage.set).not.toHaveBeenCalled()
      expect(x.context.reportError).toHaveBeenCalled()
    }
    const x = setup(); await x.view.render()
    x.click('next'); await vi.waitFor(() => expect(x.container.textContent).toContain('本页加载失败'))
    expect(x.storage.set).toHaveBeenCalledTimes(1)
  })
})
