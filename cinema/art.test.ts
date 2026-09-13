import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry } from '../sdk/types'
import { ArtLoader, Library } from './library'
import { ReadScheduler } from './io'

let fileId = 100
const file = (id = fileId): FileEntry => ({ id, name: `第${id}集.mp4`, path: `/片库/第${id}集.mp4`, content_version: 'a'.repeat(64), size: 100, is_dir: false, favorite: false, created_at: 1, modified_at: 1 })
const images: HTMLImageElement[] = [], controllers: AbortController[] = []
const callbacks: IntersectionObserverCallback[] = []
const flush = () => vi.advanceTimersByTimeAsync(0)
async function loaded(index: number) { images[index]!.dispatchEvent(new Event('load')); await flush() }

function driveWithArt(local = false) {
  // 这里只验证尺寸头和加载生命周期，真实位图解码另由浏览器回归覆盖。
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71]); bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer); view.setUint32(16, 1); view.setUint32(20, 1)
  const cover = { ...file(900), name: 'poster.png', path: '/片库/poster.png', size: bytes.length }
  const list = vi.fn().mockResolvedValue({ entries: local ? [cover] : [], has_more: false, next_cursor: null })
  const stat = vi.fn(async ({ id }: { id: number }) => file(id))
  const url = vi.fn(async (video: FileEntry) => `https://example.com/thumbnail-${video.id}.jpg`)
  const readRange = vi.fn().mockResolvedValue(bytes)
  return { drive: { files: { list, stat, readRange }, media: { url } } as unknown as Drive, list, stat, url, readRange }
}
function observe(drive: Drive, thumbnailsOnly = true, video = file()) {
  const controller = new AbortController(); controllers.push(controller)
  const loader = new ArtLoader(drive, new Library(drive, '/片库'), new ReadScheduler(), controller.signal, thumbnailsOnly, ['/片库'])
  const target = document.createElement('div'), callback = callbacks.at(-1)!
  loader.observe(target, video)
  const visible = (isIntersecting: boolean) => callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
  return { loader, controller, target, visible }
}

beforeEach(() => {
  vi.useFakeTimers(); fileId++; images.length = 0; controllers.length = 0; callbacks.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback) }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:poster-${images.length}`)
    static revokeObjectURL = vi.fn()
  })
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) {
    this.setAttribute('src', value); images.push(this)
  })
})
afterEach(async () => {
  controllers.forEach(controller => controller.abort())
  await flush(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('影视封面滚动、缓存与取消', () => {
  it('本地封面滚出再滚回保留同一图片，离开页面才回收对象地址', async () => {
    const { drive, readRange } = driveWithArt(true), item = observe(drive, false)
    item.visible(true); await flush(); await loaded(0)
    const image = item.target.querySelector('img')!, src = image.src
    for (let i = 0; i < 3; i++) { item.visible(false); item.visible(true) }
    await flush()
    expect(item.target.querySelector('img')).toBe(image)
    expect(readRange).toHaveBeenCalledOnce(); expect(images).toHaveLength(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    item.controller.abort()
    expect(item.target.querySelector('img')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src)
  })

  it('快速划出再划入等待旧任务取消完毕，不同时启动同一卡片的新旧请求', async () => {
    const { drive, stat, url } = driveWithArt()
    let resolve!: (value: FileEntry) => void
    stat.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const item = observe(drive)
    item.visible(true); await flush()
    item.visible(false); item.visible(true); await flush()
    expect(stat).toHaveBeenCalledOnce()
    resolve(file()); await flush()
    expect(stat).toHaveBeenCalledTimes(2); expect(url).toHaveBeenCalledOnce()
    expect(images).toHaveLength(1)
    await loaded(0)
    expect(item.target.querySelectorAll('img')).toHaveLength(1)
  })

  it('缓存命中仍去重，并在直接清理加载器后禁止迟到的图片回填', async () => {
    const { drive, url } = driveWithArt(), first = observe(drive)
    first.visible(true); await flush(); await loaded(0)
    const second = observe(drive)
    second.visible(true); await flush()
    second.visible(true); await flush()
    expect(images).toHaveLength(2); expect(url).toHaveBeenCalledOnce()
    second.loader.clear()
    expect(images[1]!.hasAttribute('src')).toBe(false)
    await loaded(1)
    expect(second.target.querySelector('img')).toBeNull()
    const third = observe(drive)
    third.visible(true); await flush(); await loaded(2)
    expect(third.target.querySelector('img')).not.toBeNull()
    expect(url).toHaveBeenCalledOnce()
  })

  it('缓存命中时快速来回滚动只保留一张最终图片', async () => {
    const { drive, url } = driveWithArt(), first = observe(drive)
    first.visible(true); await flush(); await loaded(0)
    const second = observe(drive)
    second.visible(true); await flush()
    second.visible(false); second.visible(true); await flush()
    expect(images[1]!.hasAttribute('src')).toBe(false)
    expect(images).toHaveLength(3)
    await loaded(1); await loaded(2)
    expect(second.target.querySelectorAll('img')).toHaveLength(1)
    expect(second.target.querySelector('img')).toBe(images[2])
    expect(url).toHaveBeenCalledOnce()
  })

  it('失败或取消的首次加载不缓存签名地址，再次进入可以重新请求', async () => {
    const { drive, url } = driveWithArt(), first = observe(drive)
    first.visible(true); await flush()
    images[0]!.dispatchEvent(new Event('error')); await flush()
    const second = observe(drive)
    second.visible(true); await flush()
    expect(url).toHaveBeenCalledTimes(2)
    second.controller.abort(); await flush()
    const third = observe(drive)
    third.visible(true); await flush()
    expect(url).toHaveBeenCalledTimes(3)
    await loaded(2)
    expect(third.target.querySelector('img')).not.toBeNull()
  })

  it('本地封面缓存复用字节而非共享对象地址，一个页面退出不会损坏另一个页面', async () => {
    const { drive, readRange } = driveWithArt(true), first = observe(drive, false)
    first.visible(true); await flush(); await loaded(0)
    const second = observe(drive, false)
    second.visible(true); await flush(); await loaded(1)
    expect(readRange).toHaveBeenCalledOnce()
    expect(images[0]!.src).not.toBe(images[1]!.src)
    const firstSrc = images[0]!.src, secondSrc = images[1]!.src
    first.controller.abort()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstSrc)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(secondSrc)
    second.visible(false); second.visible(true); await flush()
    expect(second.target.querySelector('img')).toBe(images[1])
  })

  it('本地海报缓存不混入收藏历史的缩略图模式', async () => {
    const { drive, list, url } = driveWithArt(true), local = observe(drive, false)
    local.visible(true); await flush(); await loaded(0)
    const saved = observe(drive)
    saved.visible(true); await flush()
    expect(url).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledOnce()
    expect(images[1]!.src).toMatch(/^https:/)
    await loaded(1)
  })

  it('缓存不跨网盘会话复用，内容版本或路径变化后重新加载', async () => {
    const firstDrive = driveWithArt(), first = observe(firstDrive.drive)
    first.visible(true); await flush(); await loaded(0)
    const nextDrive = driveWithArt(), next = observe(nextDrive.drive)
    next.visible(true); await flush()
    expect(nextDrive.url).toHaveBeenCalledOnce(); await loaded(1)
    const changed = { ...file(), content_version: 'b'.repeat(64) }
    firstDrive.stat.mockResolvedValue(changed)
    const changedItem = observe(firstDrive.drive, true, changed)
    changedItem.visible(true); await flush(); await loaded(2)
    const renamed = { ...changed, path: '/片库/改名.mp4', name: '改名.mp4' }
    firstDrive.stat.mockResolvedValue(renamed)
    const renamedItem = observe(firstDrive.drive, true, renamed)
    renamedItem.visible(true); await flush()
    expect(firstDrive.url).toHaveBeenCalledTimes(3); await loaded(3)
  })
})
