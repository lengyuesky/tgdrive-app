import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComicReader, comicSpread } from './comic'
import { imageInfo } from '../reader/image'
import { PICTURE_COST_LIMIT, pictureCost } from '../reader/pictures'
import { defaults, type Preferences } from '../reader/state'
import { deferred, file, memoryDrive } from '../reader/library/test-fixtures'
import { png } from '../tests/browser/readers-fixtures.mjs'
import type { ViewContext } from '../reader/view'

// 保留真实 Range、预加载和图片头校验，只用受控尺寸替代 jsdom 不具备的图片解码/布局。
vi.mock('../reader/pictures', async importOriginal => ({ ...await importOriginal<typeof import('../reader/pictures')>(), PictureWindow: class {
  private active = new Map<HTMLImageElement, AbortController>()
  private ready = new Set<HTMLImageElement>()
  constructor(_viewport: HTMLElement, root: HTMLElement, private signal: AbortSignal,
    private read: (image: HTMLImageElement, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>,
    private error: (error: unknown) => void, private layout: (mutate: () => void) => void) { this.update(root) }
  update(root: HTMLElement) {
    for (const [image, controller] of this.active) if (!root.contains(image)) controller.abort()
    for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
      if (this.active.has(image) || this.ready.has(image)) continue
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.signal])
      this.active.set(image, controller)
      void this.read(image, signal).then(bytes => {
        signal.throwIfAborted(); const size = imageInfo(bytes)
        this.layout(() => {
          image.width = size.width; image.height = size.height
          Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: size.width }, naturalHeight: { configurable: true, value: size.height } })
        })
        this.ready.add(image); image.dispatchEvent(new Event('load'))
      }).catch(error => { if (!signal.aborted && error?.name !== 'AbortError') this.error(error) }).finally(() => this.active.delete(image))
    }
  }
  destroy() { this.active.forEach(controller => controller.abort()); this.active.clear(); this.ready.clear() }
} }))
const portrait = png(1000, 1500, [60, 100, 130]), wide = png(2000, 1000, [130, 80, 120])
const readers: ComicReader[] = []
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => { readers.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren(); vi.unstubAllGlobals() })
function fixture(options: { count?: number; prefs?: Partial<Preferences>; wide?: number[]; width?: number; height?: number } = {}) {
  const count = options.count ?? 8, folder = file(1, '/漫画', true), mock = memoryDrive([folder]), controller = new AbortController()
  for (let index = 0; index < count; index++) mock.binary(file(index + 2, `/漫画/${String(index + 1).padStart(3, '0')}.png`), options.wide?.includes(index) ? wide : portrait)
  const viewport = document.createElement('main'); document.body.append(viewport)
  let width = options.width ?? 1200, height = options.height ?? 700, scrollTop = 0, scrollLeft = 0
  const observers: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback) }; observe() {} unobserve() {} disconnect() {} })
  const figureHeight = (node: HTMLElement) => Math.max(parseFloat(node.style.minHeight) || 0, parseFloat(node.querySelector('img')?.style.height ?? '') || 0)
  const trackHeight = () => {
    const root = viewport.firstElementChild as HTMLElement | null
    if (!root) return 0
    if (root.dataset.mode !== 'scroll') return (parseFloat(root.style.height) || 0) + (parseFloat(root.style.marginTop) || 0)
    return [...root.children].reduce((sum, child) => sum + ((child as HTMLElement).classList.contains('comic-page') ? figureHeight(child as HTMLElement) : parseFloat((child as HTMLElement).style.height) || 0), 0)
  }
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
    scrollHeight: { get: () => Math.max(height, trackHeight()) },
    scrollWidth: { get: () => Math.max(width, parseFloat((viewport.firstElementChild as HTMLElement | null)?.style.width ?? '') || 0) },
    scrollTop: { get: () => Math.max(0, Math.min(scrollTop, viewport.scrollHeight - height)), set: (value: number) => { scrollTop = Math.max(0, Math.min(value, viewport.scrollHeight - height)) } },
    scrollLeft: { get: () => scrollLeft, set: (value: number) => { scrollLeft = Math.max(0, Math.min(value, viewport.scrollWidth - width)) } },
  })
  const rect = (left: number, top: number, width: number, height: number) => ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  const previousRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return rect(0, 0, width, height)
    const node = this.classList.contains('comic-page') ? this : this.closest<HTMLElement>('.comic-page')
    if (!node) return previousRect.call(this)
    const root = node.parentElement!, continuous = root.dataset.mode === 'scroll'
    let top = parseFloat(root.style.marginTop) || 0, left = Math.max(0, (width - (parseFloat(root.style.width) || width)) / 2)
    if (continuous) {
      for (const sibling of root.children) { if (sibling === node) break; top += sibling.classList.contains('comic-page') ? figureHeight(sibling as HTMLElement) : parseFloat((sibling as HTMLElement).style.height) || 0 }
    } else {
      const siblings = [...root.querySelectorAll<HTMLElement>('.comic-page')]
      if (root.style.flexDirection === 'row-reverse') siblings.reverse()
      for (const sibling of siblings) { if (sibling === node) break; left += parseFloat(sibling.style.width) || 0 }
    }
    const image = node.querySelector('img')!, h = this === node ? figureHeight(node) : parseFloat(image.style.height) || 0
    return rect(left - viewport.scrollLeft, top - viewport.scrollTop, parseFloat(image.style.width) || width, h)
  })
  const context: ViewContext = { drive: mock.drive, file: folder, signal: controller.signal, viewport,
    prefs: { ...defaults, mode: 'double', fit: 'page', ...options.prefs }, changed: vi.fn(), error: vi.fn() }
  const reader = new ComicReader(context); readers.push(reader)
  const mounted = () => [...viewport.querySelectorAll<HTMLElement>('.comic-page')].map(node => Number(node.dataset.index))
  const loaded = () => vi.waitFor(() => expect([...viewport.querySelectorAll('img')].every(image => image.naturalWidth > 0)).toBe(true))
  return { mock, reader, viewport, context, controller, mounted, loaded,
    resize: (w: number, h: number) => { width = w; height = h; observers.forEach(notify => notify()) },
  }
}
describe('漫画固定物理双页', () => {
  it.each([
    { coverAlone: true, spreadOffset: 0 as const, expected: [[0], [1, 2], [3, 4], [5, 6], [7]] },
    { coverAlone: true, spreadOffset: 1 as const, expected: [[0], [1], [2, 3], [4, 5], [6, 7]] },
    { coverAlone: false, spreadOffset: 0 as const, expected: [[0, 1], [2, 3], [4, 5], [6, 7]] },
    { coverAlone: false, spreadOffset: 1 as const, expected: [[0], [1, 2], [3, 4], [5, 6], [7]] },
  ])('封面 $coverAlone / offset $spreadOffset 前后往返不跳页', async ({ coverAlone, spreadOffset, expected }) => {
    const { reader, mounted, context } = fixture({ prefs: { coverAlone, spreadOffset } })
    await reader.open()
    for (const spread of expected) {
      expect(mounted()).toEqual(spread); expect(reader.navigationState().visiblePages).toEqual(spread)
      if (reader.navigationState().canNext) await reader.turn(1)
    }
    expect(reader.navigationState().canNext).toBe(false)
    await reader.turn(1); expect(mounted()).toEqual(expected.at(-1))
    for (let index = expected.length - 2; index >= 0; index--) { await reader.turn(-1); expect(mounted()).toEqual(expected[index]) }
    expect(reader.navigationState().canPrevious).toBe(false); expect(context.error).not.toHaveBeenCalled()
  })
  it.each([{ widePages: [1] }, { widePages: [2] }, { widePages: [1, 2] }, { widePages: [2, 3] }])('候选任一侧或连续宽图 $widePages 都独立，邻页不被跳过且后续奇偶不变', async ({ widePages }) => {
    const { reader, mounted, context } = fixture({ count: 6, wide: widePages })
    await reader.open()
    const visited: number[] = [], spreads: number[][] = []
    do {
      spreads.push(mounted()); visited.push(...mounted())
      if (!reader.navigationState().canNext) break
      await reader.turn(1)
    } while (true)
    expect(visited).toEqual([0, 1, 2, 3, 4, 5])
    for (const index of widePages) expect(spreads.find(spread => spread.includes(index))).toEqual([index])
    for (let i = spreads.length - 2; i >= 0; i--) { await reader.turn(-1); expect(mounted()).toEqual(spreads[i]) }
    expect(context.error).not.toHaveBeenCalled()
  })
  it('未知尺寸保守单页，不以猜测配对跳过物理页', () => {
    const sizes = new Map([[1, { width: 1000, height: 1500 }]])
    expect(comicSpread(1, 8, {}, sizes)).toEqual([1])
    sizes.set(2, { width: 1000, height: 1500 }); expect(comicSpread(2, 8, {}, sizes)).toEqual([1, 2])
    sizes.set(1, { width: 1500, height: 1000 }); expect(comicSpread(2, 8, {}, sizes)).toEqual([2])
  })
  it('双页复用实际像素预算，预算以下及恰好上限可配对，超过一行即分开', () => {
    const sizes = new Map([[1, { width: 4096, height: 4096 }], [2, { width: 4096, height: 4096 }]])
    expect(pictureCost(4096, 4096) * 2).toBe(PICTURE_COST_LIMIT)
    expect(comicSpread(2, 6, {}, sizes)).toEqual([1, 2])
    sizes.set(2, { width: 4095, height: 4096 }); expect(comicSpread(2, 6, {}, sizes)).toEqual([1, 2])
    sizes.set(2, { width: 4096, height: 4097 }); expect(comicSpread(2, 6, {}, sizes)).toEqual([2])
  })
  it('预算降级前后往返不漏页、不更改偏好和位置，换组或单页模式清除提示', async () => {
    const { mock, reader, context, mounted } = fixture({ count: 6 })
    const large = png(4096, 4097, [90, 120, 160])
    mock.binary(mock.nodes.get(3)!, large); mock.binary(mock.nodes.get(4)!, large)
    await reader.open({ format: 'comic', index: 2, ratio: .6 })
    expect(mounted()).toEqual([2]); expect(reader.current()).toMatchObject({ index: 2, entry: '4', ratio: .6 })
    expect(context.prefs.mode).toBe('double'); expect(reader.navigationState().layoutNotice).toContain('内存预算')
    const reads = mock.readRange.mock.calls.length
    await reader.configure({ ...context.prefs, mode: 'single' })
    expect(reader.current()).toMatchObject({ index: 2, ratio: .6 }); expect(reader.navigationState().layoutNotice).toBeUndefined()
    await reader.configure({ ...context.prefs, mode: 'double' })
    expect(reader.navigationState().layoutNotice).toContain('内存预算')
    expect(mock.readRange).toHaveBeenCalledTimes(reads)
    await reader.turn(1); expect(mounted()).toEqual([3, 4]); expect(reader.navigationState().layoutNotice).toBeUndefined()
    await reader.turn(-1); expect(mounted()).toEqual([2]); expect(reader.navigationState().layoutNotice).toContain('内存预算')
    await reader.turn(-1); expect(mounted()).toEqual([1])
    await reader.turn(-1); expect(mounted()).toEqual([0]); expect(reader.navigationState().layoutNotice).toBeUndefined()
    expect(context.error).not.toHaveBeenCalled()
  })
  it('RTL 只反转左右呈现；横竖屏与 offset 切换保留第二页的 index/entry/ratio', async () => {
    const { reader, context, viewport, mounted, resize } = fixture({ prefs: { direction: 'rtl' } })
    await reader.open({ format: 'comic', index: 2, ratio: .4 })
    const saved = reader.current()
    expect(saved).toMatchObject({ index: 2, entry: '4', ratio: .4 }); expect(mounted()).toEqual([1, 2])
    expect(viewport.querySelector<HTMLElement>('.comic-track')!.style.flexDirection).toBe('row-reverse')
    const left = viewport.querySelector<HTMLElement>('[data-index="2"]')!.getBoundingClientRect().left
    expect(left).toBeLessThan(viewport.querySelector<HTMLElement>('[data-index="1"]')!.getBoundingClientRect().left)
    resize(390, 844)
    await vi.waitFor(() => expect(reader.navigationState().effectiveMode).toBe('single'))
    expect(context.prefs.mode).toBe('double'); expect(reader.current()).toEqual(saved)
    resize(1200, 700)
    await vi.waitFor(() => expect(mounted()).toEqual([1, 2])); expect(reader.current()).toEqual(saved)
    await reader.configure({ ...context.prefs, spreadOffset: 1 })
    expect(mounted()).toEqual([2, 3]); expect(reader.current()).toEqual(saved)
    await reader.turn(1); expect(reader.current().index).toBe(4)
    await reader.turn(-1); expect(reader.current().index).toBe(3)
    await reader.restore(saved); expect(reader.current()).toEqual(saved)
    await reader.configure({ ...context.prefs, mode: 'page' }); expect(reader.navigationState().effectiveMode).toBe('single')
    expect(reader.current()).toEqual(saved)
  })
  it('跳到新物理页后，旧候选的迟到尺寸不能把 index/entry/ratio 拉回旧目标', async () => {
    const { mock, reader, context, mounted } = fixture({ count: 30, prefs: { mode: 'single' } })
    await reader.open({ format: 'comic', index: 29 })
    await reader.configure({ ...context.prefs, mode: 'double' })
    const original = mock.readRange.getMockImplementation()!, delayed = deferred(), started = deferred()
    mock.readRange.mockImplementation(async (ref, offset, length, options) => {
      if (ref.id === 3) { started.resolve(); await delayed.promise }
      return original(ref, offset, length, options)
    })
    const old = reader.restore({ format: 'comic', index: 2, ratio: .65 }), rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    await reader.restore({ format: 'comic', index: 21, ratio: .2 }); await rejected
    delayed.resolve(); await new Promise(resolve => setTimeout(resolve, 5))
    expect(mounted()).toEqual([21, 22]); expect(reader.current()).toMatchObject({ index: 21, entry: '23', ratio: .2 })
    expect(context.error).not.toHaveBeenCalled()
  })
  it('候选尺寸迟到与横屏请求被取消时，竖屏回退不等待旧请求也不改写目标', async () => {
    const { mock, reader, context, resize, mounted } = fixture({ prefs: { mode: 'single' } })
    // 在打开前就挂起第 2 页（id 3）的读取：头部探测与整图读取都会被卡住，
    // 模拟双页候选尺寸迟到的原始场景（探测通常会让尺寸提前到位）。
    const original = mock.readRange.getMockImplementation()!, delayed = deferred(), started = deferred()
    mock.readRange.mockImplementation(async (ref, offset, length, options) => {
      if (ref.id === 3) { started.resolve(); await delayed.promise }
      return original(ref, offset, length, options)
    })
    await reader.open({ format: 'comic', index: 10 })
    await reader.configure({ ...context.prefs, mode: 'double' })
    const pending = reader.restore({ format: 'comic', index: 2, ratio: .65 }), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    resize(390, 844)
    await vi.waitFor(() => expect(mounted()).toEqual([2]))
    expect(reader.current()).toMatchObject({ index: 2, entry: '4', ratio: .65 })
    await rejected; delayed.resolve(); await new Promise(resolve => setTimeout(resolve, 5))
    expect(reader.current()).toMatchObject({ index: 2, ratio: .65 }); expect(context.error).not.toHaveBeenCalled()
  })
})
describe('漫画适配、缩放与真实末端', () => {
  it('fitPage/fitWidth/zoom 使用当前视口，原生平移不误改物理页', async () => {
    const { reader, viewport, context, loaded } = fixture({ count: 3, width: 1000, height: 600, prefs: { mode: 'single', fit: 'page' } })
    await reader.open({ format: 'comic', index: 1 }); await loaded()
    const image = viewport.querySelector<HTMLImageElement>('img')!
    expect(parseFloat(image.style.height)).toBe(600); expect(parseFloat(image.style.width)).toBe(400)
    await reader.configure({ ...context.prefs, fit: 'width' })
    expect(parseFloat(image.style.height)).toBe(1500); expect(parseFloat(image.style.width)).toBe(1000)
    await reader.configure({ ...context.prefs, zoom: 2 })
    expect(parseFloat(image.style.height)).toBe(3000); expect(parseFloat(image.style.width)).toBe(2000)
    reader.pan(200, 300)
    expect(viewport.scrollLeft).toBe(200); expect(viewport.scrollTop).toBe(300)
    expect(reader.current()).toMatchObject({ index: 1, entry: '3' })
    expect(reader.navigationState().atEnd).toBe(false)
  })
  it('最后长图只有底部真正可见才完成，局部轨道底部不是全章末端', async () => {
    const { reader, viewport, loaded } = fixture({ count: 60, width: 1000, height: 600, prefs: { mode: 'scroll', fit: 'width' } })
    await reader.open({ format: 'comic', index: 30 }); await loaded()
    expect(viewport.querySelectorAll('.comic-page')).toHaveLength(5)
    viewport.scrollTop = viewport.scrollHeight
    expect(reader.navigationState().atEnd).toBe(false)
    await reader.go(59); await loaded()
    expect(reader.navigationState()).toMatchObject({ canNext: false, atEnd: false })
    reader.pan(0, 2000)
    expect(reader.navigationState().atEnd).toBe(true)
    expect(reader.current().index).toBe(59)
  })
  it('最后一组双页的末页可见即可显示显式完成，即使当前持久位置是组内第一页', async () => {
    const { reader, loaded } = fixture({ count: 5 })
    await reader.open({ format: 'comic', index: 3 }); await loaded()
    expect(reader.current().index).toBe(3)
    expect(reader.navigationState()).toMatchObject({ visiblePages: [3, 4], canNext: false, atEnd: true })
  })
})

function thumbnailImages(blocked = false) {
  const decoded: { onload: (() => void) | null; onerror: (() => void) | null; src: string; naturalWidth: number; naturalHeight: number }[] = []
  let sequence = 0
  const created = vi.fn(() => `blob:comic-${++sequence}`), released = vi.fn(), canvases: HTMLCanvasElement[] = []
  vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: released })
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null
    naturalWidth = 1000; naturalHeight = 1500
    private source = ''
    get src() { return this.source }
    set src(value: string) { this.source = value; decoded.push(this); if (!blocked) queueMicrotask(() => this.onload?.()) }
    removeAttribute() { this.source = '' }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { canvases.push(this); return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['缩略图'], { type: 'image/png' })))
  return { decoded, created, released, canvases }
}
describe('漫画独立可取消缩略图', () => {
  it('只读取请求页且最多两张解码，取消可见项释放槽位，不移动正文或预读中心', async () => {
    const { mock, reader, context, viewport, loaded } = fixture({ count: 30, prefs: { mode: 'single' } })
    await reader.open({ format: 'comic', index: 2, ratio: .3 }); await loaded()
    const saved = reader.current(), dom = viewport.innerHTML, images = thumbnailImages(true)
    mock.readRange.mockClear(); vi.mocked(context.changed).mockClear()
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const first = reader.thumbnail(20, controllers[0]!.signal), second = reader.thumbnail(21, controllers[1]!.signal), third = reader.thumbnail(22, controllers[2]!.signal)
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(images.decoded).toHaveLength(2))
    expect(mock.readRange.mock.calls.map(([ref]) => ref.id)).toEqual([22, 23])
    controllers[1]!.abort(); await rejected
    await vi.waitFor(() => expect(images.decoded).toHaveLength(3))
    images.decoded.forEach(image => image.onload?.())
    const result = await Promise.all([first, third])
    expect(result.every(image => image.width <= 320 && image.height <= 320)).toBe(true)
    expect(mock.readRange.mock.calls.map(([ref]) => ref.id)).toEqual([22, 23, 24])
    expect(reader.current()).toEqual(saved); expect(viewport.innerHTML).toBe(dom); expect(context.changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    expect(images.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(images.decoded.every(image => image.src === '')).toBe(true)
    result[0]!.release(); result[0]!.release(); reader.destroy()
    expect(images.released.mock.calls.map(([url]) => url).sort()).toEqual(images.created.mock.results.map(result => result.value).sort())
  })
  it('关闭阅读器会取消独立解码，迟到 load 不生成缩略图或 changed', async () => {
    const { reader, loaded, context } = fixture({ count: 30, prefs: { mode: 'single' } })
    await reader.open(); await loaded(); vi.mocked(context.changed).mockClear()
    const images = thumbnailImages(true), pending = reader.thumbnail(20, new AbortController().signal), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(images.decoded).toHaveLength(1))
    reader.destroy(); images.decoded[0]!.onload?.(); await rejected
    expect(images.created).toHaveBeenCalledTimes(1); expect(images.released).toHaveBeenCalledTimes(1)
    expect(context.changed).not.toHaveBeenCalled()
  })
  it('畸形头部和实际解码像素超限均拒绝，错误不污染正文位置', async () => {
    const { mock, reader, loaded } = fixture({ count: 30, prefs: { mode: 'single' } })
    await reader.open(); await loaded()
    const saved = reader.current(), images = thumbnailImages(true), broken = Buffer.from(portrait)
    broken.writeUInt32BE(100000, 16)
    mock.binary(mock.nodes.get(22)!, broken)
    await expect(reader.thumbnail(20, new AbortController().signal)).rejects.toThrow('像素')
    expect(images.created).not.toHaveBeenCalled()
    const pending = reader.thumbnail(21, new AbortController().signal), rejected = expect(pending).rejects.toThrow('像素上限')
    await vi.waitFor(() => expect(images.decoded).toHaveLength(1))
    images.decoded[0]!.naturalWidth = 65536; images.decoded[0]!.onload?.(); await rejected
    expect(images.released).toHaveBeenCalledTimes(1); expect(reader.current()).toEqual(saved)
  })
})
