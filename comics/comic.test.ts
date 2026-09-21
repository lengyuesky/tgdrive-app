import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComicReader } from './comic'
import { defaults } from '../reader/state'
import type { ViewContext } from '../reader/view'
import type { Drive, FileEntry } from '../sdk/types'

// 只隔离资源下载与解码，使用真实阅读器处理滚动、换窗和尺寸变化。
vi.mock('./preload', () => ({ ComicPreloader: class {
  constructor(options: { probe?: { onDimensions?: (index: number, size: { width: number; height: number } | null) => void } }) { preloaderHooks.options = options }
  setCenter() {} destroy() {}
} }))
const pictureHooks = vi.hoisted(() => ({
  update: (_root: HTMLElement) => {},
  layout: (_mutate: () => void) => {},
}))
const preloaderHooks = vi.hoisted(() => ({ options: null as { probe?: { onDimensions?: (index: number, size: { width: number; height: number } | null) => void } } | null }))
vi.mock('../reader/pictures', async importOriginal => ({ ...await importOriginal<typeof import('../reader/pictures')>(), PictureWindow: class {
  constructor(_viewport: HTMLElement, root: HTMLElement, _signal: AbortSignal, _read: unknown, _error: unknown, layout: (mutate: () => void) => void) {
    pictureHooks.layout = layout; pictureHooks.update(root)
  }
  update(root: HTMLElement) { pictureHooks.update(root) }
  destroy() {}
} }))

const readers: ComicReader[] = []
afterEach(() => {
  readers.forEach((reader) => reader.destroy()); readers.length = 0
  vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren()
})

function fixture(count = 1500, initialHeight = 1450, autoLoad = true, entrySizes?: number[]) {
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0
  const observers: (() => void)[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.push(callback) }
    observe() {} unobserve() {} disconnect() {}
  })
  const viewport = document.createElement('main'); document.body.append(viewport)
  let pageHeight = initialHeight, width = 1000, height = 600, scroll = 0
  const pageHeights = new Map<number, number>(), unloaded = new Set<number>()
  const scrollWrites: number[] = []
  const figureHeight = (node: HTMLElement) => Math.max(parseFloat(node.style.minHeight) || 0,
    node.querySelector('img')?.hasAttribute('width') ? pageHeights.get(Number(node.dataset.index)) ?? pageHeight : width * 1.45)
  const setDimensions = (image: HTMLImageElement, index: number) => {
    image.width = 1000; image.height = pageHeights.get(index) ?? pageHeight
  }
  pictureHooks.update = (root) => {
    if (autoLoad) for (const image of root.querySelectorAll('img')) {
      const index = Number(image.dataset.resource)
      if (!unloaded.has(index)) setDimensions(image, index)
    }
  }
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = originalRect.call(this)
    return this.classList.contains('comic-page') ? { ...rect, height: figureHeight(this) } : rect
  })
  // 模拟浏览器的 CSS 高度上限和布局缩短时对 scrollTop 的即时截断。
  const cssLimit = 33_554_428
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
    scrollHeight: { get: () => Math.max(height, Math.min(cssLimit, [...(viewport.firstElementChild?.children ?? [])].reduce((sum, child) => {
      const node = child as HTMLElement
      return sum + Math.min(cssLimit, node.classList.contains('comic-page') ? figureHeight(node) : parseFloat(node.style.height) || 0)
    }, 0))) },
    scrollTop: {
      get: () => { scroll = Math.max(0, Math.min(scroll, viewport.scrollHeight - height)); return scroll },
      set: (value: number) => { scrollWrites.push(value); scroll = Math.max(0, Math.min(value, viewport.scrollHeight - height)) },
    },
  })
  const file: FileEntry = { id: 1, name: '长漫画', path: '/长漫画', is_dir: true, size: 0, content_version: 'a'.repeat(64), created_at: 1, modified_at: 1, favorite: false }
  const entries = Array.from({ length: count }, (_, index) => ({ ...file, id: index + 2, name: `${index + 1}.png`, is_dir: false, size: entrySizes?.[index] ?? 0 }))
  const context: ViewContext = {
    drive: { files: { list: vi.fn(async () => ({ entries, next_cursor: null })) } } as unknown as Drive,
    file, viewport, signal: new AbortController().signal, prefs: { ...defaults, mode: 'scroll' }, changed: vi.fn(), error: vi.fn(),
  }
  const reader = new ComicReader(context); readers.push(reader)
  const draw = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) }
  async function finish(operation: Promise<void>) {
    let finished = false
    void operation.then(() => { finished = true }, () => { finished = true })
    await vi.waitFor(() => { draw(); expect(finished).toBe(true) }, { interval: 1 })
    await operation
  }
  async function scrollBy(delta: number) {
    viewport.scrollTop += delta; viewport.dispatchEvent(new Event('scroll'))
    draw(); await Promise.resolve(); draw(); await Promise.resolve()
  }
  return { reader, viewport, context, finish, scrollBy, pageHeights, scrollWrites, unloaded, draw, frames,
    loadPages: (sizes: [number, number][]) => pictureHooks.layout(() => {
      for (const [index, height] of sizes) {
        pageHeights.set(index, height)
        const image = viewport.querySelector<HTMLImageElement>(`img[data-resource="${index}"]`)
        if (image) setDimensions(image, index)
      }
    }),
    // 头部探测：同步告知未加载页的真实尺寸（图片宽固定 1000）。
    probe: (sizes: [number, number][]) => {
      for (const [index, height] of sizes) pageHeights.set(index, height)
      for (const [index, height] of sizes) preloaderHooks.options?.probe?.onDimensions?.(index, { width: 1000, height })
      draw()
    },
    measure: () => observers.forEach((notify) => notify()),
    resize: (nextWidth: number, nextHeight: number) => { width = nextWidth; height = nextHeight; observers.forEach((notify) => notify()) },
  }
}

describe('长漫画滚动定位', () => {
  it('未加载页高度按每页字节比例估算，短页不再把长条页估成矮页', async () => {
    // 条漫合集常见结构：开头几张短卡，其后全是长条页；每页字节与像素量成正比。
    const sizes = Array.from({ length: 60 }, (_, index) => (index < 4 ? 100_000 : 1_000_000))
    const made = fixture(60, 1450, false, sizes)
    const { reader, viewport, loadPages, measure } = made
    await made.finish(reader.open({ format: 'comic', index: 0 }))
    // 只加载开头三张短卡（真实高 1000、每页 10 万字节）：平面中位数会学到 1000
    // 并套给所有未加载页，把后面的长条页全估成矮页。
    loadPages([[0, 1000], [1, 1000], [2, 1000]])
    measure()
    const heights = (reader as unknown as { heights: number[] }).heights
    // 长条页（100 万字节）估高应按字节比例 ≈ 10_000，而不是被短卡中位数带成 1000。
    expect(Math.abs(heights[50]! - 10_000)).toBeLessThanOrEqual(200)
    expect(Math.abs(heights[10]! - 10_000)).toBeLessThanOrEqual(200)
    // 短卡字节小、估高相应小；已加载页保留真实高。
    expect(Math.abs(heights[3]! - 1000)).toBeLessThanOrEqual(200)
    expect(heights[0]).toBe(1000)
    // 长条页占位进入轨道求和：跨过三张短卡与短卡估高（页 3）后，索引按真实
    // 内容推进——32_500 = 前 6 页累计 24_000 + 8_500，落在第 7 张长条页内。
    viewport.scrollTop = 32_500
    viewport.dispatchEvent(new Event('scroll'))
    made.draw()
    expect((reader as unknown as { current(): { index: number } }).current().index).toBe(6)
  })

  it('普通跨页只更新挂载窗口，不重写原生滚动坐标', async () => {
    const { reader, finish, scrollBy, scrollWrites } = fixture(1000, 1000)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .4 }))
    scrollWrites.length = 0
    for (let step = 0; step < 6; step++) await scrollBy(1000)
    expect(reader.current()).toMatchObject({ index: 455, ratio: .4 })
    // 每次只有用户输入的一次写入，不能在跨页时追加 scrollTop 赋值打断惯性。
    expect(scrollWrites).toHaveLength(6)
  })

  it('快速向上回看多页不会被错误纠偏拉回原页', async () => {
    const { reader, finish, scrollBy } = fixture(1000, 1000)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .4 }))
    await scrollBy(-6000)
    expect(reader.current().index).toBeLessThan(446)
  })

  it('末张长图滚动到底部后保留页内进度，不重置为图片顶部', async () => {
    const { reader, finish, scrollBy } = fixture(5, 1000)
    await finish(reader.open({ format: 'comic', index: 4 }))
    await scrollBy(400)
    expect(reader.current()).toMatchObject({ index: 4, ratio: .4 })
  })

  it('当前页迟到的长图即使在停止滑动后加载，也保留像素偏移而非放大页内比例', async () => {
    const { reader, finish, scrollBy, loadPages, scrollWrites } = fixture(100, 1450, false)
    await finish(reader.open({ format: 'comic', index: 5 }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await scrollBy(500)
    await vi.advanceTimersByTimeAsync(300)
    scrollWrites.length = 0
    loadPages([[5, 12_000]])
    expect(reader.current().index).toBe(5)
    expect((reader.current().ratio ?? 0) * 12_000).toBeCloseTo(500)
    // 首个样本让上方未知页学到长图页高，只需一次坐标补偿把当前页留在原处；页内像素偏移不能按比例放大。
    expect(scrollWrites).toEqual([5 * 12_000 + 500])
  })

  it('滑动时上方图片缩短造成浏览器截断坐标，仍恢复修改前的当前页像素位置', async () => {
    const { reader, finish, scrollBy, loadPages } = fixture(100, 1000)
    await finish(reader.open({ format: 'comic', index: 98, ratio: .4 }))
    await scrollBy(200)
    loadPages([[96, 100], [97, 100], [99, 100]])
    expect(reader.current()).toMatchObject({ index: 98, ratio: .6 })
  })

  it('长图移出挂载窗口再回看时复用已知尺寸，不回退成普通比例占位', async () => {
    const { reader, viewport, finish, loadPages } = fixture(1000, 1450, false)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .4 }))
    loadPages([[449, 12_000]])
    await finish(reader.go(470))
    expect(viewport.querySelector('.comic-page[data-index="449"]')).toBeNull()
    await finish(reader.restore({ format: 'comic', index: 449, ratio: .5 }))
    const image = viewport.querySelector<HTMLImageElement>('img[data-resource="449"]')!
    expect(image.getAttribute('height')).toBe('12000')
    expect(image.style.aspectRatio).toBe('1000 / 12000')
    expect(image.style.height).toBe('12000px')
    expect(reader.current()).toMatchObject({ index: 449, ratio: .5 })
  })

  it('未知末页暂时无法滚到已保存的位置时，等待真实尺寸再恢复进度', async () => {
    const { reader, finish, loadPages } = fixture(100, 1450, false)
    await finish(reader.open({ format: 'comic', index: 99, ratio: .8 }))
    expect(reader.current()).toMatchObject({ index: 99, ratio: .8 })
    loadPages([[99, 12_000]])
    expect(reader.current()).toMatchObject({ index: 99, ratio: .8 })
  })

  it('同一页内的连续滚动合并进度通知，关闭后取消待执行帧和通知', async () => {
    const { reader, viewport, context, finish, scrollBy, draw, frames } = fixture(100, 1000)
    await finish(reader.open())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.mocked(context.changed).mockClear()
    for (let i = 0; i < 20; i++) await scrollBy(20)
    expect(context.changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120)
    expect(context.changed).toHaveBeenCalledTimes(1)
    await scrollBy(20)
    viewport.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBeGreaterThan(0)
    reader.destroy(); draw(); await vi.advanceTimersByTimeAsync(120)
    expect(frames.size).toBe(0)
    expect(context.changed).toHaveBeenCalledTimes(1)
  })

  it('四百多页的超长条漫不受整本 CSS 高度上限影响，双向滚动只推进相邻页', async () => {
    const { reader, viewport, finish, scrollBy } = fixture(1500, 100_000)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .4 }))
    expect(reader.current()).toMatchObject({ index: 449, ratio: .4 })
    expect(viewport.scrollHeight).toBeLessThanOrEqual(41 * 100_000)
    expect(viewport.querySelectorAll('.comic-page')).toHaveLength(5)
    for (let index = 450; index < 460; index++) {
      await scrollBy(100_000)
      expect(reader.current()).toMatchObject({ index, ratio: .4 })
      expect(viewport.scrollHeight).toBeLessThanOrEqual(41 * 100_000)
    }
    for (let index = 458; index >= 449; index--) {
      await scrollBy(-100_000)
      expect(reader.current()).toMatchObject({ index, ratio: .4 })
    }
  })

  it('多次越过局部轨道边界后双向阅读位置不漂移', async () => {
    const { reader, finish, scrollBy } = fixture(1500, 12_000)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .35 }))
    for (let index = 450; index <= 520; index++) {
      await scrollBy(12_000)
      expect(reader.current()).toMatchObject({ index, ratio: .35 })
    }
    for (let index = 519; index >= 449; index--) {
      await scrollBy(-12_000)
      expect(reader.current()).toMatchObject({ index, ratio: .35 })
    }
  })

  it('多页短图都已有尺寸时，在高视口中提前续接轨道，不困在局部底部', async () => {
    const { reader, finish, scrollBy, resize } = fixture(1000, 180)
    await finish(reader.open({ format: 'comic', index: 429 }))
    for (let index = 432; index <= 470; index += 3) await finish(reader.go(index))
    resize(1000, 1200)
    await finish(reader.restore({ format: 'comic', index: 449, ratio: .4 }))
    for (let index = 450; index <= 470; index++) {
      await scrollBy(180)
      expect(reader.current()).toMatchObject({ index, ratio: .4 })
    }
  })

  it('占位高度大幅缩短时仍保留当前页和页内位置，不叠加已被截断的 scrollTop', async () => {
    const { reader, finish, loadPages } = fixture(1500, 1450, false)
    await finish(reader.open({ format: 'comic', index: 1498, ratio: .4 }))
    loadPages([[1496, 300], [1497, 300], [1498, 300], [1499, 300]])
    expect(reader.current()).toMatchObject({ index: 1498, ratio: .4 })
  })

  it('相邻图片高度不同且延迟重排时不改变阅读锚点', async () => {
    const { reader, finish, loadPages } = fixture(1500, 1450, false)
    await finish(reader.open({ format: 'comic', index: 449, ratio: .6 }))
    loadPages([[447, 4000], [448, 300], [449, 700]])
    expect(reader.current()).toMatchObject({ index: 449, ratio: .6 })
  })

  it('局部轨道底部不是全书末页，继续滚动后仍能换窗', async () => {
    const { reader, viewport, finish, scrollBy } = fixture()
    await finish(reader.open({ format: 'comic', index: 449 }))
    await scrollBy(viewport.scrollHeight)
    const index = reader.current().index
    expect(index).toBeGreaterThan(449)
    expect(index).toBeLessThanOrEqual(469)
    expect(reader.navigationState().canNext).toBe(true)
    await scrollBy(1450)
    expect(reader.current().index).toBe(index + 1)
  })

  it('跳页、恢复、模式切换和视口变化仍使用全书逻辑页码', async () => {
    const { reader, context, finish, resize } = fixture()
    await finish(reader.open())
    await finish(reader.go(1099))
    expect(reader.navigationState()).toMatchObject({ pageIndex: 1099, pageCount: 1500 })
    await finish(reader.restore({ format: 'comic', index: 449, ratio: .3 }))
    const saved = reader.current()
    resize(600, 720)
    expect(reader.current()).toMatchObject({ index: 449, ratio: .3 })
    await finish(reader.configure({ ...context.prefs, mode: 'page' }))
    expect(reader.current().index).toBe(449)
    await finish(reader.turn(1))
    expect(reader.current().index).toBe(450)
    await finish(reader.configure({ ...context.prefs, mode: 'scroll' }))
    expect(reader.current().index).toBe(450)
    await finish(reader.restore({ ...saved, index: 0 }))
    expect(reader.current()).toMatchObject({ index: 449, ratio: .3 })
  })

  it('真实末页短于视口仍可定位，上一页不会误判为末页', async () => {
    const { reader, viewport, finish } = fixture(1500, 300)
    await finish(reader.open())
    await finish(reader.go(1498))
    expect(reader.current().index).toBe(1498)
    await finish(reader.turn(1))
    expect(reader.current().index).toBe(1499)
    expect(reader.navigationState().canNext).toBe(false)
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight)
    await finish(reader.turn(-1))
    expect(reader.current().index).toBe(1498)
  })

  it('连续小步滚动跨页时阅读进度单调推进，视口不发生回弹或乱跳', async () => {
    const { reader, viewport, finish, scrollBy } = fixture(100, 1000)
    await finish(reader.open({ format: 'comic', index: 0, ratio: 0 }))
    let lastPosition = -1
    const step = 200
    // 连续小步滚动 25 次，跨越 5 页（每页 1000px）
    for (let i = 0; i < 25; i++) {
      await scrollBy(step)
      const loc = reader.current()
      const globalPos = loc.index * 1000 + (loc.ratio ?? 0) * 1000
      expect(globalPos).toBeGreaterThan(lastPosition)
      lastPosition = globalPos
    }
    expect(reader.current().index).toBe(5)
  })

  it('滚动期间图片延迟加载并测出不同高度时，视口不发生大幅回跳', async () => {
    const { reader, viewport, finish, scrollBy, pageHeights, measure } = fixture(100, 1000)
    await finish(reader.open({ format: 'comic', index: 5, ratio: 0 }))
    // 正在滚动中进入第 6 页
    await scrollBy(500)
    const posBefore = reader.current()
    expect(posBefore.index).toBe(5)
    // 此时第 6 页（下方页面）加载出长图并触发测量
    pageHeights.set(6, 2500)
    measure()
    const posAfter = reader.current()
    // 正在进行的阅读位置与比例不受下方图片加载的影响
    expect(posAfter.index).toBe(posBefore.index)
    expect(Math.abs((posAfter.ratio ?? 0) - (posBefore.ratio ?? 0))).toBeLessThan(0.01)
  })

  it('未就绪的图片节点高度偏小时不被采信，保留占位防止轨道塌陷', async () => {
    const { reader, viewport, finish, unloaded, measure } = fixture(50, 1200)
    // 未下载的图片只有普通比例骨架，不能把骨架当作真实尺寸并取消占位。
    unloaded.add(11)
    await finish(reader.open({ format: 'comic', index: 10, ratio: 0 }))
    measure()
    // 该节点不应被当作有效测量高度，应保留预估 minHeight 占位；
    // 占位值已从固定 1.45 比例升级为已加载邻页学习到的真实页高。
    const node11 = viewport.querySelector<HTMLElement>('.comic-page[data-index="11"]')!
    expect(parseFloat(node11.style.minHeight)).toBe(1200)
    expect(reader.current().index).toBe(10)
  })

  it('已加载页学习到长图页高后，未知页占位与页码映射不再依赖固定估高', async () => {
    const { reader, viewport, finish, scrollBy, loadPages } = fixture(100, 12_000, false)
    await finish(reader.open())
    loadPages([[0, 12_000], [1, 12_000], [2, 12_000]])
    // 三页一致采样后估高已学习（12000px）。一次跨越约 4 个真实页高的快速滚动：
    // 页码映射按学习页高换算应落在第 5 页；固定 1.45 估高会把 48500px 虚报到第 12 页左右。
    await scrollBy(48_500)
    expect(reader.current().index).toBe(4)
    // 换窗后新挂载的未知页节点应用学习到的页高占位，而不是 1.45 比例骨架。
    const node3 = viewport.querySelector<HTMLElement>('.comic-page[data-index="3"]')!
    expect(parseFloat(node3.style.minHeight)).toBe(12_000)
  })

  it('从第0页打开后跳转到第450页并向下滑动不会跳到430几页', async () => {
    const { reader, viewport, finish, scrollBy } = fixture(1000, 1200)
    await finish(reader.open())
    expect(reader.current().index).toBe(0)
    await finish(reader.go(449))
    expect(reader.current().index).toBe(449)
    // 向下滑动
    for (let step = 0; step < 10; step++) {
      await scrollBy(300)
      const loc = reader.current()
      expect(loc.index).toBeGreaterThanOrEqual(449)
      expect(loc.index).toBeLessThan(460)
    }
  })

  it('头部探测让后续未加载页的占位高与真实一致，快滚穿越不再跳几十页', async () => {
    const { reader, viewport, finish, scrollBy, loadPages, probe } = fixture(150, 2000, false)
    await finish(reader.open())
    // 前几页短图真实加载：学习估高收敛到 2000，而后续页真实高 12000。
    loadPages([[0, 2000], [1, 2000], [2, 2000]])
    probe(Array.from({ length: 28 }, (_, i) => [i + 3, 12_000]))
    // 一次 24000px 的快滚：按真实页高应落在第 2～4 页；
    // 修复前估高 2000 会把它虚报成 +12 页，阅读位置莫名前跳十几页。
    await scrollBy(24_000)
    expect(reader.current().index).toBeGreaterThanOrEqual(2)
    expect(reader.current().index).toBeLessThanOrEqual(4)
    // 换窗后新挂载页直接使用探测到的精确尺寸，不再退回骨架占位。
    const node3 = viewport.querySelector<HTMLElement>('.comic-page[data-index="3"]')!
    expect(node3.querySelector('img')!.getAttribute('width')).toBe('1000')
    expect(parseFloat(node3.querySelector('img')!.style.height)).toBe(12_000)
  })

  it('探测尺寸批量到达时不改变当前页和页内位置', async () => {
    const { reader, finish, probe, loadPages } = fixture(150, 1450, false)
    await finish(reader.open({ format: 'comic', index: 50, ratio: .4 }))
    loadPages([[50, 6000]])
    const before = reader.current()
    // 邻近页探测结果大幅改变上方/下方占位高，阅读锚点必须保持不变。
    probe([[45, 400], [46, 9000], [47, 300], [53, 7000], [54, 11_000]])
    expect(reader.current()).toEqual(before)
  })

  it('头部探测的尺寸直接参与估高学习，不必等整图加载', async () => {
    const { reader, finish, probe } = fixture(150, 1450, false, Array.from({ length: 150 }, () => 500_000))
    await finish(reader.open())
    const heights = (reader as unknown as { heights: number[] }).heights
    expect(heights[100]).toBe(1450)
    // 真实网络里 64 KiB 头部探测总是先于整图到达，整图到达时已不是“新”页：
    // 只有探测、没有任何整图时也必须学到真实页高，否则探测环外永远停留在初始估高。
    probe([[0, 12_000], [1, 12_000], [2, 12_000], [3, 12_000]])
    expect(heights[3]).toBe(12_000)
    // 各页字节相同：探测环外的未知页按字节比例估到同样的真实页高。
    expect(heights[100]).toBe(12_000)
    expect(reader.current().index).toBe(0)
  })

  it('快滚穿越占位页后估高才收敛时，落点按物理滚动距离回落到真实页码，不钉死虚高页码', async () => {
    const { reader, viewport, finish, scrollBy, probe } = fixture(300, 1450, false, Array.from({ length: 300 }, () => 500_000))
    await finish(reader.open({ format: 'comic', index: 40 }))
    // 打开后立即连续甩动 4 次共 24000px，全程都是初始估高 1450 的占位页：索引被虚报到第 56 页。
    for (let i = 0; i < 4; i++) await scrollBy(6000)
    expect(reader.current().index).toBe(40 + Math.floor(24_000 / 1450))
    // 探测结果在落点附近到达，真实页高 6000：物理只滚了 4 个真实页，落点回落到第 44 页，
    // 而不是保留虚高的第 56 页、把中间十几页内容永久跳过。
    probe([[54, 6000], [55, 6000], [56, 6000], [57, 6000], [58, 6000]])
    expect(reader.current().index).toBe(44)
    expect(reader.current().ratio ?? 0).toBeLessThan(.01)
    expect(viewport.querySelector('.comic-page[data-index="44"]')).not.toBeNull()
    expect(viewport.scrollTop).toBe(24 * 6000)
  })

  it('停在已加载页上时，穿越区的估高修正只补偿坐标、不移动画面', async () => {
    const { reader, finish, scrollBy, probe, loadPages, scrollWrites } = fixture(300, 1450, false, Array.from({ length: 300 }, () => 500_000))
    await finish(reader.open({ format: 'comic', index: 40 }))
    for (let i = 0; i < 4; i++) await scrollBy(6000)
    // 落点页已经整图加载（已知尺寸）：用户正在看真实内容，画面不能动。
    loadPages([[56, 1450]])
    const before = reader.current()
    expect(before.index).toBe(56)
    scrollWrites.length = 0
    probe([[50, 6000], [51, 6000], [52, 6000]])
    expect(reader.current()).toEqual(before)
    expect(scrollWrites.length).toBe(1)
  })

  it('像素锚落点越出局部轨道时自动换段定位，不困在旧轨道边界', async () => {
    const { reader, viewport, finish, scrollBy, probe } = fixture(500, 1450, false, Array.from({ length: 500 }, () => 500_000))
    await finish(reader.open({ format: 'comic', index: 100 }))
    // 甩到以 100 为中心的轨道末端（估高 1450 × 20 页），换段后轨道以 120 为中心。
    await scrollBy(29_000)
    expect(reader.current().index).toBe(120)
    // 真实页高只有 300：同样的物理距离对应 96 个真实页，落点在第 196 页，已越出当前轨道。
    probe([[118, 300], [119, 300], [120, 300], [121, 300], [122, 300]])
    expect(reader.current().index).toBe(196)
    expect(viewport.querySelector('.comic-page[data-index="196"]')).not.toBeNull()
    expect((reader as unknown as { trackFirst: number }).trackFirst).toBe(176)
  })
})
