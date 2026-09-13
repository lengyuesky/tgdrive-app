import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sortCoverCandidates, detectDirectoryCover, ComicCoverLoader } from './cover'
import type { Drive, FileEntry } from '../sdk/types'

describe('漫画封面提取与候选排序', () => {
  it('优先选择包含 cover/poster/封面的图片，其次选择第 1 页，最后自然序兜底', () => {
    const list = [
      '第10页.jpg',
      '002.png',
      'cover.jpg',
      '001.png',
      '020.jpg',
      '003.png',
    ]
    const sorted = sortCoverCandidates(list)
    expect(sorted[0]).toBe('cover.jpg')
    expect(sorted[1]).toBe('001.png')
    expect(sorted[2]).toBe('002.png')
    expect(sorted[3]).toBe('003.png')
    expect(sorted[4]).toBe('020.jpg')
    expect(sorted[5]).toBe('第10页.jpg')
  })

  it('多级路径时根据末尾文件名判断', () => {
    const list = [
      'chapter1/02.jpg',
      'chapter1/01.jpg',
      'chapter1/poster.png',
    ]
    const sorted = sortCoverCandidates(list)
    expect(sorted[0]).toBe('chapter1/poster.png')
    expect(sorted[1]).toBe('chapter1/01.jpg')
    expect(sorted[2]).toBe('chapter1/02.jpg')
  })
})

describe('目录智能封面探测 detectDirectoryCover', () => {
  const dir: FileEntry = {
    id: 1,
    name: '漫画合集',
    path: '/漫画合集',
    is_dir: true,
    size: 0,
    content_version: 'v1',
    created_at: 0,
    modified_at: 0,
    favorite: false,
  }

  it('当前目录包含直属图片时，优先生成封面缩略图', async () => {
    const img1: FileEntry = {
      id: 10,
      name: '002.jpg',
      path: '/漫画合集/002.jpg',
      is_dir: false,
      size: 100,
      content_version: 'v_img1',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }
    const coverImg: FileEntry = {
      id: 11,
      name: 'cover.jpg',
      path: '/漫画合集/cover.jpg',
      is_dir: false,
      size: 100,
      content_version: 'v_cover',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const drive = {
      files: {
        list: vi.fn(async () => ({
          entries: [img1, coverImg],
          next_cursor: null,
          has_more: false,
          path: dir.path,
        })),
      },
      media: {
        url: vi.fn(async (ref: { id: number }) => `/api/media/${ref.id}`),
      },
    } as unknown as Drive

    const url = await detectDirectoryCover(drive, dir, new AbortController().signal)
    expect(url).toBe('/api/media/11')
    expect(drive.media.url).toHaveBeenCalledWith(
      { id: 11, content_version: 'v_cover' },
      'thumbnail',
    )
  })

  it('当前目录无图片但有子目录时，自动向下探测首个子目录的图片', async () => {
    const subDir: FileEntry = {
      id: 2,
      name: '第01话',
      path: '/漫画合集/第01话',
      is_dir: true,
      size: 0,
      content_version: 'v_sub',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }
    const subImg: FileEntry = {
      id: 21,
      name: '01.png',
      path: '/漫画合集/第01话/01.png',
      is_dir: false,
      size: 200,
      content_version: 'v_p1',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const drive = {
      files: {
        list: vi.fn(async ({ path }: { path: string }) => {
          if (path === dir.path) {
            return { entries: [subDir], next_cursor: null, has_more: false, path }
          }
          if (path === subDir.path) {
            return { entries: [subImg], next_cursor: null, has_more: false, path }
          }
          return { entries: [], next_cursor: null, has_more: false, path }
        }),
      },
      media: {
        url: vi.fn(async (ref: { id: number }) => `/api/media/${ref.id}`),
      },
    } as unknown as Drive

    const url = await detectDirectoryCover(drive, dir, new AbortController().signal)
    expect(url).toBe('/api/media/21')
    expect(drive.files.list).toHaveBeenCalledTimes(2)
  })
})

describe('ComicCoverLoader 懒加载与缓存调度', () => {
  let intersectCallback: (entries: { target: HTMLElement; isIntersecting: boolean }[]) => void

  beforeEach(() => {
    // 模拟 IntersectionObserver
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (entries: { target: HTMLElement; isIntersecting: boolean }[]) => void) {
        intersectCallback = cb
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('卡片进入视口时触发加载，加载完成将图片展示并添加 has-cover 类名', async () => {
    const file: FileEntry = {
      id: 99,
      name: 'cover.jpg',
      path: '/cover.jpg',
      is_dir: false,
      size: 100,
      content_version: 'v99',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const drive = {
      media: {
        url: vi.fn(async () => '/thumbnail/99.jpg'),
      },
    } as unknown as Drive

    const loader = new ComicCoverLoader(drive, new AbortController().signal)
    const container = document.createElement('div')
    document.body.append(container)

    loader.observe(container, file)
    expect(container.style.backgroundImage).toBe('')

    // 触发进入视口
    intersectCallback([{ target: container, isIntersecting: true }])

    await vi.waitFor(() => {
      expect(container.style.backgroundImage).toContain('/thumbnail/99.jpg')
    })
    expect(container.classList.contains('has-cover')).toBe(true)

    // 再次 observe 同一文件，直接同步应用缓存
    const container2 = document.createElement('div')
    loader.observe(container2, file)
    expect(container2.style.backgroundImage).toContain('/thumbnail/99.jpg')
    expect(container2.classList.contains('has-cover')).toBe(true)

    loader.destroy()
    container.remove()
    container2.remove()
  })

  it('优先从 drive.storage 应用缓存中读取封面数据，无需重新请求媒体或探测', async () => {
    const file: FileEntry = {
      id: 101,
      name: '第1卷.cbz',
      path: '/第1卷.cbz',
      is_dir: false,
      size: 1000,
      content_version: 'v_cbz_1',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const storageRecord = {
      key: 'cover:101',
      value: {
        version: 'v_cbz_1',
        url: 'data:image/webp;base64,mockCoverData',
      },
      revision: 'rev1',
      updated_at: 1,
    }

    const drive = {
      storage: {
        get: vi.fn(async () => storageRecord),
        set: vi.fn(),
      },
      media: {
        url: vi.fn(),
      },
      files: {
        list: vi.fn(),
      },
    } as unknown as Drive

    const loader = new ComicCoverLoader(drive, new AbortController().signal)
    const container = document.createElement('div')
    document.body.append(container)

    loader.observe(container, file)
    intersectCallback([{ target: container, isIntersecting: true }])

    await vi.waitFor(() => {
      expect(container.style.backgroundImage).toContain('data:image/webp;base64,mockCoverData')
    })
    expect(container.classList.contains('has-cover')).toBe(true)
    expect(drive.storage.get).toHaveBeenCalledWith('cover:101', expect.anything())
    expect(drive.media.url).not.toHaveBeenCalled()

    loader.destroy()
    container.remove()
  })

  it('直属图片缩略图调用失败时，自动降级回退到 preview 预览图', async () => {
    const dir: FileEntry = {
      id: 200,
      name: '漫画目录',
      path: '/漫画目录',
      is_dir: true,
      size: 0,
      content_version: 'v_dir',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const img: FileEntry = {
      id: 201,
      name: 'cover.jpg',
      path: '/漫画目录/cover.jpg',
      is_dir: false,
      size: 500,
      content_version: 'v_img',
      created_at: 0,
      modified_at: 0,
      favorite: false,
    }

    const drive = {
      storage: {
        get: vi.fn(async () => null),
        set: vi.fn(),
      },
      files: {
        list: vi.fn(async () => ({
          entries: [img],
          next_cursor: null,
          has_more: false,
          path: dir.path,
        })),
      },
      media: {
        url: vi.fn(async (_ref, kind) => {
          if (kind === 'thumbnail') throw new Error('404 Not Found')
          return '/preview/201.jpg'
        }),
      },
    } as unknown as Drive

    const loader = new ComicCoverLoader(drive, new AbortController().signal)
    const container = document.createElement('div')
    document.body.append(container)

    loader.observe(container, dir)
    intersectCallback([{ target: container, isIntersecting: true }])

    await vi.waitFor(() => {
      expect(container.style.backgroundImage).toContain('/preview/201.jpg')
    })
    expect(drive.media.url).toHaveBeenCalledWith(
      { id: 201, content_version: 'v_img' },
      'thumbnail',
    )
    expect(drive.media.url).toHaveBeenCalledWith(
      { id: 201, content_version: 'v_img' },
      'preview',
    )

    loader.destroy()
    container.remove()
  })
})
