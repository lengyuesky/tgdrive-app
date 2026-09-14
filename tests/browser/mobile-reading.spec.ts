import { expect, test, type Page } from '@playwright/test'
import { revealReader, closeReaderPanel } from './reader-helpers'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const frame = (page: Page) => page.frameLocator('iframe')
async function install(page: Page) {
  await page.goto('/apps/books')
  await expect(frame(page).locator('#items button').first()).toBeVisible()
}
async function open(page: Page, name: string) {
  await frame(page).getByRole('button', { name: new RegExp(name.replaceAll('.', '\\.')) }).click()
  await expect(frame(page).locator('#reading-status')).toHaveText('')
  await expect(frame(page).locator('#viewport')).toHaveAttribute('data-format', /txt|epub|pdf/)
}
async function tapContent(page: Page, x = .5) {
  const viewport = frame(page).locator('#viewport'), box = await viewport.boundingBox()
  await viewport.tap({ position: { x: box!.width * x, y: box!.height * .5 } })
}
async function setMode(page: Page, mode: 'page' | 'scroll') {
  await revealReader(page)
  await frame(page).locator('#preferences-toggle').click()
  await frame(page).locator('#mode').selectOption(mode)
  await expect(frame(page).locator('#viewport')).toHaveAttribute('data-mode', mode)
  if (mode === 'page') await expect.poll(async () => Number(await frame(page).locator('#position').getAttribute('data-pages'))).toBeGreaterThan(1)
  await closeReaderPanel(page)
}
async function savedLocation(page: Page) {
  return frame(page).locator('body').evaluate(async () => {
    const records = await (window as any).tgdrive.storage.list({ prefix: 'progress:', limit: 20 })
    return records.records[0].value.location as { offset?: number; index: number; entry?: string }
  })
}
async function anchorVisible(page: Page, offset: number) {
  return frame(page).locator('body').evaluate(async (_body, offset) => {
    const article = document.querySelector('.flow-content')!, scroller = document.querySelector('.flow-pages') ?? document.querySelector('#viewport')!
    const file = (await (window as any).tgdrive.storage.list({ prefix: 'progress:', limit: 20 })).records[0].value
    let remaining = offset - (file.location.format === 'txt' ? Number(file.location.entry) : 0)
    if (remaining < 0) return false
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (remaining >= node.length) { remaining -= node.length; continue }
      const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1)
      const rect = range.getBoundingClientRect(), box = scroller.getBoundingClientRect()
      return rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom
    }
    return false
  }, offset)
}
async function swipe(page: Page, from: number, to: number) {
  const box = (await frame(page).locator('#viewport').boundingBox())!
  const session = await page.context().newCDPSession(page)
  const point = (ratio: number) => [{ x: box.x + box.width * ratio, y: box.y + box.height * .5, id: 1 }]
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
    for (let i = 1; i <= 4; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from + (to - from) * i / 4) })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally { await session.detach() }
}

test.beforeEach(async ({ page }) => {
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  await page.request.post('/__apps_fixture/media', { data: { enabled: false } })
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
  const book = index.available.find((item: any) => item.manifest.id === 'books')
  expect(book.manifest.version).toBe('1.1.5')
  expect((await page.request.post('/api/apps/catalog/books/install', { data: { digest: book.digest } })).ok()).toBe(true)
  expect((await page.request.patch('/api/apps/books/settings', { data: { source_dir: '/测试图书' } })).ok()).toBe(true)
})

test('手机只显示正文，菜单不挤压页面，真实轻点与横向滑动按页前进', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message))
  await install(page); await open(page, '长篇.txt')
  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await expect(frame(page).locator('.app-header')).not.toBeVisible()
  await expect(frame(page).locator('.reader-toolbar')).not.toBeVisible()
  await expect(frame(page).locator('.reader-footer')).not.toBeVisible()
  const viewport = frame(page).locator('#viewport'), before = (await viewport.boundingBox())!
  expect(before.x).toBe(0); expect(before.y).toBe(0); expect(before.width).toBe(390); expect(before.height).toBe(844)
  await page.screenshot({ path: info.outputPath('图书-手机纯正文.png') })
  await tapContent(page)
  await expect(frame(page).locator('.reader-toolbar')).toBeVisible()
  expect(await viewport.boundingBox()).toEqual(before)
  await page.screenshot({ path: info.outputPath('图书-手机菜单.png') })
  await frame(page).locator('#preferences-toggle').click()
  const panel = frame(page).getByRole('dialog', { name: '阅读设置', exact: true })
  await expect(panel).toBeVisible(); expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(844 * .75)
  expect(await viewport.boundingBox()).toEqual(before)
  await page.screenshot({ path: info.outputPath('图书-手机设置.png') })
  await frame(page).locator('#mode').selectOption('page')
  await expect.poll(async () => Number(await frame(page).locator('#position').getAttribute('data-pages'))).toBeGreaterThan(1)
  await closeReaderPanel(page); await tapContent(page)
  await expect(frame(page).locator('.reader-footer')).not.toBeVisible()
  await tapContent(page, .9)
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '1')
  await swipe(page, .8, .2)
  await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '2')
  await swipe(page, .2, .8)
  await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '1')
  await page.screenshot({ path: info.outputPath('图书-手机单列分页.png') })
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await frame(page).locator('body').evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await tapContent(page); await frame(page).locator('#back').click()
  await expect(page.locator('.host-toolbar')).toBeVisible()
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover')
  expect(errors).toEqual([])
})

test('更多菜单在手机横竖屏和安全区内完整显示，操作不被分页栏遮挡', async ({ page }, info) => {
  await install(page); await open(page, '长篇.txt')
  const viewport = frame(page).locator('#viewport')
  const panel = frame(page).getByRole('dialog', { name: '更多操作', exact: true })
  for (const screen of [
    { name: '竖屏', width: 390, height: 844, top: 0, bottom: 0, side: 0 },
    { name: '小屏', width: 320, height: 568, top: 0, bottom: 0, side: 0 },
    { name: '横屏', width: 844, height: 390, top: 0, bottom: 0, side: 0 },
    { name: '竖屏安全区', width: 393, height: 852, top: 59, bottom: 34, side: 0 },
    { name: '横屏安全区', width: 852, height: 393, top: 0, bottom: 21, side: 59 },
  ]) {
    await page.setViewportSize({ width: screen.width, height: screen.height })
    await page.addStyleTag({ content: `:root { --safe-top: ${screen.top}px; --safe-bottom: ${screen.bottom}px; --safe-left: ${screen.side}px; --safe-right: ${screen.side}px; }` })
    const bounds = { x: screen.side, y: screen.top, width: screen.width - screen.side * 2, height: screen.height - screen.top - screen.bottom }
    await expect.poll(() => viewport.boundingBox()).toEqual(bounds)
    await revealReader(page); await frame(page).locator('#reader-more-toggle').tap()
    await expect(panel).toBeVisible()
    expect(await viewport.boundingBox()).toEqual(bounds)
    await page.screenshot({ path: info.outputPath(`图书-更多菜单-${screen.name}.png`) })
    // 可见性断言无法发现层叠遮挡，按钮中心和四角都必须命中按钮本身。
    await expect.poll(() => panel.locator('button').evaluateAll((buttons) => buttons.filter((button) => {
      const box = button.getBoundingClientRect()
      return [[.1, .1], [.9, .1], [.5, .5], [.1, .9], [.9, .9]].some(([x, y]) =>
        !button.contains(document.elementFromPoint(box.x + box.width * x!, box.y + box.height * y!)))
    }).map((button) => button.textContent))).toEqual([])
    for (const name of ['关闭', '下载原文件', '目录设置', '返回网盘']) {
      const button = panel.getByRole('button', { name, exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      await button.click({ trial: true })
    }
    await panel.getByRole('button', { name: '关闭', exact: true }).tap()
    await expect(panel).not.toBeVisible()
    await expect(frame(page).locator('#reader-more-toggle')).toBeFocused()
    await expect(frame(page).locator('.reader-footer')).toBeVisible()
  }
  await frame(page).locator('#reader-more-toggle').tap()
  await panel.getByRole('button', { name: '返回网盘', exact: true }).tap()
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('iOS 主屏幕安全区由宿主统一预留，历史滚动和错误高度不影响正文，边缘跟随主题', async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }))
  await page.setViewportSize({ width: 393, height: 852 })
  await install(page)
  // 桌面浏览器没有刘海环境变量，注入宿主安全区模拟 iOS；不向 iframe 注入留白。
  await page.addStyleTag({ content: ':root { --safe-top: 59px; --safe-bottom: 34px; --safe-left: 0px; --safe-right: 0px; }' })
  await expect(page.locator('html')).toHaveClass(/is-standalone/)
  await open(page, '长篇.txt')
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px'
    document.documentElement.style.setProperty('--app-height', '700px')
    window.scrollTo(0, 80)
  })
  const checkBounds = async (x: number, y: number, width: number, height: number) => {
    await expect.poll(() => page.locator('iframe').boundingBox()).toEqual({ x, y, width, height })
    await expect.poll(() => frame(page).locator('#viewport').boundingBox()).toEqual({ x, y, width, height })
    expect(await frame(page).locator('body').evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true)
  }
  await checkBounds(0, 59, 393, 759)
  await revealReader(page); await frame(page).locator('#preferences-toggle').click()
  for (const [theme, color] of [['sepia', 'rgb(244, 235, 214)'], ['dark', 'rgb(20, 29, 28)'], ['light', 'rgb(245, 246, 242)'], ['sepia', 'rgb(244, 235, 214)']]) {
    await frame(page).locator('#theme').selectOption(theme!)
    await expect(page.locator('.app-host')).toHaveCSS('background-color', color!)
    await expect(frame(page).locator('body')).toHaveCSS('background-color', color!)
  }
  await closeReaderPanel(page); await tapContent(page)
  await checkBounds(0, 59, 393, 759)
  await page.screenshot({ path: info.outputPath('图书-iOS主屏幕-护眼安全区.png') })
  await page.setViewportSize({ width: 852, height: 393 })
  await page.addStyleTag({ content: ':root { --safe-top: 0px; --safe-bottom: 21px; --safe-left: 59px; --safe-right: 59px; }' })
  await checkBounds(59, 0, 734, 372)
  await revealReader(page)
  const toolbar = (await frame(page).locator('.reader-toolbar').boundingBox())!
  const footer = (await frame(page).locator('.reader-footer').boundingBox())!
  expect(toolbar.x).toBeGreaterThanOrEqual(59); expect(footer.y + footer.height).toBeLessThanOrEqual(372)
  await page.screenshot({ path: info.outputPath('图书-iOS主屏幕-横屏安全区.png') })
  await page.evaluate(() => { document.body.style.minHeight = ''; window.scrollTo(0, 0) })
  await frame(page).locator('#back').click()
  await expect(page.locator('.host-toolbar')).toBeVisible()
  await expect(page.locator('.app-host')).not.toHaveClass(/is-immersive/)
  expect(await page.locator('.app-host').evaluate((node) => (node as HTMLElement).style.backgroundColor)).toBe('')
})

for (const name of ['分页.epub', '中文.pdf']) {
  test(`iOS 安全区内的 ${name} 填满 iframe 且菜单不越界`, async ({ page }) => {
    await install(page)
    await page.addStyleTag({ content: ':root { --safe-top: 59px; --safe-bottom: 34px; }' })
    await open(page, name)
    await expect.poll(() => frame(page).locator('#viewport').boundingBox()).toEqual({ x: 0, y: 59, width: 390, height: 751 })
    await revealReader(page)
    const footer = (await frame(page).locator('.reader-footer').boundingBox())!
    expect(footer.y + footer.height).toBeLessThanOrEqual(810)
    if (name.endsWith('.pdf')) await expect(frame(page).locator('canvas')).toHaveCSS('width', '366px')
    else {
      await setMode(page, 'page')
      await expect(frame(page).locator('.flow-pages')).toHaveCSS('height', '727px')
      await frame(page).locator('#next').click()
      await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '1')
    }
  })
}

test('TXT 字符锚点跨模式字号横竖屏与重开保持可见，跨分段前后翻不丢字', async ({ page }, info) => {
  await install(page); await open(page, '长篇.txt')
  await frame(page).locator('#viewport').evaluate((node) => { node.scrollTop = 1400 })
  await revealReader(page); await frame(page).locator('#retry-save').click()
  await expect(frame(page).locator('#sync')).toHaveText('已同步')
  const original = (await savedLocation(page)).offset!; expect(original).toBeGreaterThan(300)
  await setMode(page, 'page')
  await expect.poll(() => anchorVisible(page, original)).toBe(true)
  await frame(page).locator('#preferences-toggle').click()
  await frame(page).locator('#font-size').evaluate((node) => { const input = node as HTMLInputElement; input.value = '26'; input.dispatchEvent(new Event('change')); input.value = '30'; input.dispatchEvent(new Event('change')) })
  await expect(frame(page).locator('.flow-content')).toHaveCSS('font-size', '30px')
  await closeReaderPanel(page)
  await expect.poll(() => anchorVisible(page, original)).toBe(true)
  await page.setViewportSize({ width: 844, height: 390 })
  await expect.poll(() => frame(page).locator('.flow-pages').evaluate((node) => node.clientWidth)).toBe(820)
  await expect.poll(() => anchorVisible(page, original)).toBe(true)
  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await page.screenshot({ path: info.outputPath('图书-手机横屏.png') })
  await revealReader(page); await frame(page).locator('#back').click(); await open(page, '长篇.txt')
  await expect(frame(page).locator('#viewport')).toHaveAttribute('data-mode', 'page')
  await expect.poll(() => anchorVisible(page, original)).toBe(true)
  await setMode(page, 'scroll'); await expect.poll(() => anchorVisible(page, original)).toBe(true)
  await setMode(page, 'page')
  await frame(page).locator('.flow-pages').evaluate((node) => { node.scrollLeft = node.scrollWidth })
  await expect.poll(async () => { const node = frame(page).locator('#position'); return Number(await node.getAttribute('data-page')) === Number(await node.getAttribute('data-pages')) - 1 }).toBe(true)
  await frame(page).locator('#next').click()
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '1')
  await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '0')
  await frame(page).locator('#previous').click()
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  await expect.poll(async () => { const node = frame(page).locator('#position'); return Number(await node.getAttribute('data-page')) === Number(await node.getAttribute('data-pages')) - 1 }).toBe(true)
})

test('桌面保留导航，跨设备以字符恢复分页和书签，冲突能唤出操作', async ({ page, browser }, info) => {
  await install(page); await open(page, '长篇.txt'); await setMode(page, 'page')
  await frame(page).locator('#next').click(); await frame(page).locator('#next').click()
  await expect(frame(page).locator('#sync')).toHaveText('已同步')
  const original = (await savedLocation(page)).offset!
  await frame(page).locator('#bookmarks-toggle').click()
  await frame(page).locator('#bookmark-name').fill('跨排版书签'); await frame(page).locator('#add-bookmark').click()
  await expect(frame(page).getByRole('textbox', { name: '修改书签名称' })).toHaveValue('跨排版书签')
  await closeReaderPanel(page); await tapContent(page)
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4187', viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false })
  try {
    await context.addCookies(await page.context().cookies())
    const desktop = await context.newPage(); await install(desktop); await open(desktop, '长篇.txt')
    await expect(desktop.locator('.host-toolbar')).toBeVisible()
    await expect(frame(desktop).locator('.reader-toolbar')).toBeVisible()
    await expect(frame(desktop).locator('#viewport')).toHaveAttribute('data-mode', 'page')
    await expect(frame(desktop).locator('.flow-pages')).toHaveCSS('width', '760px')
    await expect.poll(() => anchorVisible(desktop, original)).toBe(true)
    await frame(desktop).locator('#bookmarks-toggle').click()
    await expect(frame(desktop).getByRole('textbox', { name: '修改书签名称' })).toHaveValue('跨排版书签')
    await page.screenshot({ path: info.outputPath('图书-手机跨设备进度.png') })
    await desktop.screenshot({ path: info.outputPath('图书-桌面分页.png') })
    await frame(desktop).locator('#next').click(); await expect(frame(desktop).locator('#sync')).toHaveText('已同步')
    const remote = (await savedLocation(desktop)).offset!
    await page.bringToFront(); await tapContent(page, .9)
    await expect(frame(page).locator('#conflict')).toBeVisible()
    await expect(frame(page).locator('.reader-toolbar')).toBeVisible()
    await frame(page).locator('#use-cloud').click()
    await expect(frame(page).locator('#conflict')).not.toBeVisible()
    await expect.poll(() => anchorVisible(page, remote)).toBe(true)
  } finally { await context.close() }
})

test('EPUB 同文档多目录锚点不重复章节，内部链接图片和旧进度保持兼容', async ({ page }) => {
  await install(page); await open(page, '分页.epub'); await setMode(page, 'page')
  await expect(frame(page).locator('#toc option')).toHaveText(['起点', '同章中点', '终点'])
  await expect(frame(page).locator('#jump')).toHaveAttribute('max', '2')
  await tapContent(page)
  await frame(page).getByRole('link', { name: '前往同章中点', exact: true }).click()
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  await expect.poll(async () => Number(await frame(page).locator('#position').getAttribute('data-page'))).toBeGreaterThan(0)
  await expect.poll(() => frame(page).locator('img[alt="分页插图"]').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(240)
  await expect.poll(() => frame(page).locator('#book-middle').evaluate((node) => {
    const rect = node.getBoundingClientRect(), box = document.querySelector('.flow-pages')!.getBoundingClientRect()
    return rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.bottom > box.top
  })).toBe(true)
  await revealReader(page); await frame(page).locator('#toc-toggle').click()
  await frame(page).locator('#toc').selectOption({ label: '终点' })
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '1')
  await expect(frame(page).locator('#next')).toBeDisabled()
  await frame(page).locator('#previous').click()
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  await expect.poll(async () => { const node = frame(page).locator('#position'); return Number(await node.getAttribute('data-page')) === Number(await node.getAttribute('data-pages')) - 1 }).toBe(true)
  await frame(page).locator('#next').click(); await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '1')
  await frame(page).locator('#back').click()
  await frame(page).locator('body').evaluate(async () => {
    const drive = (window as any).tgdrive
    const record = (await drive.storage.list({ prefix: 'progress:', limit: 20 })).records[0]
    await drive.storage.set(record.key, { ...record.value, location: { format: 'epub', index: 1, entry: 'Book/one.xhtml#middle' } }, record.revision)
  })
  await open(page, '分页.epub')
  await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  await expect.poll(async () => Number(await frame(page).locator('#position').getAttribute('data-page'))).toBeGreaterThan(0)
})

test('小屏 PDF 适宽，加载失败和取消都恢复宿主导航', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await install(page); await open(page, '中文.pdf')
  await expect(frame(page).locator('canvas')).toHaveCSS('width', '336px')
  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await tapContent(page, .9); await expect(frame(page).locator('#position')).toHaveText('2 / 3')
  await revealReader(page); await frame(page).locator('#preferences-toggle').click()
  await frame(page).locator('#zoom').selectOption('1.5')
  await expect(frame(page).locator('#viewport')).toHaveAttribute('data-swipe', 'false')
  await closeReaderPanel(page); await tapContent(page); await swipe(page, .8, .2)
  await expect(frame(page).locator('#position')).toHaveText('2 / 3')
  await expect.poll(() => frame(page).locator('#viewport').evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
  await revealReader(page); await frame(page).locator('#preferences-toggle').click(); await frame(page).locator('#zoom').selectOption('1')
  await expect(frame(page).locator('canvas')).toHaveCSS('width', '336px')
  await closeReaderPanel(page); await tapContent(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(frame(page).locator('canvas')).toHaveCSS('width', '820px')
  await expect(frame(page).locator('#position')).toHaveText('2 / 3')
  await page.screenshot({ path: info.outputPath('图书-PDF-触摸横屏.png') })
  await revealReader(page); await frame(page).locator('#back').click()
  await frame(page).getByRole('button', { name: /损坏.epub/ }).click()
  await expect(frame(page).locator('#retry-reader')).toBeVisible()
  await expect(page.locator('.host-toolbar')).toBeVisible()
  await frame(page).locator('#back').click()
  await page.request.post('/__apps_fixture/media', { data: { enabled: true } })
  await frame(page).getByRole('button', { name: /长篇.txt/ }).click()
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/media')).json()).active).toBeGreaterThan(0)
  await frame(page).locator('#back').click()
  await expect(page.locator('.host-toolbar')).toBeVisible()
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/media')).json()).active).toBe(0)
})

test('纯图片章节不会在加载期间把末页进度覆盖成首页，停用恢复宿主', async ({ page }) => {
  await install(page); await open(page, '纯图.epub'); await setMode(page, 'page')
  await expect(frame(page).locator('#position')).toHaveAttribute('data-pages', '4')
  // 通过实际导航翻完四张图片，不能直接改隐藏分页容器绕开导航与重排队列。
  for (let index = 1; index < 4; index++) {
    await frame(page).locator('#next').click()
    await expect(frame(page).locator('#position')).toHaveAttribute('data-page', String(index))
    await expect(frame(page).locator('#position')).toHaveAttribute('data-section', '0')
  }
  await expect(frame(page).locator('#sync')).toHaveText('已同步')
  await frame(page).locator('#retry-save').click()
  await expect.poll(async () => (await savedLocation(page) as any).ratio).toBe(1)
  await frame(page).locator('#back').click(); await open(page, '纯图.epub')
  await expect.poll(async () => Number(await frame(page).locator('#position').getAttribute('data-pages'))).toBeGreaterThan(1)
  await expect.poll(async () => { const node = frame(page).locator('#position'); return Number(await node.getAttribute('data-page')) === Number(await node.getAttribute('data-pages')) - 1 }).toBe(true)
  await expect.poll(async () => (await savedLocation(page) as any).ratio).toBe(1)
  expect((await page.request.post('/api/apps/books/state', { data: { enabled: false } })).ok()).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('tgdrive-apps-changed')))
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.host-toolbar')).toBeVisible()
  await expect(page.getByRole('button', { name: '前往应用中心', exact: true })).toBeVisible()
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover')
})

test('仅支持基础沉浸的旧宿主不接收背景扩展，仍能正常阅读', async ({ page }) => {
  await page.addInitScript(() => {
    if (parent === window) return
    window.addEventListener('message', (event) => {
      if (event.data?.channel === 'tgdrive-app-v1' && event.data?.type === 'connect') event.data.context.capabilities = ['ui.setImmersive']
    }, { capture: true })
  })
  await install(page); await open(page, '长篇.txt')
  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await revealReader(page); await frame(page).locator('#preferences-toggle').click()
  await frame(page).locator('#theme').selectOption('sepia')
  await expect(frame(page).locator('body')).toHaveAttribute('data-theme', 'sepia')
  expect(await page.locator('.app-host').evaluate((node) => (node as HTMLElement).style.backgroundColor)).toBe('')
  await closeReaderPanel(page); await frame(page).locator('#back').click()
  await expect(page.locator('.host-toolbar')).toBeVisible()
})

test('未声明沉浸能力的旧宿主保留工具栏，图书分页仍可正常使用', async ({ page }) => {
  await page.addInitScript(() => {
    if (parent === window) return
    window.addEventListener('message', (event) => {
      if (event.data?.channel === 'tgdrive-app-v1' && event.data?.type === 'connect') delete event.data.context.capabilities
    }, { capture: true })
  })
  await install(page); await open(page, '长篇.txt')
  await expect(page.locator('.host-toolbar')).toBeVisible()
  await setMode(page, 'page'); await tapContent(page); await tapContent(page, .9)
  await expect(frame(page).locator('#position')).toHaveAttribute('data-page', '1')
  await page.getByRole('button', { name: '返回文件', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('漫画在手机上全屏沉浸显示，贴边无留白，支持轻点两侧和滑动翻页及 RTL 联动', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message))
  const index = await (await page.request.get('/api/apps')).json()
  const comic = index.available.find((item: any) => item.manifest.id === 'comics')
  expect(comic).toBeTruthy()
  expect((await page.request.post('/api/apps/catalog/comics/install', { data: { digest: comic.digest } })).ok()).toBe(true)
  expect((await page.request.patch('/api/apps/comics/settings', { data: { source_dir: '/测试漫画' } })).ok()).toBe(true)
  await page.goto('/apps/comics')
  await expect(frame(page).locator('#items button').first()).toBeVisible()
  await frame(page).getByRole('button', { name: /自然页序.cbz/ }).click()
  await expect(frame(page).locator('#reading-status')).toHaveText('')
  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await expect(frame(page).locator('.app-header')).not.toBeVisible()
  await expect(frame(page).locator('.reader-toolbar')).not.toBeVisible()
  await expect(frame(page).locator('.reader-footer')).not.toBeVisible()
  const viewport = frame(page).locator('#viewport')
  expect(await viewport.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('0px')
  expect(await viewport.evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px')
  await tapContent(page)
  await expect(frame(page).locator('.reader-toolbar')).toBeVisible()
  await expect(frame(page).locator('.reader-footer')).toBeVisible()
  await frame(page).locator('#preferences-toggle').click()
  const panel = frame(page).getByRole('dialog', { name: '阅读设置', exact: true })
  await expect(panel).toBeVisible()
  await frame(page).locator('#mode').selectOption('page')
  await closeReaderPanel(page)
  await tapContent(page)
  await expect(frame(page).locator('.reader-footer')).not.toBeVisible()
  await expect(frame(page).locator('.comic-page figcaption')).not.toBeVisible()
  expect(await viewport.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden')
  await tapContent(page, .9)
  await expect(frame(page).locator('#position')).toHaveText('2 / 3')
  await swipe(page, .8, .2)
  await expect(frame(page).locator('#position')).toHaveText('3 / 3')
  await tapContent(page)
  await frame(page).locator('#preferences-toggle').click()
  await frame(page).locator('#direction').selectOption('rtl')
  await closeReaderPanel(page)
  await tapContent(page)
  await tapContent(page, .9)
  await expect(frame(page).locator('#position')).toHaveText('2 / 3')
  await tapContent(page, .1)
  await expect(frame(page).locator('#position')).toHaveText('3 / 3')
  await tapContent(page)
  await frame(page).locator('#back').click()
  await expect(page.locator('.host-toolbar')).toBeVisible()
  expect(errors).toEqual([])
})
