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
    expect(x.container.querySelector('img, svg')).toBeNull()
    expect(document.activeElement).toBe(x.button(`group:${x.groupId}`))
    await x.library.bookGroups.remove(x.groupId)
    x.nav.refreshLibraries(snapshot)
    expect(x.button(`group:${x.groupId}`)).toBeUndefined()
  })

  it('手机抽屉圈定焦点、阻止背景交互，ESC 和遮罩关闭后恢复焦点与原 inert 状态', async () => {
    const x = await setup('all', true)
    const trigger = x.container.querySelector<HTMLButtonElement>('#btn-mobile-libraries')!
    const content = document.querySelector<HTMLElement>('.ui-content')!
    const bottom = x.container.querySelector<HTMLElement>('.mobile-bottom-nav')!
    content.inert = false; bottom.inert = true
    trigger.focus(); trigger.click()
    expect(x.container.classList.contains('sidebar-open')).toBe(true)
    expect(x.container.querySelector('#library-sidebar')?.getAttribute('aria-modal')).toBe('true')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(content.inert).toBe(true)
    const elements = [...x.container.querySelectorAll<HTMLButtonElement>('#library-sidebar button')].filter(button => !button.disabled)
    const first = elements[0]!, last = elements.at(-1)!
    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(content.inert).toBe(false); expect(bottom.inert).toBe(true)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.click()
    x.container.querySelector<HTMLButtonElement>('#sidebar-backdrop')!.click()
    expect(x.container.classList.contains('sidebar-open')).toBe(false)
    expect(document.activeElement).toBe(trigger)
    trigger.click(); x.button('kind:comics').click()
    expect(x.container.classList.contains('sidebar-open')).toBe(false)
    expect(content.inert).toBe(false)
    expect(x.context.openLibrary).toHaveBeenCalledWith({ kind: 'comics' })
  })

  it('抽屉转到桌面和销毁都解除背景锁定，销毁后不再处理导航点击', async () => {
    const x = await setup('all', true)
    const trigger = x.container.querySelector<HTMLButtonElement>('#btn-mobile-libraries')!
    const content = document.querySelector<HTMLElement>('.ui-content')!
    content.inert = false
    trigger.click()
    x.media.matches = false
    x.media.addEventListener.mock.calls[0]![1]()
    expect(content.inert).toBe(false)
    expect(x.container.classList.contains('sidebar-open')).toBe(false)
    x.media.matches = true; trigger.click(); x.nav.destroy()
    expect(content.inert).toBe(false)
    x.button('kind:books').click()
    expect(x.context.openLibrary).not.toHaveBeenCalled()
    expect(x.media.removeEventListener).toHaveBeenCalled()
  })

  it('手机顶栏图标保留目录设置和返回网盘的无障碍名称与真实操作', async () => {
    const x = await setup('all', true)
    const settings = x.container.querySelector<HTMLButtonElement>('#btn-mobile-settings')!
    const close = x.container.querySelector<HTMLButtonElement>('#btn-mobile-close')!
    expect(settings.getAttribute('aria-label')).toBe('目录设置')
    expect(close.getAttribute('aria-label')).toBe('返回网盘')
    expect(settings.querySelector('.mobile-action-icon')?.getAttribute('aria-hidden')).toBe('true')
    settings.click(); close.click()
    expect(x.drive.settings.open).toHaveBeenCalledOnce()
    expect(x.context.closeApp).toHaveBeenCalledOnce()
    expect(x.context.reportError).not.toHaveBeenCalled()
  })

  it('切换失败通过统一错误入口报告，不产生未处理拒绝', async () => {
    const x = await setup()
    const error = new Error('来源暂时不可用')
    x.context.openLibrary.mockRejectedValueOnce(error)
    x.button('source:2').click()
    await vi.waitFor(() => expect(x.context.reportError).toHaveBeenCalledWith(error))
  })
})
