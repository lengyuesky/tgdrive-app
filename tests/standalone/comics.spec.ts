import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { png } from '../browser/readers-fixtures.mjs'
import type { ComicReader } from '../../comics/comic'
import type { Drive, FileEntry } from '../../sdk/types'
import type { Location } from '../../reader/state'

interface ComicFixture {
  reader: ComicReader
  viewport: HTMLElement
  errors: string[]
  writes: number[]
  /** 每次程序化改写 scrollTop 时距最近一次 scroll / scrollend 事件的毫秒数。 */
  writeTimes: { sinceScroll: number; sinceEnd: number }[]
  release: (index: number) => void
  samples: number[]
  mismatch: number[]
  released?: number
}
declare global {
  interface Window {
    ComicModule: typeof import('../../comics/comic')
    comicFixture: ComicFixture
  }
}
let bundle = '', style = ''
const normal = [...png(1000, 1200, [72, 120, 96])]
/** 在纯色 PNG 的 IDAT 后插入一个私有辅助块（解码器忽略）把文件撑到指定字节数：
 *  让 64 KiB 头部探测与整图读取成为两个可区分的请求，模拟真实网络里探测先到、整图后到。 */
function padded(width: number, height: number, color: number[], bytes: number) {
  const base = Buffer.from(png(width, height, color))
  const type = Buffer.from('prVt'), data = Buffer.alloc(bytes, 0x5a)
  const head = Buffer.alloc(4); head.writeUInt32BE(bytes)
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return [...Buffer.concat([base.subarray(0, base.length - 12), head, type, data, sum, base.subarray(base.length - 12)])]
}
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: fileURLToPath(new URL('../../comics/comic.ts', import.meta.url)), name: 'ComicModule', formats: ['iife'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
  const output = Array.isArray(result) ? result[0]! : result
  if (!('output' in output)) throw new Error('漫画测试构建没有生成脚本')
  const entry = output.output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('漫画测试入口缺失')
  bundle = entry.code
  const baseCss = await readFile(new URL('../../reader/style.css', import.meta.url), 'utf8')
  const readingCss = await readFile(new URL('../../reader/reading.css', import.meta.url), 'utf8')
  style = `${baseCss}\n${readingCss}`
})
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.comicFixture?.errors ?? [])).toEqual([])
  await page.evaluate(() => window.comicFixture?.reader.destroy())
})

async function open(page: Page, options: { count?: number; location?: Location; image?: number[]; odd?: number[]; overrides?: [number, number[]][]; blocked?: number[]; delays?: { head: number; full: number } } = {}) {
  // 直接注入打包脚本与内存 SDK；任何意外网络访问都阻断，测试不依赖宿主或外部资源。
  await page.route('**/*', (route) => route.abort())
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app" class="immersive" data-kind="comics"><main id="viewport" class="reading-viewport" data-mode="scroll"></main></div>')
  await page.addStyleTag({ content: style })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(async ({ count, location, image, odd, overrides, blocked, delays }) => {
    const viewport = document.getElementById('viewport')!
    const errors: string[] = [], writes: number[] = []
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    const writeTimes: { sinceScroll: number; sinceEnd: number }[] = []
    let lastScrollAt = -Infinity, lastEndAt = -Infinity
    // 夹具监听先于阅读器注册：阅读器在 scrollend 里同步结清时，sinceEnd 已经归零。
    viewport.addEventListener('scroll', () => { lastScrollAt = performance.now() }, { passive: true })
    viewport.addEventListener('scrollend', () => { lastEndAt = performance.now() }, { passive: true })
    Object.defineProperty(viewport, 'scrollTop', {
      get() { return descriptor.get!.call(this) },
      set(value: number) {
        writes.push(value); writeTimes.push({ sinceScroll: performance.now() - lastScrollAt, sinceEnd: performance.now() - lastEndAt })
        descriptor.set!.call(this, value)
      },
    })
    const controller = new AbortController()
    const bytes = new Uint8Array(image), oddBytes = odd ? new Uint8Array(odd) : undefined
    const resources = new Map(overrides.map(([index, data]) => [index, new Uint8Array(data)]))
    // 奇数页可使用另一张图：长短交替的参差条漫，任何估高都不可能同时命中两种页高。
    const bytesAt = (index: number) => resources.get(index) ?? (oddBytes && index % 2 ? oddBytes : bytes)
    const blockedPages = new Set(blocked), waiting = new Map<number, Set<() => void>>()
    const file: FileEntry = { id: 1, name: '合成长漫画', path: '/合成长漫画', is_dir: true, size: 0, content_version: 'a'.repeat(64), created_at: 1, modified_at: 1, favorite: false }
    const entries = Array.from({ length: count }, (_, index) => ({ ...file, id: index + 2, name: `${index + 1}.png`, is_dir: false, size: bytesAt(index).length }))
    const drive = { files: {
      list: async () => ({ entries, next_cursor: null }),
      readRange: async (ref: { id: number }, start: number, length: number, { signal }: { signal: AbortSignal }) => {
        const index = ref.id - 2
        signal.throwIfAborted()
        if (blockedPages.has(index)) await new Promise<void>((resolve, reject) => {
          const callbacks = waiting.get(index) ?? new Set<() => void>()
          const finish = () => { callbacks.delete(finish); signal.removeEventListener('abort', cancel); resolve() }
          const cancel = () => { callbacks.delete(finish); reject(signal.reason) }
          callbacks.add(finish); waiting.set(index, callbacks)
          signal.addEventListener('abort', cancel, { once: true })
        })
        // 模拟真实网络：64 KiB 头部探测请求快、整图（≥1 MiB 分块）慢；中止即拒绝。
        if (delays) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, length <= 65_536 ? delays.head : delays.full)
          const cancel = () => { clearTimeout(timer); reject(signal.reason) }
          signal.addEventListener('abort', cancel, { once: true })
        })
        signal.throwIfAborted()
        return bytesAt(index).slice(start, start + length)
      },
    } } as unknown as Drive
    const reader = new window.ComicModule.ComicReader({
      drive, file, viewport, signal: controller.signal,
      prefs: { mode: 'scroll', zoom: 1, theme: 'light', fontSize: 18, lineHeight: 1.8, width: 760, direction: 'ltr' },
      changed: () => {}, error: (error) => errors.push(String(error)),
    })
    window.comicFixture = {
      reader, viewport, errors, writes, writeTimes, samples: [], mismatch: [],
      release: (index) => { blockedPages.delete(index); waiting.get(index)?.forEach((finish) => finish()) },
    }
    await reader.open(location)
  }, { count: options.count ?? 1000, location: options.location ?? { format: 'comic', index: 449, ratio: .4 }, image: options.image ?? normal, odd: options.odd ?? null, overrides: options.overrides ?? [], blocked: options.blocked ?? [], delays: options.delays ?? null })
}
const current = (page: Page) => page.evaluate(() => window.comicFixture.reader.current())
const imageAt = (page: Page, index: number) => page.locator(`img[data-resource="${index}"]`)
async function loaded(page: Page, index: number) {
  await expect.poll(() => imageAt(page, index).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('真实滚轮逐页前进时保留原生坐标，不触发额外滚动写入', async ({ page }) => {
  await open(page)
  await loaded(page, 449); await loaded(page, 450)
  await page.evaluate(() => { window.comicFixture.writes.length = 0 })
  await page.mouse.move(500, 350)
  for (let index = 450; index <= 455; index++) {
    await page.mouse.wheel(0, 1200)
    await expect.poll(async () => (await current(page)).index).toBe(index)
    expect((await current(page)).ratio).toBeCloseTo(.4, 2)
  }
  expect(await page.evaluate(() => window.comicFixture.writes)).toEqual([])
  await expect(page.locator('.comic-page')).toHaveCount(5)
  await page.mouse.wheel(0, -6000)
  await expect.poll(async () => (await current(page)).index).toBeLessThan(453)
})

test('上方迟到图片大幅缩短布局后，当前画面不因 scrollTop 截断而跳动', async ({ page }) => {
  const short = [...png(1000, 300, [120, 80, 100])]
  await open(page, { count: 100, location: { format: 'comic', index: 98, ratio: .4 }, blocked: [96, 97], overrides: [[96, short], [97, short]] })
  await loaded(page, 98)
  await page.mouse.move(500, 350); await page.mouse.wheel(0, 120)
  await expect.poll(async () => (await current(page)).ratio).toBeCloseTo(.5, 2)
  const top = await imageAt(page, 98).evaluate((image) => image.getBoundingClientRect().top)
  await page.evaluate(() => { window.comicFixture.release(96); window.comicFixture.release(97) })
  await expect(imageAt(page, 96)).toHaveAttribute('height', '300')
  await expect(imageAt(page, 97)).toHaveAttribute('height', '300')
  expect((await current(page)).index).toBe(98)
  expect(await imageAt(page, 98).evaluate((image) => image.getBoundingClientRect().top)).toBeCloseTo(top, 0)
})

test('六万像素长图优先保留解码，回看和调整视口仍保持页内位置', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const long = [...png(500, 60_000, [100, 80, 160])]
  const neighbor = [...png(1000, 4000, [60, 140, 120])]
  await open(page, { location: { format: 'comic', index: 449, ratio: .985 }, image: neighbor, overrides: [[449, long]] })
  await loaded(page, 449)
  expect((await current(page)).ratio).toBeCloseTo(.985, 3)
  const source = await imageAt(page, 449).getAttribute('src')
  await page.mouse.move(195, 422); await page.mouse.wheel(0, 100)
  await expect.poll(async () => (await current(page)).ratio).toBeGreaterThan(.985)
  await loaded(page, 449)
  expect(await imageAt(page, 449).getAttribute('src')).toBe(source)
  const saved = await current(page)
  await page.setViewportSize({ width: 600, height: 844 })
  await expect.poll(async () => (await current(page)).ratio).toBeCloseTo(saved.ratio!, 3)
  await page.evaluate(async (saved) => {
    const { reader } = window.comicFixture
    await reader.go(480)
    await reader.restore(saved)
  }, saved)
  await loaded(page, 449)
  expect((await current(page)).ratio).toBeCloseTo(saved.ratio!, 3)
  await expect(imageAt(page, 449)).toHaveAttribute('height', '60000')
  expect(await page.locator('#viewport').evaluate((node) => node.scrollHeight)).toBeLessThan(41 * 196640)
})

test.describe('手机触摸滚动', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('连续触摸与松手后的惯性滚动跨页时单调前进', async ({ page }) => {
    await open(page, { image: [...png(1000, 2000, [80, 120, 180])], location: { format: 'comic', index: 449, ratio: .7 } })
    await loaded(page, 449); await loaded(page, 450); await loaded(page, 451)
    await page.evaluate(() => {
      const fixture = window.comicFixture
      fixture.writes.length = 0
      fixture.viewport.addEventListener('touchend', () => {
        const location = fixture.reader.current()
        fixture.released = (location.index + (location.ratio ?? 0)) * 780
      }, { once: true, passive: true })
      const record = () => {
        const location = fixture.reader.current()
        fixture.samples.push((location.index + (location.ratio ?? 0)) * 780)
        if (fixture.samples.length < 100) requestAnimationFrame(record)
      }
      requestAnimationFrame(record)
    })
    const session = await page.context().newCDPSession(page)
    try {
      // 显式时间戳让合成触摸具有确定速度，确保实际触发松手后的浏览器惯性滚动。
      const timestamp = Date.now() / 1000
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp, touchPoints: [{ x: 195, y: 700, id: 1 }] })
      for (let step = 1; step <= 9; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', timestamp: timestamp + step * .016, touchPoints: [{ x: 195, y: 700 - step * 60, id: 1 }] })
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: timestamp + .15, touchPoints: [] })
    } finally { await session.detach() }
    await expect.poll(() => page.evaluate(() => window.comicFixture.samples.length)).toBe(100)
    const { samples, released } = await page.evaluate(() => ({ samples: window.comicFixture.samples, released: window.comicFixture.released }))
    expect(samples.at(-1)! - samples[0]!).toBeGreaterThan(500)
    expect(released).toBeDefined()
    expect(samples.at(-1)! - released!).toBeGreaterThan(50)
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]! - 1)
    expect(await page.evaluate(() => window.comicFixture.writes)).toEqual([])
  })

  test('探测先于整图到达时估高仍能学习，连续甩动穿越未探测区后的落点按真实页高回落而不是钉死虚高页码', async ({ page }) => {
    // 真实网络形态：64 KiB 头部探测 300ms、整图 1200ms；各页字节相同、真实高 5000（初始估高 ≈ 2.2 个视口高 ≈ 1857）。
    const strip = padded(390, 5000, [88, 120, 200], 200_000)
    await open(page, { count: 300, location: { format: 'comic', index: 0 }, image: strip, delays: { head: 300, full: 1200 } })
    // 打开后立刻连续甩动 5 次共 30000px：全程都是占位页，任何探测结果都来不及到达。
    await page.evaluate(async () => {
      const { viewport } = window.comicFixture
      for (let i = 0; i < 5; i++) {
        viewport.scrollTop += 6000
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      }
    })
    // 此刻页码只能按初始估高映射，被虚报到第 16 页上下。
    expect((await current(page)).index).toBeGreaterThanOrEqual(12)
    // 探测到达、估高学习后：物理滚动 30000px ÷ 真实页高 5000 = 第 6 页（0 基），
    // 修复前保留虚高页码停在第 16 页，中间十页内容被永久跳过。
    await expect.poll(async () => (await current(page)).index, { timeout: 10_000 }).toBe(6)
    await page.waitForTimeout(1500)
    expect((await current(page)).index).toBe(6)
    expect(await page.evaluate(() => Math.round(window.comicFixture.viewport.scrollTop))).toBe(30_000)
    await loaded(page, 6)
    expect((await current(page)).index).toBe(6)
  })

  test('惯性滚动中锚点上方页面陆续探测出真实尺寸时不改写 scrollTop、画面不往回跳，停稳后才一次结清', async ({ page }) => {
    // 长短交替的参差条漫（3000/7000，字节几乎相同）：估高只能落在中间，每一页探测到达都会修正锚点上方高度。
    // 真实网络形态：探测 300ms 先到、整图 1200ms 后到。
    const short = padded(390, 3000, [88, 120, 200], 200_000), long = padded(390, 7000, [200, 120, 88], 200_000)
    await open(page, { count: 300, location: { format: 'comic', index: 40 }, image: short, odd: long, delays: { head: 300, full: 1200 } })
    // 从保存的进度打开：第 40 页是像素锚基准，其上方十几页仍是估高占位，探测环会在接下来几秒内逐页修正。
    await loaded(page, 40)
    await page.evaluate(() => {
      const fixture = window.comicFixture
      fixture.writes.length = 0; fixture.writeTimes.length = 0
      // 逐帧记录真实阅读位置（只能单调前进），以及当前页节点在视口里的实际位置与页码/页内比例的偏差。
      const record = () => {
        const location = fixture.reader.current(), height = location.index % 2 ? 7000 : 3000
        const node = document.querySelector(`.comic-page[data-index="${location.index}"]`)
        const rect = node?.getBoundingClientRect(), box = fixture.viewport.getBoundingClientRect()
        fixture.samples.push(Math.floor(location.index / 2) * 10_000 + (location.index % 2 ? 3000 : 0) + (location.ratio ?? 0) * height)
        fixture.mismatch.push(rect ? Math.abs(box.top - rect.top - (location.ratio ?? 0) * rect.height) : 0)
        if (fixture.samples.length < 180) requestAnimationFrame(record)
      }
      requestAnimationFrame(record)
    })
    const session = await page.context().newCDPSession(page)
    try {
      // 强力甩动：松手后的浏览器惯性持续数秒，上方 33～39 页的探测结果在惯性进行中陆续到达。
      const timestamp = Date.now() / 1000
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp, touchPoints: [{ x: 195, y: 800, id: 1 }] })
      for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', timestamp: timestamp + step * .016, touchPoints: [{ x: 195, y: 800 - step * 90, id: 1 }] })
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: timestamp + .13, touchPoints: [] })
    } finally { await session.detach() }
    await expect.poll(() => page.evaluate(() => window.comicFixture.samples.length), { timeout: 15_000 }).toBe(180)
    const { samples, mismatch, writeTimes, probed } = await page.evaluate(() => ({
      samples: window.comicFixture.samples, mismatch: window.comicFixture.mismatch, writeTimes: window.comicFixture.writeTimes,
      probed: [...(window.comicFixture.reader as unknown as { dimensions: Map<number, unknown> }).dimensions.keys()].filter((index) => index < 40).length,
    }))
    // 惯性确实跨过了多页，且锚点上方确有页面在此期间探测出真实尺寸。
    expect(samples.at(-1)! - samples[0]!).toBeGreaterThan(2500)
    expect(probed).toBeGreaterThanOrEqual(3)
    // 阅读位置单调前进：任何一次“往回跳一点”都会在逐帧样本里留下回退。
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]! - 1)
    // 每一帧当前页节点在视口中的位置都与页码/页内比例一致：吸收进占位的修正没有让画面与页码脱节。
    expect(Math.max(...mismatch)).toBeLessThanOrEqual(2)
    // 惯性进行中不得程序化改写 scrollTop（旧代码每批探测到达都改写一次，Chromium 里每次改写紧跟着上一帧的
    // scroll 事件）：每一次改写都只能发生在 scrollend 的同步处理里，或最后一个 scroll 事件静默 150ms 之后。
    await page.waitForTimeout(600)
    const late = await page.evaluate(() => window.comicFixture.writeTimes)
    expect(late.length).toBeGreaterThanOrEqual(writeTimes.length)
    expect(late.length).toBeGreaterThanOrEqual(1)
    for (const write of late) expect(write.sinceEnd <= 5 || write.sinceScroll >= 150).toBe(true)
    // 结清后画面所在页与 DOM 位置一致。
    const location = await current(page)
    const box = await page.locator(`.comic-page[data-index="${location.index}"]`).evaluate((node) => {
      const rect = node.getBoundingClientRect(), viewport = node.closest('#viewport')!.getBoundingClientRect()
      return { top: rect.top - viewport.top, bottom: rect.bottom - viewport.top }
    })
    expect(box.top).toBeLessThanOrEqual(1)
    expect(box.bottom).toBeGreaterThan(0)
  })
})
