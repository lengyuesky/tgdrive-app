import { expect, test, type Page } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Drive } from '../../sdk/types'

declare global {
  interface Window {
    shortsFixture: { calls: { id: number; kind: string }[]; immersive: unknown[][]; releasePoster: () => void }
  }
}
let html = '', base = '', css = '', script = '', media: Buffer, temporary = ''
// 与 build.mjs 一致：tg-base.css 只在打包时由 ui/base.css 注入，这里按相同顺序先注入共享样式。
const sources = ['../../shorts/index.html', '../../ui/base.css', '../../shorts/style.css', '../../shorts/app.js']
// 手机竖屏与小屏横屏隐藏 ↑↓ 按钮组（配置启用触摸，844×390 视作手机横屏）。
const compactWidths = new Set([320, 390, 568, 844])
test.beforeAll(async () => {
  ;[html, base, css, script] = await Promise.all(sources.map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  html = html.replace(/<script\b[^>]*>.*?<\/script>/gs, '').replace(/<link\b[^>]*>/g, '')
  temporary = await mkdtemp(join(tmpdir(), 'tgdrive-shorts-media-'))
  const path = join(temporary, 'video.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=20:size=320x568:rate=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path])
  media = await readFile(path)
})
test.afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })

async function open(page: Page, slowPoster = false, capabilities = ['ui.setImmersive']) {
  const errors: string[] = [], requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (!/^https:\/\/shorts\.invalid\/video\/\d+\.mp4$/.test(url)) { await route.abort(); return }
    requests.push(url)
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/)
    const start = Number(range?.[1] ?? 0), end = Math.min(media.length - 1, range?.[2] ? Number(range[2]) : media.length - 1)
    await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: media.subarray(start, end + 1),
      headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) },
    })
  })
  await page.setContent(html)
  await page.addStyleTag({ content: base })
  await page.addStyleTag({ content: css })
  await page.evaluate(({ slowPoster, capabilities }) => {
    Math.random = () => .99
    const calls: { id: number; kind: string }[] = []
    let releasePoster!: () => void
    const poster = new Promise<string>(resolve => { releasePoster = () => resolve('') })
    const entries = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: `${i + 1} · 夏日旅行记录.mp4`, path: `/旅行/${i + 1}.mp4`, size: 600_000, content_version: 'a'.repeat(64), favorite: false }))
    const immersive: unknown[][] = []
    window.shortsFixture = { calls, immersive, releasePoster }
    window.tgdrive = {
      ready: Promise.resolve({ capabilities }),
      files: { search: async () => ({ results: entries }) },
      media: { url: async (ref: { id: number }, kind = 'preview') => { calls.push({ id: ref.id, kind }); return kind === 'thumbnail' ? slowPoster ? poster : '' : `https://shorts.invalid/video/${ref.id}.mp4` } },
      settings: { get: async () => ({ source_dir: '/旅行', muted: true }), patch: async () => ({}), open: async () => {} },
      favorites: { set: async (_path: string, favorite: boolean) => ({ favorite }) },
      // 记录沉浸请求；未传背景时用 null 表示，便于序列化比较。
      ui: { close: async () => {}, download: async () => {}, setImmersive: async (active: boolean, options?: { background: string }) => { immersive.push([active, options ?? null]) } },
      on: () => () => {},
    } as unknown as Drive
  }, { slowPoster, capabilities })
  await page.addScriptTag({ content: script })
  return { errors, requests }
}
async function playing(page: Page) {
  await expect.poll(() => page.locator('#video').evaluate(node => !((node as HTMLVideoElement).paused) && (node as HTMLVideoElement).currentTime > .05)).toBe(true)
}

test('慢封面不阻塞实际首帧，预取下一条地址不会读取下一条视频', async ({ page }) => {
  const { errors, requests } = await open(page, true)
  await playing(page)
  expect(await page.evaluate(() => window.shortsFixture.calls.filter(call => call.kind === 'preview'))).toEqual([{ id: 1, kind: 'preview' }, { id: 2, kind: 'preview' }])
  expect(requests.every(url => url.endsWith('/1.mp4'))).toBe(true)
  await page.evaluate(() => window.shortsFixture.releasePoster())
  // ↑↓ 按钮组只在宽屏/键盘场景显示。
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '下一个视频', exact: true }).click()
  await playing(page)
  await expect(page.locator('#video')).toHaveAttribute('src', /\/2\.mp4$/)
  expect(await page.evaluate(() => window.shortsFixture.calls.filter(call => call.id === 2 && call.kind === 'preview').length)).toBe(1)
  expect(errors).toEqual([])
})

test('实际进度拖动与键盘微调不切换视频，暂停后切换声音保持暂停', async ({ page }) => {
  const { errors } = await open(page)
  await playing(page)
  await page.getByRole('button', { name: '暂停视频', exact: true }).click()
  const seek = page.getByRole('slider', { name: '播放进度' })
  await expect(seek).toBeEnabled()
  const box = (await seek.boundingBox())!
  await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2); await page.mouse.up()
  await expect.poll(() => page.locator('#video').evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(9)
  await seek.focus(); await page.keyboard.press('ArrowRight')
  await page.locator('#mute').click()
  expect(await page.locator('#video').evaluate(node => (node as HTMLVideoElement).paused)).toBe(true)
  await expect(page.locator('#video-name')).toContainText('1 ·')
  await expect(page.locator('#playback-time')).toContainText('/ 0:20')
  expect(errors).toEqual([])
})

test('一轮滚轮惯性只换一条，连续点击下一条最终播放最后选中项', async ({ page }) => {
  const { errors } = await open(page)
  await playing(page)
  await page.mouse.move(150, 350)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 120)
  await expect(page.locator('#video-name')).toContainText('2 ·')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('#next').click(); await page.locator('#next').click()
  await expect(page.locator('#video-name')).toContainText('4 ·')
  await playing(page)
  await expect(page.locator('#video')).toHaveAttribute('src', /\/4\.mp4$/)
  expect(errors).toEqual([])
})

test('手机真实上滑只换一条且不被尾随轻点暂停', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', '触摸注入使用 Chromium CDP，WebKit 另测布局与实际媒体')
  await open(page); await playing(page)
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 590, id: 1 }] })
    for (let i = 1; i <= 6; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: 590 - i * 55, id: 1 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally { await session.detach() }
  await expect(page.locator('#video-name')).toContainText('2 ·')
  await playing(page)
})

test('手机、横屏和平板的主要操作可点击且不溢出', async ({ page }, info) => {
  await open(page); await playing(page)
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 390], [768, 1024], [1440, 900]]) {
    await page.setViewportSize({ width: width!, height: height! })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const compact = compactWidths.has(width!)
    for (const id of ['previous', 'next']) {
      if (compact) await expect(page.locator(`#${id}`)).toBeHidden()
      else await expect(page.locator(`#${id}`)).toBeVisible()
    }
    // 右侧图标在标题之上或旁边，不能互相遮挡；底部标题不进入操作列。
    const actions = (await page.locator('#actions').boundingBox())!, caption = (await page.locator('#video-name').boundingBox())!
    expect(caption.x + caption.width <= actions.x || caption.y >= actions.y + actions.height || caption.y + caption.height <= actions.y).toBe(true)
    for (const id of ['exit', 'source-label', 'favorite', 'mute', 'download', 'shuffle', ...(compact ? [] : ['previous', 'next']), 'play-toggle', 'seek']) {
      const rect = (await page.locator(`#${id}`).boundingBox())!
      expect(rect.width).toBeGreaterThanOrEqual(44)
      expect(rect.height).toBeGreaterThanOrEqual(44)
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(width!); expect(rect.y + rect.height).toBeLessThanOrEqual(height!)
      expect(await page.locator(`#${id}`).evaluate(node => {
        const rect = node.getBoundingClientRect(), target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return !!target && (node === target || node.contains(target))
      })).toBe(true)
    }
    if (width === 390 || width === 568 || width === 1440) await page.screenshot({ path: info.outputPath(`shorts-${width}.png`) })
  }
})

test('图标状态随收藏、静音、播放切换，共享深色变量生效', async ({ page }) => {
  const { errors } = await open(page)
  await playing(page)
  const visibleIcon = (selector: string) => page.locator(selector).evaluate(node => [...node.querySelectorAll('svg')].map(svg => getComputedStyle(svg).display !== 'none'))
  expect(await visibleIcon('#favorite')).toEqual([true, false])
  await page.locator('#favorite').click()
  await expect(page.locator('#favorite')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#favorite')).toHaveAccessibleName('已收藏')
  expect(await visibleIcon('#favorite')).toEqual([false, true])
  expect(await visibleIcon('#mute')).toEqual([true, false])
  await page.locator('#mute').click()
  await expect(page.locator('#mute')).toHaveAccessibleName('有声')
  expect(await visibleIcon('#mute')).toEqual([false, true])
  expect(await visibleIcon('#play-toggle')).toEqual([false, true])
  await page.getByRole('button', { name: '暂停视频', exact: true }).click()
  await expect(page.locator('#play-toggle')).toHaveAttribute('data-state', 'paused')
  expect(await visibleIcon('#play-toggle')).toEqual([true, false])
  // 共享深色变量生效：根节点使用 tg 深色背景色。
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tg-bg').trim())).toBe('#000000')
  expect(errors).toEqual([])
})

test('支持沉浸背景时向宿主请求纯黑背景，不支持时只切换沉浸', async ({ browser }) => {
  // 关闭触摸模拟，使宽屏不再匹配 pointer: coarse，从而验证退出沉浸。
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: false })
  try {
    const page = await context.newPage()
    await open(page, false, ['ui.setImmersive', 'ui.immersiveBackground'])
    await expect.poll(() => page.evaluate(() => window.shortsFixture.immersive)).toEqual([[true, { background: '#000000' }]])
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(() => page.evaluate(() => window.shortsFixture.immersive.at(-1))).toEqual([false, null])
    const legacy = await context.newPage()
    await open(legacy, false, ['ui.setImmersive'])
    await expect.poll(() => legacy.evaluate(() => window.shortsFixture.immersive)).toEqual([[true, null]])
  } finally { await context.close() }
})
