import { expect, test, type Page } from '@playwright/test'
import { revealReader, closeReaderPanel } from './reader-helpers'
const base = 'http://127.0.0.1:4187'
async function authenticate(page: Page) {
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
}
async function install(page: Page, id: string, directory: string) {
  const index = await (await page.request.get('/api/apps')).json()
  const app = index.available.find((item: any) => item.manifest.id === id)
  expect(app).toBeTruthy()
  expect((await page.request.post(`/api/apps/catalog/${id}/install`, { data: { digest: app.digest } })).ok()).toBe(true)
  expect((await page.request.patch(`/api/apps/${id}/settings`, { data: { source_dir: directory } })).ok()).toBe(true)
  await page.goto(`/apps/${id}`)
  await expect(page.locator('.host-status')).toHaveCount(0)
  // 阅读馆重构后应用先落在首页；先进入「书库」视图再等待完整列表。
  await expect(page.frameLocator('iframe').locator('#btn-home-view-all')).toBeVisible()
  await page.frameLocator('iframe').locator('#btn-home-view-all').click()
  await expect(page.frameLocator('iframe').locator('#items button').first()).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await authenticate(page)
  await page.request.post('/__apps_fixture/media', { data: { enabled: false } })
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
})

test('漫画封面写入服务器封面库，重新打开直接显示而不再读取归档', async ({ page }) => {
  const reads: number[] = []
  page.on('request', request => {
    const match = /\/api\/apps\/media\/([^/?]+)/.exec(request.url())
    if (!match) return
    const claim = JSON.parse(Buffer.from(match[1]!.split('.')[0]!, 'base64url').toString())
    if (claim.purpose === 'preview' || claim.purpose === 'bytes') reads.push(claim.node_id)
  })
  await install(page, 'comics', '/测试漫画')
  const frame = page.frameLocator('iframe')
  const cover = frame.locator('#items .library-card:has-text("自然页序.cbz") .cover-art')
  const background = () => cover.evaluate(node => getComputedStyle(node).backgroundImage)
  await expect.poll(background).toMatch(/^url\("data:image\//)
  const id = await frame.locator('body').evaluate(async () => (await (window as any).tgdrive.files.stat({ path: '/测试漫画/自然页序.cbz' })).id as number)
  expect(reads).toContain(id)
  await expect.poll(async () => (await (await page.request.get('/api/apps/comics/covers')).json()).entries).toBeGreaterThan(0)
  reads.length = 0
  await page.reload()
  await expect(page.locator('.host-status')).toHaveCount(0)
  await frame.locator('#btn-home-view-all').click()
  await expect.poll(background).toMatch(/^url\("data:image\//)
  expect(reads).not.toContain(id)
})

test('反复冷启动后图书和漫画的首次点击均进入阅读器', async ({ page }) => {
  for (const [id, directory, file] of [['books', '/测试图书', 'GBK.txt'], ['comics', '/测试漫画', '自然页序.cbz']]) {
    await install(page, id!, directory!)
    for (let opening = 0; opening < 3; opening++) {
      const frame = page.frameLocator('iframe')
      if (opening) {
        await page.reload()
        await expect(frame.locator('#btn-home-view-all')).toBeVisible()
        await frame.locator('#btn-home-view-all').click()
        await expect(frame.locator('#items button').first()).toBeVisible()
      }
      await frame.locator('#items').getByRole('button', { name: new RegExp(file!) }).click()
      await expect(frame.locator('#reader')).toBeVisible()
      await expect(frame.locator('#reading-status')).toHaveText('')
      await expect(frame.locator('#position')).not.toHaveText('')
    }
  }
})

test('图书在真实沙箱中阅读长 TXT、EPUB 2/3 和含中文字体的 PDF', async ({ page }, info) => {
  const errors: string[] = [], outside: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) outside.push(request.url()) })
  await install(page, 'books', '/测试图书')
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: /长篇.txt/ }).click()
  await expect(frame.locator('#reader')).toBeVisible()
  await expect(frame.locator('#reading-status')).toHaveText('')
  // #toc 在导航面板内，需先打开面板（面板默认收起）。
  await frame.locator('#toc-toggle').click()
  await frame.locator('#toc').selectOption({ label: '第2章 终点' })
  await expect(frame.locator('#viewport')).toContainText('超过 256 KiB 的正文结尾')
  await frame.locator('#bookmarks-toggle').click()
  await frame.locator('#bookmark-name').fill('末尾书签')
  await frame.locator('#add-bookmark').click()
  await expect(frame.getByRole('textbox', { name: '修改书签名称' })).toHaveValue('末尾书签')
  await frame.locator('#back').click()
  for (const [file, content] of [['GBK.txt','你好'], ['UTF16.txt','UTF16 中文正文']]) {
    await frame.getByRole('button', { name: new RegExp(file!) }).click()
    await expect(frame.locator('#viewport')).toContainText(content!)
    await frame.locator('#back').click()
  }
  for (const file of ['示例2.epub', '示例3.epub']) {
    await frame.getByRole('button', { name: new RegExp(file) }).click()
    await expect(frame.locator('#reading-status')).toHaveText('')
    await expect(frame.locator('#book-title')).toContainText('阅读器测试')
    await expect(frame.locator('#viewport')).toContainText('这是一段中文图书正文')
    await expect.poll(() => frame.locator('img[alt="合成插图"]').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(240)
    expect(await frame.locator('body').evaluate(() => (window as any).__readerInjected ?? false)).toBe(false)
    await expect(frame.locator('#viewport script, #viewport style, #viewport iframe')).toHaveCount(0)
    await frame.getByRole('link', { name: '前往终点' }).click()
    await expect(frame.locator('#viewport')).toContainText('终点：章节跳转成功')
    await frame.locator('#back').click()
  }
  await frame.getByRole('button', { name: /中文.pdf/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('', { timeout: 30000 })
  await expect(frame.locator('#book-title')).toHaveText('中文阅读验收')
  await expect(frame.locator('canvas')).toBeVisible()
  const ink = await frame.locator('canvas').evaluate((node) => {
    const canvas = node as HTMLCanvasElement, data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, Math.floor(canvas.height * .3)).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100 && data[i + 3]! > 0) dark++
    return dark
  })
  expect(ink).toBeGreaterThan(100)
  await frame.locator('#next').click(); await expect(frame.locator('#position')).toHaveText('2 / 3')
  const pdfWidthError = (zoom = 1) => frame.locator('#viewport').evaluate((node, scale) => {
    const width = node.querySelector('canvas')?.getBoundingClientRect().width ?? 0
    const style = getComputedStyle(node)
    return Math.abs(width - (node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * scale)
  }, zoom)
  await frame.locator('#preferences-toggle').click()
  await frame.locator('#zoom').selectOption('1.5')
  await expect.poll(() => pdfWidthError(1.5)).toBeLessThan(1)
  await frame.locator('#zoom').selectOption('1')
  await expect.poll(() => pdfWidthError()).toBeLessThan(1)
  await frame.locator('#preferences-toggle').click()
  await page.screenshot({ path: info.outputPath('图书-PDF-桌面.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  // 旧画布仍可见不代表已适配窄屏，必须等待实际适宽重绘再验收。
  await expect.poll(() => pdfWidthError()).toBeLessThan(1)
  await expect(frame.locator('#position')).toHaveText('2 / 3')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('图书-PDF-手机.png') })
  await revealReader(page)
  await frame.locator('#back').click()
  const fonts: string[] = []
  page.on('response', (response) => { if (response.url().includes('/standard_fonts/') && response.ok()) fonts.push(response.url()) })
  await frame.getByRole('button', { name: /标准字体.pdf/ }).click()
  await expect(frame.locator('canvas')).toBeVisible()
  await expect(frame.locator('#reading-status')).toHaveText('')
  expect(fonts.length).toBeGreaterThan(0)
  expect(outside).toEqual([]); expect(errors).toEqual([])
})

test('漫画自然页序、两种模式、目录分章和有界归档读取', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await install(page, 'comics', '/测试漫画')
  const frame = page.frameLocator('iframe')
  // 首页视图的最近网格也用 .library-card 且在 DOM 中更靠前，此处只看书库网格卡片。
  await expect(frame.locator('#items .library-card .card-cover').first()).toBeVisible()
  await expect.poll(async () => {
    return await frame.locator('#items .library-card:has-text("自然页序.cbz") .cover-art').evaluate((node) => {
      return getComputedStyle(node).backgroundImage
    })
  }).toMatch(/blob:|url\(/)
  await frame.locator('#items').getByRole('button', { name: /自然页序.cbz/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await expect(frame.locator('#toc option')).toHaveText(['1 · 1.png', '2 · 2.png', '3 · 10.png'])
  await expect.poll(() => frame.locator('img[alt="1.png"]').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(240)
  await frame.locator('#preferences-toggle').click()
  await frame.locator('#comic-mode').selectOption('single')
  await expect(frame.locator('.comic-page')).toHaveCount(1)
  await frame.locator('#next').click(); await expect(frame.locator('#position')).toHaveText('2 / 3')
  await frame.locator('#direction').selectOption('rtl')
  await frame.locator('#viewport').focus(); await page.keyboard.press('ArrowLeft')
  await expect(frame.locator('#position')).toHaveText('3 / 3')
  await page.screenshot({ path: info.outputPath('漫画-单页.png') })
  await frame.locator('#back').click()
  await frame.locator('#items').getByRole('button', { name: /第1章/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await expect(frame.locator('#toc option')).toHaveText(['1 · 1.png', '2 · 2.png', '3 · 10.png'])
  await frame.locator('#back').click()
  await page.request.post('/__apps_fixture/media', { data: { enabled: false } })
  await frame.locator('#items').getByRole('button', { name: /大漫画.zip/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('', { timeout: 30000 })
  await expect.poll(() => frame.locator('.comic-page img').first().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(768)
  const stats = await (await page.request.get('/__apps_fixture/media')).json()
  expect(stats.range_bytes).toBeLessThan(16 * 1024 * 1024)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.locator('#app')).toHaveClass(/immersive/)
  await revealReader(page)
  await frame.locator('#preferences-toggle').click()
  await frame.locator('#comic-mode').selectOption('scroll')
  await expect(frame.locator('.comic-page')).toHaveCount(3)
  expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('漫画-手机条漫.png') })
  expect(errors).toEqual([])
})

test('跨浏览器恢复进度、书签及并发冲突保护', async ({ page, browser }) => {
  await install(page, 'books', '/测试图书')
  const first = page.frameLocator('iframe')
  await first.getByRole('button', { name: /中文.pdf/ }).click()
  await expect(first.locator('#reading-status')).toHaveText('')
  await first.locator('#next').click(); await expect(first.locator('#sync')).toHaveText('已同步')
  await first.locator('#bookmarks-toggle').click(); await first.locator('#bookmark-name').fill('跨设备书签'); await first.locator('#add-bookmark').click()
  await expect(first.getByRole('textbox', { name: '修改书签名称' })).toHaveValue('跨设备书签')
  const context = await browser.newContext({ baseURL: base })
  const secondPage = await context.newPage(); await authenticate(secondPage); await secondPage.goto('/apps/books'); await secondPage.bringToFront()
  await expect(secondPage.locator('.host-status')).toHaveCount(0)
  const second = secondPage.frameLocator('iframe')
  await expect(second.locator('#btn-home-view-all')).toBeVisible()
  await second.locator('#btn-home-view-all').click()
  await expect(second.locator('#items button').first()).toBeVisible()
  await second.getByRole('button', { name: /中文.pdf/ }).click()
  await expect(second.locator('#reader')).toBeVisible()
  await expect(second.locator('#reading-status')).toHaveText('')
  await expect(second.locator('#position')).toHaveText('2 / 3')
  await second.locator('#bookmarks-toggle').click(); await expect(second.getByRole('textbox', { name: '修改书签名称' })).toHaveValue('跨设备书签')
  await second.locator('#next').click(); await expect(second.locator('#sync')).toHaveText('已同步')
  await page.bringToFront()
  await first.locator('#previous').click()
  await expect(first.locator('#conflict')).toBeVisible()
  await first.locator('#use-cloud').click(); await expect(first.locator('#position')).toHaveText('3 / 3')
  await context.close()
})

test('长漫画窗口、末页定位及 TXT 调整字号后保持字符位置', async ({ page }) => {
  await install(page, 'comics', '/测试漫画')
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: /长册.cbz/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await frame.locator('#toc-toggle').click(); await frame.locator('#jump').fill('100'); await frame.locator('#jump-button').click()
  await expect(frame.locator('#position')).toHaveText('100 / 200')
  await expect(frame.locator('.comic-page')).toHaveCount(5)
  await frame.locator('#toc-toggle').click(); await frame.locator('#jump').fill('200'); await frame.locator('#jump-button').click()
  await expect(frame.locator('#position')).toHaveText('200 / 200')
  await expect.poll(() => frame.locator('img[alt="200.png"]').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(120)
  await expect(frame.locator('#position')).toHaveText('200 / 200')
  await frame.locator('#back').click(); await frame.getByRole('button', { name: /长册.cbz/ }).click()
  await expect(frame.locator('#position')).toHaveText('200 / 200')
  await page.setViewportSize({ width:390,height:844 })
  await expect(frame.locator('#position')).toHaveText('200 / 200')
  await install(page, 'books', '/测试图书')
  await frame.getByRole('button', { name: /长篇.txt/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await frame.locator('#viewport').evaluate((node) => { node.scrollTop = 1000 })
  await revealReader(page)
  await frame.locator('#retry-save').click(); await expect(frame.locator('#sync')).toHaveText('已同步')
  const saved = () => frame.locator('body').evaluate(async () => (await (window as any).tgdrive.storage.list({prefix:'progress:',limit:1})).records[0].value.location.offset as number)
  const before = await saved(); expect(before).toBeGreaterThan(100)
  await frame.locator('#preferences-toggle').click()
  await frame.locator('#font-size').evaluate((node) => { const range=node as HTMLInputElement; range.value='26'; range.dispatchEvent(new Event('change')); range.value='30'; range.dispatchEvent(new Event('change')) })
  await expect(frame.locator('.flow-content')).toHaveCSS('font-size','30px')
  await closeReaderPanel(page)
  await frame.locator('#retry-save').click(); await expect(frame.locator('#sync')).toHaveText('已同步')
  expect(Math.abs((await saved())-before)).toBeLessThan(150)
})

test('坏归档被拒绝，退出阅读取消服务端范围读取', async ({ page }) => {
  await install(page, 'comics', '/测试漫画')
  const frame = page.frameLocator('iframe')
  for (const file of ['越界.zip','超限.zip']) {
    await frame.getByRole('button', { name: new RegExp(file) }).click()
    await expect(frame.locator('#retry-reader')).toBeVisible()
    await expect(frame.locator('.comic-page img')).toHaveCount(0)
    await frame.locator('#back').click()
  }
  await page.request.post('/__apps_fixture/media', { data: { enabled: true } })
  await frame.getByRole('button', { name: /大漫画.zip/ }).click()
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/media')).json()).active).toBeGreaterThan(0)
  await page.getByRole('button', { name: '返回文件', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/media')).json()).active, { timeout: 5000 }).toBe(0)
})

test('条漫模式连续滚动时平滑推进，跨页不跳动不闪烁', async ({ page }) => {
  await install(page, 'comics', '/测试漫画')
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: /长册.cbz/ }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  const viewport = frame.locator('#viewport')
  let lastScrollTop = 0
  for (let step = 1; step <= 5; step++) {
    await viewport.evaluate((node, step) => { node.scrollTop = step * 600 }, step)
    await page.waitForTimeout(60)
    const currentScrollTop = await viewport.evaluate((node) => node.scrollTop)
    expect(currentScrollTop).toBeGreaterThan(lastScrollTop)
    lastScrollTop = currentScrollTop
  }
  await expect(frame.locator('.comic-page')).toHaveCount(5)
  expect(await frame.locator('#position').textContent()).toContain('200')
})
