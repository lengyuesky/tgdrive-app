import { expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive, FileEntry } from '../sdk/types'
import type { ReaderView } from './view'

it('最近阅读包含取材目录本身的图片章节，但不混入同名前缀的外部目录', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const chapter: FileEntry = { id: 2, name: '第一章', path: '/漫画/第一章', is_dir: true, size: 0, content_version: 'a', created_at: 1, modified_at: 1, favorite: false }
  const outside = { ...chapter, id: 3, name: '外部章节', path: '/漫画/第一章节外部' }
  const drive = {
    ready: Promise.resolve({ id: 'comics', name: '漫画', version: '1.0.0', api_version: 2, dark: false }),
    settings: { get: async () => ({ source_dir: chapter.path }) },
    storage: {
      get: async () => null,
      list: async () => ({ records: [chapter, outside].map((file) => ({ key: `progress:${file.id}`, revision: 'r', updated_at: 1, value: { file, title: file.name, location: { format: 'comic', index: 0 } } })), next_cursor: null }),
    },
    files: {
      list: async () => ({ entries: [], next_cursor: null }),
      stat: async ({ id }: { id: number }) => id === chapter.id ? chapter : outside,
    },
    on: () => () => {},
  } as unknown as Drive
  window.tgdrive = drive
  try {
    await startApp({ kind: 'comics', create: vi.fn() })
    document.getElementById('recent')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))
    expect(document.querySelector('#items button')?.getAttribute('data-file-id')).toBe(String(chapter.id))
    expect(document.getElementById('items')!.textContent).not.toContain('外部章节')
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

it('图书阅读设置中的字号与行距支持加减按钮精确调控与边界禁用', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  const bookFile: FileEntry = { id: 10, name: '示例文本.txt', path: '/示例文本.txt', is_dir: false, size: 1024, content_version: 'v1', created_at: 1, modified_at: 1, favorite: false }
  const configuredPrefs: any[] = []
  const mockView: ReaderView = {
    title: '示例文本',
    sections: [{ label: '第一节' }],
    open: vi.fn(async () => {}),
    current: () => ({ format: 'txt', index: 0 }),
    navigationState: () => ({ sectionIndex: 0, sectionCount: 1, canPrevious: false, canNext: false }),
    turn: vi.fn(async () => {}),
    go: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    configure: vi.fn(async (prefs) => { configuredPrefs.push({ ...prefs }) }),
    destroy: vi.fn(),
  }
  let savedStoragePref: any = null
  const drive = {
    ready: Promise.resolve({ id: 'books', name: '图书', version: '1.0.0', api_version: 2, dark: false }),
    settings: { get: async () => ({ source_dir: '/' }) },
    storage: {
      get: async (key: string) => key === 'preferences' && savedStoragePref ? { value: savedStoragePref, revision: 'r1' } : null,
      set: vi.fn(async (key: string, value: any) => {
        if (key === 'preferences') savedStoragePref = value
      }),
      list: async () => ({ records: [], next_cursor: null }),
    },
    files: {
      searchPage: async () => ({ results: [bookFile], next_cursor: null }),
      stat: async () => bookFile,
    },
    ui: {
      close: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
    },
    on: () => () => {},
  } as unknown as Drive
  window.tgdrive = drive
  try {
    await startApp({ kind: 'books', create: vi.fn(async () => mockView) })
    await vi.waitFor(() => expect(document.querySelectorAll('#items button')).toHaveLength(1))

    // 打开图书并等待阅读就绪
    document.querySelector<HTMLButtonElement>('#items button')!.click()
    await vi.waitFor(() => expect(document.getElementById('reading-status')?.textContent).toBe(''))

    const fontSizeInput = document.getElementById('font-size') as HTMLInputElement
    const fontSizeDec = document.getElementById('font-size-decrease') as HTMLButtonElement
    const fontSizeInc = document.getElementById('font-size-increase') as HTMLButtonElement

    const lineHeightInput = document.getElementById('line-height') as HTMLInputElement
    const lineHeightDec = document.getElementById('line-height-decrease') as HTMLButtonElement
    const lineHeightInc = document.getElementById('line-height-increase') as HTMLButtonElement

    // 默认字号为 18，加减按钮正常可用
    expect(fontSizeInput.value).toBe('18')
    expect(fontSizeDec.disabled).toBe(false)
    expect(fontSizeInc.disabled).toBe(false)

    // 点击增大字号按钮
    fontSizeInc.click()
    await vi.waitFor(() => expect(fontSizeInput.value).toBe('19'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(19))

    // 点击减小字号按钮
    fontSizeDec.click()
    await vi.waitFor(() => expect(fontSizeInput.value).toBe('18'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(18))

    // 默认行距为 1.8，加减按钮正常可用
    expect(lineHeightInput.value).toBe('1.8')
    expect(lineHeightDec.disabled).toBe(false)
    expect(lineHeightInc.disabled).toBe(false)

    // 点击增大行距按钮
    lineHeightInc.click()
    await vi.waitFor(() => expect(lineHeightInput.value).toBe('1.9'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.9))

    // 点击减小行距按钮
    lineHeightDec.click()
    await vi.waitFor(() => expect(lineHeightInput.value).toBe('1.8'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.8))

    // 滑块输入事件同步加减按钮的禁用状态（测试最小值与最大值边界）
    fontSizeInput.value = '12'
    fontSizeInput.dispatchEvent(new Event('input'))
    expect(fontSizeDec.disabled).toBe(true)
    expect(fontSizeInc.disabled).toBe(false)
    fontSizeInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(12))
    fontSizeDec.click()
    expect(fontSizeInput.value).toBe('12')

    fontSizeInput.value = '36'
    fontSizeInput.dispatchEvent(new Event('input'))
    expect(fontSizeDec.disabled).toBe(false)
    expect(fontSizeInc.disabled).toBe(true)
    fontSizeInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.fontSize).toBe(36))
    fontSizeInc.click()
    expect(fontSizeInput.value).toBe('36')

    lineHeightInput.value = '1.2'
    lineHeightInput.dispatchEvent(new Event('input'))
    expect(lineHeightDec.disabled).toBe(true)
    expect(lineHeightInc.disabled).toBe(false)
    lineHeightInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(1.2))
    lineHeightDec.click()
    expect(lineHeightInput.value).toBe('1.2')

    lineHeightInput.value = '2.8'
    lineHeightInput.dispatchEvent(new Event('input'))
    expect(lineHeightDec.disabled).toBe(false)
    expect(lineHeightInc.disabled).toBe(true)
    lineHeightInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(configuredPrefs.at(-1)?.lineHeight).toBe(2.8))
    lineHeightInc.click()
    expect(lineHeightInput.value).toBe('2.8')
  } finally {
    window.dispatchEvent(new Event('pagehide'))
    document.body.replaceChildren()
  }
})

