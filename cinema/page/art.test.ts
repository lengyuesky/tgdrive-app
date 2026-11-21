import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtLoader } from './library'
import { fixture, json } from './test-fixture'
import type { CinemaClient } from './client'

const images: HTMLImageElement[] = [], controllers: AbortController[] = [], callbacks: IntersectionObserverCallback[] = []
let sequence = 0
beforeEach(() => {
  images.length = 0; controllers.length = 0; callbacks.length = 0
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { callbacks.push(callback) } observe() {} disconnect() {} })
  const Original = URL
  vi.stubGlobal('URL', class extends Original { static createObjectURL = vi.fn(() => `blob:poster-${++sequence}`); static revokeObjectURL = vi.fn() })
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) { this.setAttribute('src', value); images.push(this) })
})
afterEach(() => { controllers.splice(0).forEach(controller => controller.abort()); vi.unstubAllGlobals() })
async function setup() {
  const state = { key: 'cover-1', missing: false }
  const result = await fixture(async () => { await result.host.stat({ by: 'id', id: '3' }); return json({ key: state.missing ? null : state.key }) })
  const file = await result.host.stat({ by: 'id', id: '3' })
  await result.host.cachePut(state.key, new Blob(['poster'], { type: 'image/jpeg' }), 'image/jpeg', { metadata: null, sources: [{ id: file.id, content_version: file.content_version! }] })
  const get = vi.spyOn(result.host, 'cacheGet'), cover = vi.spyOn(result.cinema, 'cover')
  return { ...result, state, file, get, cover }
}
function observe(cinema: CinemaClient, file: Awaited<ReturnType<typeof setup>>['file']) {
  const controller = new AbortController(); controllers.push(controller)
  const loader = new ArtLoader(cinema, controller.signal), target = document.createElement('div'), callback = callbacks.at(-1)!
  loader.observe(target, file)
  const visible = (isIntersecting: boolean) => callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
  return { loader, target, controller, visible }
}
async function started(index: number) { await vi.waitFor(() => expect(images.length).toBeGreaterThan(index)) }
async function loaded(index: number, target: HTMLElement) { images[index].dispatchEvent(new Event('load')); await vi.waitFor(() => expect(target.querySelector('img')).toBe(images[index])) }

describe('影视封面滚动、共享缓存与取消', () => {
  it('由后端选择封面，页面直读宿主缓存，不枚举目录或下载视频', async () => {
    const test = await setup(), list = vi.spyOn(test.host, 'list'), media = vi.spyOn(test.host, 'mediaUrl'), item = observe(test.cinema, test.file)
    item.visible(true); await started(0); await loaded(0, item.target)
    expect(test.cover).toHaveBeenCalledOnce(); expect(test.get).toHaveBeenCalledWith('cover-1', { signal: expect.any(AbortSignal) })
    expect(list).not.toHaveBeenCalled(); expect(media).not.toHaveBeenCalled()
  })
  it('图片加载和异步解码完成后才挂载，解码期间退出不会回填旧页面', async () => {
    const test = await setup(), item = observe(test.cinema, test.file)
    item.visible(true); await started(0)
    let finish!: () => void
    images[0].decode = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    images[0].dispatchEvent(new Event('load')); await vi.waitFor(() => expect(images[0].decode).toHaveBeenCalledOnce())
    expect(item.target.querySelector('img')).toBeNull(); item.controller.abort()
    await vi.waitFor(() => expect(images[0].hasAttribute('src')).toBe(false)); finish()
    expect(item.target.querySelector('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })
  it('滑出再滑回保留同一图片和地址，离开页面才回收', async () => {
    const test = await setup(), item = observe(test.cinema, test.file)
    item.visible(true); await started(0); await loaded(0, item.target)
    const image = images[0], url = image.src
    for (let index = 0; index < 3; index++) { item.visible(false); item.visible(true) }
    expect(item.target.querySelector('img')).toBe(image); expect(test.get).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    item.controller.abort(); expect(item.target.querySelector('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  })
  it('同一卡片快速来回滚动不会并行启动新旧请求，取消后的可见卡片可重新加载', async () => {
    const test = await setup()
    let release!: (value: { key: string | null }) => void
    test.cover.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const item = observe(test.cinema, test.file)
    item.visible(true); await vi.waitFor(() => expect(test.cover).toHaveBeenCalledOnce()); item.visible(false); item.visible(true)
    expect(test.cover).toHaveBeenCalledOnce(); release({ key: 'cover-1' })
    await started(0); await loaded(0, item.target); expect(test.cover).toHaveBeenCalledTimes(2); expect(item.target.querySelectorAll('img')).toHaveLength(1)
  })
  it('同一会话复用封面字节，但每个页面独占对象地址，关闭一个不损坏另一个', async () => {
    const test = await setup(), first = observe(test.cinema, test.file)
    first.visible(true); await started(0); await loaded(0, first.target)
    const second = observe(test.cinema, test.file); second.visible(true); await started(1); await loaded(1, second.target)
    expect(test.get).toHaveBeenCalledOnce(); expect(test.cover).toHaveBeenCalledTimes(2); expect(images[0].src).not.toBe(images[1].src)
    const next = images[1].src; first.controller.abort(); expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(next)
    expect(second.target.querySelector('img')).toBe(images[1])
  })
  it('内存命中也重新核对权限，撤权后不会继续显示缓存封面', async () => {
    const test = await setup(), first = observe(test.cinema, test.file)
    first.visible(true); await started(0); await loaded(0, first.target)
    await test.host.setScope({ mode: 'none' })
    const second = observe(test.cinema, test.file); second.visible(true)
    await vi.waitFor(() => expect(test.cover).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(second.target.querySelector('img')).toBeNull(); expect(images).toHaveLength(1)
  })
  it('失败或取消的首次图片不会保存到内存，再进入仍可读取', async () => {
    const test = await setup(), first = observe(test.cinema, test.file)
    first.visible(true); await started(0); images[0].dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(images[0].hasAttribute('src')).toBe(false))
    const second = observe(test.cinema, test.file); second.visible(true); await started(1); await loaded(1, second.target)
    expect(test.get).toHaveBeenCalledTimes(2)
  })
  it('直接清理加载器禁止迟到回填，重复可见通知不会重复请求', async () => {
    const test = await setup(), item = observe(test.cinema, test.file)
    item.visible(true); item.visible(true); await started(0); expect(test.cover).toHaveBeenCalledOnce()
    item.loader.clear(); images[0].dispatchEvent(new Event('load'))
    expect(item.target.querySelector('img')).toBeNull(); expect(images[0].hasAttribute('src')).toBe(false)
  })
  it('后端还未生成封面时保持占位，不在页面复制压缩或截帧任务', async () => {
    const test = await setup(); test.state.missing = true
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob'), item = observe(test.cinema, test.file)
    item.visible(true); await vi.waitFor(() => expect(test.cover).toHaveBeenCalledOnce())
    expect(test.get).not.toHaveBeenCalled(); expect(encode).not.toHaveBeenCalled(); expect(item.target.querySelector('img')).toBeNull()
  })
  it('后端封面身份变化会读取新缓存，不混用旧来源', async () => {
    const test = await setup(), first = observe(test.cinema, test.file)
    first.visible(true); await started(0); await loaded(0, first.target)
    test.state.key = 'cover-2'; await test.host.cachePut('cover-2', new Blob(['new-poster'], { type: 'image/png' }), 'image/png')
    const second = observe(test.cinema, test.file); second.visible(true); await started(1); await loaded(1, second.target)
    expect(test.get).toHaveBeenCalledTimes(2); expect(test.get).toHaveBeenLastCalledWith('cover-2', { signal: expect.any(AbortSignal) })
  })
})
// 页面 WebP/JPEG 编码、同目录海报扫描和跨会话持久化已移到后端；backend/tests/media.rs、persons.rs 覆盖来源、限额、缓存和撤销。
