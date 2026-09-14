import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { png } from '../browser/readers-fixtures.mjs'
import type { ComicReader } from '../../comics/comic'
import type { Drive, FileEntry } from '../../sdk/types'
import type { Location } from '../../reader/state'

interface ComicFixture {
  reader: ComicReader
  viewport: HTMLElement
  errors: string[]
  writes: number[]
  release: (index: number) => void
  samples: number[]
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
  style = await readFile(new URL('../../reader/style.css', import.meta.url), 'utf8')
})
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.comicFixture?.errors ?? [])).toEqual([])
  await page.evaluate(() => window.comicFixture?.reader.destroy())
})

async function open(page: Page, options: { count?: number; location?: Location; image?: number[]; overrides?: [number, number[]][]; blocked?: number[] } = {}) {
  // 直接注入打包脚本与内存 SDK；任何意外网络访问都阻断，测试不依赖宿主或外部资源。
  await page.route('**/*', (route) => route.abort())
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app" class="immersive" data-kind="comics"><main id="viewport" class="reading-viewport" data-mode="scroll"></main></div>')
  await page.addStyleTag({ content: style })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(async ({ count, location, image, overrides, blocked }) => {
    const viewport = document.getElementById('viewport')!
    const errors: string[] = [], writes: number[] = []
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    Object.defineProperty(viewport, 'scrollTop', {
      get() { return descriptor.get!.call(this) },
      set(value: number) { writes.push(value); descriptor.set!.call(this, value) },
    })
    const controller = new AbortController()
    const bytes = new Uint8Array(image), resources = new Map(overrides.map(([index, data]) => [index, new Uint8Array(data)]))
    const blockedPages = new Set(blocked), waiting = new Map<number, Set<() => void>>()
    const file: FileEntry = { id: 1, name: '合成长漫画', path: '/合成长漫画', is_dir: true, size: 0, content_version: 'a'.repeat(64), created_at: 1, modified_at: 1, favorite: false }
    const entries = Array.from({ length: count }, (_, index) => ({ ...file, id: index + 2, name: `${index + 1}.png`, is_dir: false, size: (resources.get(index) ?? bytes).length }))
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
        signal.throwIfAborted()
        return (resources.get(index) ?? bytes).slice(start, start + length)
      },
    } } as unknown as Drive
    const reader = new window.ComicModule.ComicReader({
      drive, file, viewport, signal: controller.signal,
      prefs: { mode: 'scroll', zoom: 1, theme: 'light', fontSize: 18, lineHeight: 1.8, width: 760, direction: 'ltr' },
      changed: () => {}, error: (error) => errors.push(String(error)),
    })
    window.comicFixture = {
      reader, viewport, errors, writes, samples: [],
      release: (index) => { blockedPages.delete(index); waiting.get(index)?.forEach((finish) => finish()) },
    }
    await reader.open(location)
  }, { count: options.count ?? 1000, location: options.location ?? { format: 'comic', index: 449, ratio: .4 }, image: options.image ?? normal, overrides: options.overrides ?? [], blocked: options.blocked ?? [] })
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
})
