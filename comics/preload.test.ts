import { describe, expect, it, vi } from 'vitest'
import { ComicPreloader, type PreloadPage } from './preload'
import { deferred } from '../reader/library/test-fixtures'
import type { Archive } from '../reader/archive'
import type { Drive, FileEntry } from '../sdk/types'

describe('ComicPreloader', () => {
  const mockPages: PreloadPage[] = Array.from({ length: 20 }, (_, i) => ({
    name: `${i + 1}.png`,
    entry: `path/${i + 1}.png`,
  }))

  it('初始在第 0 页时，自动向后预加载 5 页且保持优先级', async () => {
    const loaded: number[] = []
    const archive = {
      read: vi.fn(async (entry: string) => {
        const pageIdx = mockPages.findIndex((p) => p.entry === entry)
        loaded.push(pageIdx)
        return new Uint8Array([pageIdx])
      }),
    } as any

    const preloader = new ComicPreloader({
      pages: mockPages,
      archive,
      drive: {} as any,
      signal: new AbortController().signal,
      ahead: 5,
      behind: 2,
      maxCache: 12,
      concurrency: 2,
    })

    preloader.setCenter(0)

    // 等待微任务与预加载完成
    await new Promise((r) => setTimeout(r, 60))

    // 0 到 5 页均被预加载
    for (let i = 0; i <= 5; i++) {
      expect(preloader.has(i)).toBe(true)
    }
    // 超过 5 的页面未被预加载
    expect(preloader.has(6)).toBe(false)
    expect(archive.read).toHaveBeenCalledTimes(6)

    // get 已预加载的页面，直接命中，不触发额外读取
    const data = await preloader.get(3)
    expect(data).toEqual(new Uint8Array([3]))
    expect(archive.read).toHaveBeenCalledTimes(6)

    preloader.destroy()
  })

  it('连续阅读向后翻页时，前序缓冲保留，后续新页面继续预读', async () => {
    const archive = {
      read: vi.fn(async (entry: string) => {
        const idx = mockPages.findIndex((p) => p.entry === entry)
        return new Uint8Array([idx])
      }),
    } as any

    const preloader = new ComicPreloader({
      pages: mockPages,
      archive,
      drive: {} as any,
      signal: new AbortController().signal,
      ahead: 5,
      behind: 2,
      maxCache: 12,
      concurrency: 2,
    })

    preloader.setCenter(0)
    await new Promise((r) => setTimeout(r, 60))

    // 读者翻到第 3 页
    preloader.setCenter(3)
    await new Promise((r) => setTimeout(r, 60))

    // 期望范围是 [1, 8] (center 3, behind 2 -> 1, ahead 5 -> 8)
    for (let i = 1; i <= 8; i++) {
      expect(preloader.has(i)).toBe(true)
    }

    preloader.destroy()
  })

  it('跳跃跳转时中止超出范围的任务并淘汰远离的缓存', async () => {
    const archive = {
      read: vi.fn(async (entry: string, _limit: number, signal: AbortSignal) => {
        signal.throwIfAborted()
        const idx = mockPages.findIndex((p) => p.entry === entry)
        return new Uint8Array([idx])
      }),
    } as any

    const preloader = new ComicPreloader({
      pages: mockPages,
      archive,
      drive: {} as any,
      signal: new AbortController().signal,
      ahead: 5,
      behind: 2,
      maxCache: 8,
      concurrency: 2,
    })

    preloader.setCenter(0)
    await new Promise((r) => setTimeout(r, 60))

    // 跳到第 15 页
    preloader.setCenter(15)
    await new Promise((r) => setTimeout(r, 60))

    // 此时第 15 附近应该被加载
    expect(preloader.has(15)).toBe(true)
    expect(preloader.has(16)).toBe(true)

    // 距离过远的第 0 页已被淘汰
    expect(preloader.has(0)).toBe(false)

    preloader.destroy()
  })

  it('destroy 立即中止所有任务并清空缓存', async () => {
    let aborted = false
    const archive = {
      read: vi.fn((_entry: string, _limit: number, signal: AbortSignal) => {
        return new Promise<Uint8Array>((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }),
    } as any

    const preloader = new ComicPreloader({
      pages: mockPages,
      archive,
      drive: {} as any,
      signal: new AbortController().signal,
      ahead: 5,
      behind: 2,
    })

    preloader.setCenter(0)
    preloader.destroy()

    expect(aborted).toBe(true)
    expect(preloader.has(0)).toBe(false)
  })

  it('首次 get 的调用者也能取消等待，不误杀其他读者共用的预读任务', async () => {
    const loaded = deferred<Uint8Array<ArrayBuffer>>(), caller = new AbortController(), read = vi.fn(() => loaded.promise)
    const preloader = new ComicPreloader({ pages: mockPages, archive: { read } as unknown as Archive, drive: {} as Drive, signal: new AbortController().signal, ahead: 0, behind: 0 })
    const pending = preloader.get(0, caller.signal), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const shared = preloader.get(0)
    caller.abort(); await rejected; loaded.resolve(new Uint8Array([9]))
    expect(await shared).toEqual(new Uint8Array([9])); expect(read).toHaveBeenCalledTimes(1); expect(preloader.has(0)).toBe(true)
    preloader.destroy()
    await expect(preloader.get(0)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('独立缩略图读取不改变预读中心和缓存，并沿调用信号中止下载', async () => {
    const read = vi.fn(async (entry: string, _limit: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (entry === mockPages[10]!.entry) return new Promise<Uint8Array<ArrayBuffer>>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return new Uint8Array([mockPages.findIndex(page => page.entry === entry)])
    })
    const preloader = new ComicPreloader({ pages: mockPages, archive: { read } as unknown as Archive, drive: {} as Drive, signal: new AbortController().signal, ahead: 0, behind: 0 })
    preloader.setCenter(0); await preloader.get(0)
    expect(await preloader.readIndependent(9, new AbortController().signal)).toEqual(new Uint8Array([9]))
    expect(preloader.has(9)).toBe(false); expect(preloader.has(0)).toBe(true)
    const caller = new AbortController(), pending = preloader.readIndependent(10, caller.signal), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort(); await rejected
    preloader.setCenter(1); await preloader.get(1)
    expect(read.mock.calls.map(([entry]) => entry)).toEqual([mockPages[0]!.entry, mockPages[9]!.entry, mockPages[10]!.entry, mockPages[1]!.entry])
    preloader.destroy()
  })

  it('跳走再回来的旧 finally 不删除同页新任务，不重复发起新读取', async () => {
    const waits: ReturnType<typeof deferred<Uint8Array<ArrayBuffer>>>[] = []
    const read = vi.fn(() => { const wait = deferred<Uint8Array<ArrayBuffer>>(); waits.push(wait); return wait.promise })
    const preloader = new ComicPreloader({ pages: mockPages, archive: { read } as unknown as Archive, drive: {} as Drive, signal: new AbortController().signal, ahead: 0, behind: 0, concurrency: 1 })
    preloader.setCenter(0); preloader.setCenter(10); preloader.setCenter(0)
    expect(read).toHaveBeenCalledTimes(3)
    waits[0]!.resolve(new Uint8Array([0])); waits[1]!.resolve(new Uint8Array([10]))
    await new Promise(resolve => setTimeout(resolve, 0))
    const current = preloader.get(0)
    expect(read).toHaveBeenCalledTimes(3)
    waits[2]!.resolve(new Uint8Array([99])); expect(await current).toEqual(new Uint8Array([99]))
    expect(preloader.has(0)).toBe(true); preloader.destroy()
  })
})

// —— 头部尺寸探测：只读页首小段字节解析真实宽高，跟随阅读中心 ——
const pngHead = (width: number, height: number) => {
  const head = new Uint8Array(24)
  head.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  head.set([0, 0, 0, 13, 73, 72, 68, 82], 8)
  new DataView(head.buffer).setUint32(16, width)
  new DataView(head.buffer).setUint32(20, height)
  return head
}

describe('ComicPreloader 头部尺寸探测', () => {
  const pages: PreloadPage[] = Array.from({ length: 40 }, (_, i) => ({ name: `${i + 1}.png`, entry: `p/${i}.png` }))

  it('压缩包页在预读窗口内经 readHead 探测，已缓存页免读，损坏页记空且不重试', async () => {
    const results: [number, { width: number; height: number } | null][] = []
    // readHead 只解压条目头部（快）；整图读取较慢：探测必须先于整图给出尺寸。
    const readHead = vi.fn(async (entry: string, headBytes: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 5))
      const index = Number(/\d+/.exec(entry)![0])
      return index === 8 ? new Uint8Array(64) : pngHead(400, 1000 + index)
    })
    const read = vi.fn(async (entry: string) => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return pngHead(400, 1000 + Number(/\d+/.exec(entry)![0]))
    })
    const archive = { read, readHead } as unknown as Archive
    const preloader = new ComicPreloader({
      pages, archive, drive: {} as Drive, signal: new AbortController().signal,
      ahead: 3, behind: 2, concurrency: 1,
      probe: { ring: 12, concurrency: 2, onDimensions: (index, size) => results.push([index, size]) },
    })
    preloader.setCenter(0)
    await new Promise(resolve => setTimeout(resolve, 120))
    // 压缩包探测环收窄到预读窗口 [0, 3]：只对窗口内页面解压头部、64 KiB 上限；
    // readHead 先于整图完成，页 0-3 尺寸在整图字节到齐前就已回调。
    expect(new Set(readHead.mock.calls.map(([entry]) => entry))).toEqual(new Set(['p/0.png', 'p/1.png', 'p/2.png', 'p/3.png']))
    expect(readHead.mock.calls.every(call => call[1] === 64 * 1024)).toBe(true)
    const reported = new Map(results)
    for (const index of [0, 1, 2, 3]) expect(reported.get(index)).toEqual({ width: 400, height: 1000 + index })
    // 中心移动到 12：窗口 [10, 15]；已探测页不重复，页 8 损坏头记 null 也不重试。
    results.length = 0
    readHead.mockClear()
    preloader.setCenter(10)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(new Set(readHead.mock.calls.map(([entry]) => entry))).toEqual(new Set(['p/8.png', 'p/9.png', 'p/10.png', 'p/11.png', 'p/12.png', 'p/13.png']))
    const late = new Map(results)
    expect(late.get(8)).toBeNull()
    for (const index of [9, 10, 11, 12, 13]) expect(late.get(index)).toEqual({ width: 400, height: 1000 + index })
    preloader.destroy()
  })

  it('目录页探测只请求每页开头少量字节，已缓存页直接从缓存解析尺寸', async () => {
    const results: [number, { width: number; height: number } | null][] = []
    const filePages: PreloadPage[] = Array.from({ length: 20 }, (_, i) => ({
      name: `${i + 1}.png`, entry: String(i), file: { id: i + 1, content_version: 'a'.repeat(64), size: 1024 * 1024 } as FileEntry,
    }))
    const full = new Uint8Array(1024 * 1024); full.set(pngHead(400, 2010), 0)
    const readRange = vi.fn(async (ref: { id: number }, offset: number, length: number) => {
      expect(offset).toBe(0)
      // 整图读取（1 MiB）立即返回可解析图片；头部探测（64 KiB）稍有延迟，给缓存留出光争窗口。
      if (length > 64 * 1024) return full
      await new Promise(resolve => setTimeout(resolve, 5))
      return pngHead(400, 3000 + (ref.id - 1))
    })
    const drive = { files: { readRange } } as unknown as Drive
    const preloader = new ComicPreloader({
      pages: filePages, drive, signal: new AbortController().signal,
      ahead: 2, behind: 2, concurrency: 2,
      probe: { ring: 3, concurrency: 1, onDimensions: (index, size) => results.push([index, size]) },
    })
    preloader.setCenter(10)
    await new Promise(resolve => setTimeout(resolve, 80))
    const heads = readRange.mock.calls.filter(([, , length]) => length <= 64 * 1024)
    // 环 [7, 13]：中心页探测先于整图完成，走 64 KiB 头部；已被整图预读缓存的
    // 页（8～12）直接从缓存字节解析，不再重复发头部请求；环外两页走头部。
    expect(new Set(heads.map(([ref]) => String((ref as { id: number }).id - 1)))).toEqual(new Set(['7', '10', '13']))
    expect(heads.every(([, , length]) => length === 64 * 1024)).toBe(true)
    const reported = new Map(results)
    expect(reported.get(10)).toEqual({ width: 400, height: 3010 })
    expect(reported.get(13)).toEqual({ width: 400, height: 3013 })
    for (const index of [8, 9, 11, 12]) expect(reported.get(index)).toEqual({ width: 400, height: 2010 })
    preloader.destroy()
  })

  it('目录页探测失败有限重试后回退为无尺寸，中止的任务不缓存可再探测', async () => {
    const results: [number, { width: number; height: number } | null][] = []
    let attempts = 0
    const filePages: PreloadPage[] = Array.from({ length: 6 }, (_, i) => ({
      name: `${i + 1}.png`, entry: String(i), file: { id: i + 1, content_version: 'a'.repeat(64), size: 1024 * 1024 } as FileEntry,
    }))
    const readRange = vi.fn(async (_ref: unknown, _offset: number, length: number) => {
      if (length <= 64 * 1024) attempts++
      throw new Error('网络抖动')
    })
    const drive = { files: { readRange } } as unknown as Drive
    const preloader = new ComicPreloader({
      pages: filePages, drive, signal: new AbortController().signal,
      ahead: 0, behind: 0, concurrency: 1,
      probe: { ring: 2, concurrency: 1, onDimensions: (index, size) => results.push([index, size]) },
    })
    preloader.setCenter(0)
    await new Promise(resolve => setTimeout(resolve, 700))
    // 每页最多 3 次尝试，仍失败则记 null；不会无限重试。
    expect(attempts).toBe(9)
    expect(results).toEqual([[0, null], [1, null], [2, null]])
    preloader.destroy()
  })
})
