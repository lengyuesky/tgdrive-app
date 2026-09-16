import { describe, expect, it, vi } from 'vitest'
import { ComicPreloader, type PreloadPage } from './preload'
import { deferred } from '../reader/library/test-fixtures'
import type { Archive } from '../reader/archive'
import type { Drive } from '../sdk/types'

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
