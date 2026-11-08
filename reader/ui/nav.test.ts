import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingLibrary } from '../library'
import { file, memoryDrive, sources } from '../library/test-fixtures'
import { NavManager } from './nav'
import type { UiContext } from './types'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function setup(kind: UiContext['kind'] = 'all', mobile = false) {
  document.body.innerHTML = '<div class="app-ui-layout"><div id="nav"></div><main class="ui-content"></main></div>'
  const media = { matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  const root = file(1, '/阅读', true), other = file(2, '/资料', true)
  const mock = memoryDrive([root, other, file(10, '/阅读/文字.txt'), file(11, '/资料/漫画.cbz')])
  mock.seed('library:sources', sources(root, other).config)
  const library = new ReadingLibrary(mock.drive, kind)
  await library.initialize()
  await library.bookGroups.load()
  const groupId = await library.bookGroups.create('小说')
  const context = {
    drive: mock.drive, library, kind, signal: new AbortController().signal,
    openReader: vi.fn(async () => {}), openDetail: vi.fn(), switchView: vi.fn(),
    openLibrary: vi.fn(async () => {}), reportError: vi.fn(), createReader: vi.fn(), closeApp: vi.fn(async () => {}),
  } satisfies UiContext
  const container = document.getElementById('nav')!
  const nav = new NavManager(container, context)
  cleanups.push(() => library.destroy(), () => nav.destroy())
  const button = (id: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-library-id]')]
    .find(element => element.dataset.libraryId === id)!
  return { ...mock, library, context, container, nav, media, button, groupId }
}

describe('阅读馆书库侧边栏', () => {
  it('内容类型、格式、真实来源和分组分别传递筛选，全部书库显式清空选择', async () => {
    const x = await setup()
    for (const [id, selection] of [
      ['kind:books', { kind: 'books' }], ['kind:comics', { kind: 'comics' }],
      ['format:pdf', { kind: 'books', format: 'pdf' }], ['format:images', { kind: 'comics', format: 'images' }],
      ['source:2', { sourceId: 2 }], [`group:${x.groupId}`, { groupId: x.groupId }],
    ] as const) {
      x.button(id).click()
      expect(x.context.openLibrary).toHaveBeenLastCalledWith(selection)
    }
    x.container.querySelector<HTMLButtonElement>('#nav-library')!.click()
    expect(x.context.openLibrary).toHaveBeenLastCalledWith({})
    x.container.querySelector<HTMLButtonElement>('#nav-home')!.click()
    expect(x.context.switchView).toHaveBeenCalledWith('home')
    expect(x.context.reportError).not.toHaveBeenCalled()
  })

  it.each(['books', 'comics'] as const)('%s 兼容入口只显示自身支持的内容类型与格式', async kind => {
    const x = await setup(kind)
    expect(x.button(`kind:${kind}`)).toBeDefined()
    expect(x.button(kind === 'books' ? 'kind:comics' : 'kind:books')).toBeUndefined()
    expect(x.button('format:pdf') !== undefined).toBe(kind === 'books')
    expect(x.button('format:images') !== undefined).toBe(kind === 'comics')
    expect(x.button(`group:${x.groupId}`) !== undefined).toBe(kind === 'books')
  })

  it('筛选高亮跟随书库状态，刷新未变化时保留 DOM，动态名称只按纯文本显示', async () => {
    const x = await setup()
    x.nav.setActive('library')
    x.nav.setLibrarySelection({ kind: 'comics' })
    expect(x.button('kind:comics').getAttribute('aria-current')).toBe('page')
    expect(x.container.querySelector('#nav-library')?.classList.contains('active')).toBe(false)
    const original = x.button('source:2')
    x.nav.refreshLibraries()
    expect(x.button('source:2')).toBe(original)
    const malicious = '<img src=x onerror=bad()>'
    await x.library.bookGroups.rename(x.groupId, malicious)
    x.button(`group:${x.groupId}`).focus()
    const snapshot = x.library.snapshot
    snapshot.sources.config.sources[1]!.path = '/' + malicious
    x.nav.refreshLibraries(snapshot)
    expect(x.button(`group:${x.groupId}`).textContent).toContain(malicious)
    expect(x.button('source:2').title).toBe('/' + malicious)
    expect(x.container.querySelector('img')).toBeNull()
    expect(x.container.querySelector('[data-library-id] svg')).toBeNull()
    expect(document.activeElement).toBe(x.button(`group:${x.groupId}`))
    await x.library.bookGroups.remove(x.groupId)
    x.nav.refreshLibraries(snapshot)
    expect(x.button(`group:${x.groupId}`)).toBeUndefined()
  })

  it('手机不再有抽屉：顶栏只留标题和搜索，书库页横滑筛选与侧栏同一份入口并同步高亮', async () => {
    const x = await setup('all', true)
    expect(x.container.querySelector('#btn-mobile-libraries, #sidebar-backdrop, #btn-mobile-settings, #btn-mobile-close')).toBeNull()
    expect([...x.container.querySelectorAll('.mobile-header button')].map(button => button.id)).toEqual(['btn-mobile-search'])
    const chips = x.container.querySelector<HTMLElement>('#mobile-library-chips')!
    expect(chips.hidden).toBe(true)
    x.nav.setActive('library')
    expect(chips.hidden).toBe(false)
    const ids = [...chips.querySelectorAll<HTMLButtonElement>('[data-library-id]')].map(button => button.dataset.libraryId)
    expect(ids).toEqual([...x.container.querySelectorAll<HTMLButtonElement>('#library-sidebar [data-library-id]')].map(button => button.dataset.libraryId))
    const all = chips.querySelector<HTMLButtonElement>('#chip-library-all')!
    expect(all.getAttribute('aria-current')).toBe('page')
    chips.querySelector<HTMLButtonElement>('[data-library-id="kind:comics"]')!.click()
    expect(x.context.openLibrary).toHaveBeenLastCalledWith({ kind: 'comics' })
    x.nav.setLibrarySelection({ kind: 'comics' })
    expect(chips.querySelector('[data-library-id="kind:comics"]')!.getAttribute('aria-current')).toBe('page')
    expect(all.hasAttribute('aria-current')).toBe(false)
    all.click()
    expect(x.context.openLibrary).toHaveBeenLastCalledWith({})
    x.nav.setActive('me')
    expect(chips.hidden).toBe(true)
    expect(x.context.reportError).not.toHaveBeenCalled()
  })

  it('手机搜索进入书库并聚焦搜索框，销毁后不再处理导航点击', async () => {
    const x = await setup('all', true)
    const field = document.createElement('input'); field.id = 'library-search'
    vi.mocked(x.context.openLibrary).mockImplementation(async () => { document.body.append(field) })
    x.nav.setLibrarySelection({ sourceId: 2 })
    x.container.querySelector<HTMLButtonElement>('#btn-mobile-search')!.click()
    await vi.waitFor(() => expect(document.activeElement).toBe(field))
    expect(x.context.openLibrary).toHaveBeenCalledWith({ sourceId: 2 })
    x.nav.destroy()
    x.button('kind:books').click()
    expect(x.context.openLibrary).toHaveBeenCalledTimes(1)
  })

  it('切换失败通过统一错误入口报告，不产生未处理拒绝', async () => {
    const x = await setup()
    const error = new Error('来源暂时不可用')
    x.context.openLibrary.mockRejectedValueOnce(error)
    x.button('source:2').click()
    await vi.waitFor(() => expect(x.context.reportError).toHaveBeenCalledWith(error))
  })
})
