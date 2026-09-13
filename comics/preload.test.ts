import { describe, expect, it, vi } from 'vitest'
import { ComicPreloader, type PreloadPage } from './preload'

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
})
