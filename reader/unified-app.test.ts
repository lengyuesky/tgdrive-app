import { afterEach, describe, expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive } from '../sdk/types'
import type { ReaderView, ViewContext } from './view'
import type { Location } from './state'
import { file, memoryDrive } from './library/test-fixtures'

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
})
