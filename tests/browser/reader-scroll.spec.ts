import { expect, test, type Page } from '@playwright/test'
import { seedReaderSource, enterReaderShelf, closeReaderPanel } from './reader-helpers'

declare global {
  interface Window { readerScrollTest: { writes: number[]; applied: boolean } }
}

async function open(page: Page, pageNumber: number) {
  await page.setViewportSize({ width: 1280, height: 900 })
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  expect((await page.request.post('/__apps_fixture/media', { data: { enabled: false } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
  const reader = index.available.find((app: { manifest: { id: string } }) => app.manifest.id === 'reader')
  expect(reader.manifest.version).toBe('1.0.4')
  expect((await page.request.post('/api/apps/catalog/reader/install', { data: { digest: reader.digest } })).ok()).toBe(true)
  await seedReaderSource(page, 'reader', '/测试漫画')
  await page.goto('/apps/reader')
  await enterReaderShelf(page)
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: /长册.cbz/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await frame.locator('#toc-toggle').click()
  await frame.locator('#jump').fill(String(pageNumber)); await frame.locator('#jump-button').click()
  await expect(frame.locator('#position')).toHaveText(`${pageNumber} / 200`)
  await closeReaderPanel(page)
  const viewport = frame.locator('#viewport')
  const current = viewport.locator(`.comic-page[data-index="${pageNumber - 1}"]`)
  await expect.poll(() => current.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(120)
  const height = await current.evaluate(node => node.getBoundingClientRect().height)
  await viewport.evaluate((node, height) => { node.scrollTop += height * .4 }, height)
  await expect.poll(() => current.evaluate(node => {
    const viewport = document.getElementById('viewport')!, rect = node.getBoundingClientRect()
    return Math.abs(viewport.getBoundingClientRect().top - rect.top - rect.height * .4)
  })).toBeLessThanOrEqual(2)
  // 坐标准备完成并停稳后才记录产品代码的额外写入。
  await page.waitForTimeout(250)
  await viewport.evaluate(node => {
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    window.readerScrollTest = { writes: [], applied: false }
    Object.defineProperty(node, 'scrollTop', {
      get() { return scroll.get!.call(this) },
      set(value: number) { window.readerScrollTest.writes.push(value); scroll.set!.call(this, value) },
    })
  })
  return { frame, viewport, current, height }
}

for (const nativeDelta of [80, -80]) test(`真实阅读馆包重排期间原生滚动推进 ${nativeDelta}px 时不回写旧坐标`, async ({ page }) => {
  const { frame, viewport, current } = await open(page, 51)
  const top = await current.evaluate(node => node.getBoundingClientRect().top)
  await current.evaluate((node, nativeDelta) => {
    const viewport = document.getElementById('viewport')!
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    const rect = node.getBoundingClientRect.bind(node)
    // 上方 figure 的内容盒高度变化触发真实 ResizeObserver，同步测量时模拟合成器推进原生滚动。
    // 不访问或替换包内私有方法，保留真实沙箱、SDK、图片和布局补偿路径。
    node.getBoundingClientRect = () => {
      node.getBoundingClientRect = rect
      scroll.set!.call(viewport, viewport.scrollTop + nativeDelta)
      window.readerScrollTest.applied = true
      return rect()
    }
    viewport.dispatchEvent(new Event('touchstart'))
    const spacer = document.createElement('div'); spacer.style.height = '1px'
    node.previousElementSibling!.append(spacer)
  }, nativeDelta)
  await expect.poll(() => viewport.evaluate(() => window.readerScrollTest.applied)).toBe(true)
  await expect.poll(() => current.evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(top - nativeDelta, 0)
  expect(await viewport.evaluate(() => window.readerScrollTest.writes)).toEqual([])
  await expect(frame.locator('#position')).toHaveText('51 / 200')
  await viewport.evaluate(node => { node.dispatchEvent(new Event('touchend')); node.dispatchEvent(new Event('scrollend')) })
  expect(await current.evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(top - nativeDelta, 0)
})

test('真实阅读馆包跨入末页时不因删除旧节点而追加滚动坐标写入', async ({ page }) => {
  const { frame, viewport, height } = await open(page, 199)
  await expect.poll(() => viewport.locator('.comic-page[data-index="199"] img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(120)
  await viewport.hover(); await page.mouse.wheel(0, height)
  await expect(frame.locator('#position')).toHaveText('200 / 200')
  expect(await viewport.evaluate(() => window.readerScrollTest.writes)).toEqual([])
  const offset = await viewport.locator('.comic-page[data-index="199"]').evaluate(node => {
    const viewport = document.getElementById('viewport')!, rect = node.getBoundingClientRect()
    return Math.abs(viewport.getBoundingClientRect().top - rect.top - rect.height * .4)
  })
  expect(offset).toBeLessThanOrEqual(2)
})
