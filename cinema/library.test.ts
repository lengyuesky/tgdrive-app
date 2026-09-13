import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry } from '../sdk/types'
import { ArtLoader, Library } from './library'
import { ReadScheduler } from './io'

type FilePage = Awaited<ReturnType<Drive['files']['list']>>
type ListParams = Parameters<Drive['files']['list']>[0]

const file = (id: number): FileEntry => ({ id, name: `第${id}集.mp4`, path: `/片库/第${id}集.mp4`, content_version: 'a'.repeat(64), size: 100, is_dir: false, favorite: false, created_at: 1, modified_at: 1 })
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const page = (entries: FileEntry[], more = false): FilePage => ({ path: '/片库', entries, has_more: more, next_cursor: more ? 'next' : null })
afterEach(() => vi.useRealTimers())

describe('影视目录分页与异步缓存', () => {
  it('完整目录超过 2000 条仍逐页读取，保留服务器游标', async () => {
    vi.useFakeTimers()
    const list = vi.fn(async ({ cursor, limit = 200 }: ListParams) => {
      const start = Number(cursor ?? 0), end = Math.min(2010, start + limit)
      return { entries: Array.from({ length: end - start }, (_, i) => file(start + i + 1)), has_more: end < 2010, next_cursor: end < 2010 ? String(end) : null }
    })
    const library = new Library({ files: { list } } as unknown as Drive, '/片库')
    const result = library.directory('/片库', signal(), true)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ complete: true, files: expect.any(Array) })
    expect((await result).files).toHaveLength(2010)
    expect(list).toHaveBeenCalledTimes(11)
    expect(list.mock.calls.every(([params]) => params.limit === 200)).toBe(true)
    expect(list.mock.calls[10][0].cursor).toBe('2000')
  })

  it('超过 10000 条停止整理，并明确标记选集不完整', async () => {
    vi.useFakeTimers()
    const list = vi.fn(async ({ cursor, limit = 200 }: ListParams) => {
      const start = Number(cursor ?? 0)
      return { entries: Array.from({ length: limit }, (_, i) => file(start + i + 1)), has_more: true, next_cursor: String(start + limit) }
    })
    const library = new Library({ files: { list } } as unknown as Drive, '/片库')
    const result = library.directory('/片库', signal(), true)
    await vi.runAllTimersAsync()
    expect((await result).files).toHaveLength(10000)
    expect((await result).complete).toBe(false)
    expect(list).toHaveBeenCalledTimes(50)
  })

  it('迟到的封面第一页不覆盖已整理完成的完整目录', async () => {
    const preview = deferred<FilePage>(), complete = deferred<FilePage>()
    const list = vi.fn().mockReturnValueOnce(preview.promise).mockReturnValueOnce(complete.promise)
    const library = new Library({ files: { list } } as unknown as Drive, '/片库')
    const partial = library.directory('/片库', signal())
    const full = library.directory('/片库', signal(), true)
    complete.resolve(page([file(1), file(2)])); await full
    preview.resolve(page([file(1)], true)); await partial
    expect(await library.directory('/片库', signal())).toEqual({ files: [file(1), file(2)], complete: true })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('刷新后旧请求不能回填缓存或清除新请求的去重状态', async () => {
    const old = deferred<FilePage>(), fresh = deferred<FilePage>()
    const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const library = new Library({ files: { list } } as unknown as Drive, '/片库')
    const previous = library.directory('/片库', signal())
    library.clear()
    const current = library.directory('/片库', signal())
    old.resolve(page([file(1)])); await previous
    const shared = library.directory('/片库', signal())
    fresh.resolve(page([file(2)]))
    expect((await current).files).toEqual([file(2)])
    expect((await shared).files).toEqual([file(2)])
    expect((await library.directory('/片库', signal())).files).toEqual([file(2)])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('没有媒体库范围时不枚举，切换范围后不能读取旧目录缓存', async () => {
    const list = vi.fn().mockResolvedValue(page([file(1)]))
    const library = new Library({ files: { list } } as unknown as Drive)
    await expect(library.directory('/', signal())).rejects.toThrow('当前媒体库')
    expect(list).not.toHaveBeenCalled()
    library.setScope('/片库'); await library.directory('/片库', signal())
    library.setScope('/电视剧')
    await expect(library.directory('/片库', signal())).rejects.toThrow('当前媒体库')
    expect(list).toHaveBeenCalledTimes(1)
    library.setScope(null)
    await expect(library.directory('/电视剧', signal())).rejects.toThrow('当前媒体库')
  })

  it('收藏历史的缩略图模式不枚举父目录或读取本地封面', async () => {
    let intersect!: IntersectionObserverCallback
    const previous = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    const list = vi.fn(), stat = vi.fn().mockResolvedValue(file(1)), url = vi.fn().mockRejectedValue(new Error('无缩略图'))
    const drive = { files: { list, stat }, media: { url } } as unknown as Drive
    const controller = new AbortController(), loader = new ArtLoader(drive, new Library(drive), new ReadScheduler(), controller.signal, true, ['/片库'])
    try {
      const target = document.createElement('div'); loader.observe(target, file(1))
      intersect([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      await vi.waitFor(() => expect(url).toHaveBeenCalledWith(file(1), 'thumbnail'))
      expect(list).not.toHaveBeenCalled()
      expect(stat).toHaveBeenCalledWith({ id: 1 }, { signal: expect.any(AbortSignal) })
    } finally { controller.abort(); globalThis.IntersectionObserver = previous }
  })

  it('排队的缩略图在签发前发现文件移出范围时不请求媒体', async () => {
    vi.useFakeTimers()
    let intersect!: IntersectionObserverCallback
    const previous = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    const stat = vi.fn().mockResolvedValue({ ...file(1), path: '/片库外/第1集.mp4' }), url = vi.fn()
    const drive = { files: { stat }, media: { url } } as unknown as Drive
    const controller = new AbortController(), loader = new ArtLoader(drive, new Library(drive), new ReadScheduler(), controller.signal, true, ['/片库'])
    try {
      const target = document.createElement('div'); loader.observe(target, file(1))
      intersect([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      await vi.runAllTimersAsync()
      expect(stat).toHaveBeenCalledOnce(); expect(url).not.toHaveBeenCalled()
    } finally { controller.abort(); globalThis.IntersectionObserver = previous }
  })

  it('海报加载完成后滑出视口再滑回视口，图片保留在 DOM 中且不再重复发起网络请求', async () => {
    let intersect!: IntersectionObserverCallback
    const previous = globalThis.IntersectionObserver
    const originalSrc = Object.getOwnPropertyDescriptor(globalThis.HTMLImageElement.prototype, 'src')
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    Object.defineProperty(globalThis.HTMLImageElement.prototype, 'src', {
      set(v: string) {
        originalSrc?.set?.call(this, v)
        setTimeout(() => this.onload?.(new Event('load')), 0)
      },
      get() {
        return originalSrc?.get?.call(this) ?? ''
      },
      configurable: true,
    })
    const stat = vi.fn().mockResolvedValue(file(1))
    const url = vi.fn().mockResolvedValue('https://example.com/poster1.jpg')
    const drive = { files: { stat, list: vi.fn() }, media: { url } } as unknown as Drive
    const controller = new AbortController()
    const loader = new ArtLoader(drive, new Library(drive), new ReadScheduler(), controller.signal, true, ['/片库'])

    try {
      const target = document.createElement('div')
      loader.observe(target, file(1))

      // 首次进入视口
      intersect([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      await vi.waitFor(() => expect(target.querySelector('img')).not.toBeNull())
      expect(url).toHaveBeenCalledTimes(1)
      const img = target.querySelector('img')!
      expect(img.src).toBe('https://example.com/poster1.jpg')

      // 滑出视口
      intersect([{ target, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      // 断言图片仍然保留，没有被粗暴拔除
      expect(target.querySelector('img')).toBe(img)

      // 再次滑入视口
      intersect([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      // 断言没有再次调用 url，图片依然是之前的实例
      expect(url).toHaveBeenCalledTimes(1)
      expect(target.querySelector('img')).toBe(img)
    } finally {
      controller.abort()
      globalThis.IntersectionObserver = previous
      if (originalSrc) {
        Object.defineProperty(globalThis.HTMLImageElement.prototype, 'src', originalSrc)
      }
    }
  })
})
