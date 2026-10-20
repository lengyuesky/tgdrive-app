import { expect, test, type Page } from '@playwright/test'
import { seedReaderSource, revealReader } from './reader-helpers'

const host = 'http://127.0.0.1:4187'
const frame = (page: Page) => page.frameLocator('iframe')

async function install(page: Page) {
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  expect((await page.request.post('/__apps_fixture/media', { data: { enabled: false } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
  const reader = index.available.find((app: { manifest: { id: string } }) => app.manifest.id === 'reader')
  expect(reader.manifest.version).toBe('1.0.1')
  expect((await page.request.post('/api/apps/catalog/reader/install', { data: { digest: reader.digest } })).ok()).toBe(true)
  await seedReaderSource(page, 'reader', '/混合书库', false)
  await page.goto('/apps/reader')
  await expect(frame(page).locator('#home-recent-grid .library-card')).toHaveCount(6)
}

async function navigate(page: Page, view: 'home' | 'library' | 'me') {
  await frame(page).locator(`#nav-${view}, #tab-${view}`).filter({ visible: true }).first().click()
  await expect(frame(page).locator(`#view-${view}`)).toBeVisible()
}

async function choose(page: Page, selector: string) {
  const trigger = frame(page).locator('#btn-mobile-libraries')
  if (await trigger.isVisible()) await trigger.click()
  await frame(page).locator('#library-sidebar').locator(selector).click()
  if (await trigger.isVisible()) await expect(frame(page).locator('#library-sidebar')).toBeHidden()
}

async function addSource(page: Page, path: string) {
  await navigate(page, 'me')
  await frame(page).locator('#input-source-path').fill(path)
  await frame(page).getByRole('button', { name: '添加目录', exact: true }).click()
  await expect(frame(page).locator('.source-item-path', { hasText: path })).toBeVisible()
  await expect(frame(page).locator('#sidebar-libraries button').filter({ has: frame(page).locator('.nav-label', { hasText: path.split('/').pop()! }) }).first()).toBeAttached()
}

async function createGroup(page: Page, name: string) {
  await navigate(page, 'library')
  await frame(page).getByRole('button', { name: '管理分组', exact: true }).click()
  await frame(page).getByRole('textbox', { name: '新分组名称', exact: true }).fill(name)
  await frame(page).getByRole('button', { name: '新建', exact: true }).click()
  await expect(frame(page).getByRole('textbox', { name: `分组名称：${name}`, exact: true })).toBeVisible()
  await frame(page).getByRole('button', { name: '完成', exact: true }).click()
  const id = await frame(page).locator('#filter-book-group option', { hasText: name }).getAttribute('value')
  expect(id).toMatch(/^[a-f0-9]{32}$/)
  return id!
}

for (const width of [390, 1280]) {
  test(`阅读馆真实宿主侧栏切换与漫画全屏适配 ${width}`, async ({ page }, info) => {
    const errors: string[] = [], outside: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(host)) outside.push(request.url()) })
    const height = 900
    await page.setViewportSize({ width, height })
    await install(page)
    await choose(page, '[data-library-id="kind:comics"]')
    const cards = frame(page).locator('#items .library-card')
    await expect(frame(page).locator('#filter-kind')).toHaveValue('comics')
    await expect(cards).toHaveCount(3)
    await addSource(page, '/混合书库/图片目录')
    await choose(page, 'button[title="/混合书库/图片目录"]')
    await expect(frame(page).locator('#filter-kind')).toHaveValue('')
    await expect(cards).toHaveCount(1)
    await expect(cards.locator('.file-mark')).toHaveText('目录')
    const groupId = await createGroup(page, '文学')
    await expect(cards).toHaveCount(6)
    await frame(page).getByRole('button', { name: '批量分组', exact: true }).click()
    await cards.filter({ hasText: '文字' }).click()
    await frame(page).getByRole('combobox', { name: '移动到分组', exact: true }).selectOption(groupId)
    await frame(page).getByRole('button', { name: '移动', exact: true }).click()
    await expect(cards.filter({ hasText: '文字' }).locator('.book-group-badge')).toHaveText('文学')
    await navigate(page, 'home')
    await choose(page, `[data-library-id="group:${groupId}"]`)
    await expect(cards).toHaveCount(1)
    await expect(frame(page).locator('#filter-book-group')).toHaveValue(groupId)
    await choose(page, '[data-library-id="kind:comics"]')
    await expect(cards).toHaveCount(3)
    await cards.filter({ hasText: '漫画.cbz' }).click()
    await expect(frame(page).locator('#position')).not.toHaveText('')
    await expect(frame(page).locator('#app')).toHaveAttribute('data-controls', width > 768 ? 'visible' : 'hidden')
    await expect(page.locator('.host-toolbar')).toBeHidden()
    const viewport = frame(page).locator('#viewport')
    const bounds = { x: 0, y: 0, width, height }
    await expect.poll(() => page.locator('iframe').boundingBox()).toEqual(bounds)
    await expect.poll(() => viewport.boundingBox()).toEqual(bounds)
    const image = viewport.locator('img').first()
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(240)
    const picture = (await image.boundingBox())!
    expect(picture.width / picture.height).toBeCloseTo(2 / 3, 3)
    expect(Math.max(picture.width / width, picture.height / height)).toBeCloseTo(1, 3)
    if (width > 768) {
      expect(picture.height).toBe(height)
      await viewport.click({ position: { x: width / 2, y: height / 2 } })
    }
    await expect(frame(page).locator('#app')).toHaveAttribute('data-controls', 'hidden')
    await page.screenshot({ path: info.outputPath(`reader-fullscreen-${width}.png`) })
    await revealReader(page)
    await frame(page).locator('#preferences-toggle').click()
    expect(await viewport.boundingBox()).toEqual(bounds)
    await frame(page).locator('#preferences [data-close-panel]').click()
    await frame(page).locator('#back').click()
    await expect(page.locator('.host-toolbar')).toBeVisible()
    await expect(frame(page).locator('#filter-kind')).toHaveValue('comics')
    await expect(cards).toHaveCount(3)
    expect(errors).toEqual([]); expect(outside).toEqual([])
  })
}

test('阅读馆新版发布截图来自真实宿主混合书库', async ({ page }, info) => {
  test.skip(process.env.TGDRIVE_CAPTURE_SCREENSHOTS !== '1', '仅在显式生成发布素材时运行')
  await page.setViewportSize({ width: 1280, height: 1000 })
  await install(page)
  await addSource(page, '/混合书库/图片目录')
  await createGroup(page, '文学与小说')
  await choose(page, '[data-library-id="format:txt"]')
  await frame(page).locator('#items .library-card').filter({ hasText: '文字' }).click()
  await expect(frame(page).locator('#position')).not.toHaveText('')
  await revealReader(page)
  await frame(page).locator('#back').click()
  await navigate(page, 'home')
  await expect(frame(page).locator('.continue-title')).toHaveText('文字')
  await expect(frame(page).locator('#library-sidebar [data-library-id^="group:"]')).toContainText('文学与小说')
  await page.locator('iframe').screenshot({ path: info.outputPath('home.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await choose(page, 'button[title="/混合书库"]')
  const cards = frame(page).locator('#items .library-card')
  await expect(cards).toHaveCount(6)
  // 封面按可见性加载；逐张滚入视口后确认真实封面，再回到顶部采集手机书库。
  for (const card of await cards.all()) {
    if (await card.locator('.file-mark').textContent() === 'TXT') continue
    await card.scrollIntoViewIfNeeded()
    await expect(card.locator('.cover-art')).toHaveClass(/has-cover/)
  }
  await frame(page).locator('.ui-content').evaluate(node => {
    const card = document.querySelector('#items .library-card')!
    node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top - 12
  })
  await page.locator('iframe').screenshot({ path: info.outputPath('mobile-library.png') })
  await frame(page).locator('#btn-mobile-libraries').click()
  await expect(frame(page).locator('#library-sidebar')).toBeVisible()
  await frame(page).locator('.sidebar-scroll').evaluate(node => { node.scrollTop = 0 })
  await page.locator('iframe').screenshot({ path: info.outputPath('mobile-sidebar.png') })
  await frame(page).locator('#btn-sidebar-dismiss').click()
  await frame(page).locator('#items .library-card').filter({ hasText: '漫画.cbz' }).click()
  await expect(frame(page).locator('#position')).not.toHaveText('')
  await expect(page.locator('.host-toolbar')).toBeHidden()
  await expect.poll(() => frame(page).locator('#viewport').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  await expect.poll(() => frame(page).locator('#viewport img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(240)
  await revealReader(page)
  await page.locator('iframe').screenshot({ path: info.outputPath('mobile-reading.png') })
})
