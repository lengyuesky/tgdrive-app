import { expect, it, vi } from 'vitest'
import { startApp } from './app'
import type { Drive, FileEntry } from '../sdk/types'

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
