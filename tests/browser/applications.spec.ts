import { expect, test, type Page } from '@playwright/test'

// 宿主生命周期与独立应用导入测试已拆分至宿主仓库；本文件保留短视频插件回归用例。
test.beforeEach(async ({ page }) => {
  // 只有确认独立夹具身份后才执行安装、卸载等写操作。
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/__apps_fixture/media', { data: { enabled: false } })).ok()).toBe(true)
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
})

async function fileSidebar(page: Page) {
  const width = page.viewportSize()!.width
  if (width < 1024) {
    const toggle = page.getByRole('button', { name: width <= 767 ? '打开目录导航' : '打开侧边栏', exact: true })
    await toggle.click()
    const drawer = page.getByRole('dialog', { name: '导航', exact: true })
    await expect(drawer).toBeVisible()
    return drawer.getByRole('complementary', { name: '目录侧边栏' })
  }
  const sidebar = page.getByRole('complementary', { name: '目录侧边栏' })
  await expect(sidebar).toBeVisible()
  return sidebar
}

async function installShorts(page: Page) {
  await page.goto('/files/')
  const sidebar = await fileSidebar(page)
  const center = sidebar.getByRole('button', { name: '应用中心', exact: true })
  await expect(center).toBeVisible()
  await expect(page.locator('.topbar').getByRole('button', { name: '应用中心', exact: true })).toHaveCount(0)
  const shareBox = await sidebar.getByRole('button', { name: '分享管理', exact: true }).boundingBox()
  const appBox = await sidebar.getByRole('region', { name: '应用', exact: true }).boundingBox()
  expect(appBox!.y).toBeGreaterThanOrEqual(shareBox!.y + shareBox!.height)
  await center.click()
  await expect(page.getByRole('tab', { name: /已安装/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: /可安装/ }).click()
  await page.locator('[data-app-id="shorts"]').getByRole('button', { name: '安装', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '安装应用', exact: true })
  await expect(dialog).toContainText('读取文件内容')
  await dialog.getByRole('button', { name: '同意并安装' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-app-id="shorts"]')).toContainText('已启用')
  // 测试库还包含横屏影视与故意损坏的文件；短视频用例只随机选取自己的竖屏夹具。
  expect((await page.request.patch('/api/apps/shorts/settings', { data: { source_dir: '/测试视频' } })).ok()).toBe(true)
}

test('短视频安装、实际播放、收藏、设置与移动端布局', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  const rangeResponses: number[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/api/apps/media/') && response.status() === 206) rangeResponses.push(response.status())
  })
  await installShorts(page)
  await page.screenshot({ path: testInfo.outputPath('应用中心.png'), fullPage: true })
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#video')).toBeVisible()
  await expect.poll(() => frame.locator('#video').evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
  const dimensions = await frame.locator('#video').evaluate((node) => {
    const video = node as HTMLVideoElement
    return { width: video.videoWidth, height: video.videoHeight, boxHeight: video.getBoundingClientRect().height, viewport: innerHeight }
  })
  expect(dimensions.width).toBe(320)
  expect(dimensions.height).toBe(568)
  expect(dimensions.boxHeight).toBeLessThanOrEqual(dimensions.viewport)
  expect(rangeResponses.length).toBeGreaterThan(0)
  expect(await frame.locator('body').evaluate(() => { try { void parent.document.title; return false } catch { return true } })).toBe(true)
  const favorite = frame.locator('#favorite')
  const oldFavorite = await favorite.getAttribute('aria-pressed')
  await favorite.click()
  await expect(favorite).toHaveAttribute('aria-pressed', oldFavorite === 'true' ? 'false' : 'true')
  const previousName = await frame.locator('#video-name').innerText()
  await frame.getByRole('button', { name: '下一个视频', exact: true }).click()
  await expect(frame.locator('#video-name')).not.toHaveText(previousName)
  await page.getByRole('button', { name: '应用设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '短视频设置', exact: true })
  await settings.getByRole('button', { name: '选择目录', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择取材文件夹', exact: true })
  await picker.getByText('空目录', { exact: true }).click()
  await picker.getByRole('button', { name: '确定', exact: true }).click()
  await settings.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(frame.locator('#empty')).toBeVisible()
  await expect(frame.locator('#empty-description')).toContainText('/空目录')
  await frame.getByRole('button', { name: '选择取材文件夹' }).click()
  await expect(settings.locator('#app-setting-source_dir')).toHaveValue('/空目录')
  await settings.locator('#app-setting-source_dir').fill('/测试视频')
  await settings.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(settings).not.toBeVisible()
  await expect(frame.locator('#video')).toBeVisible()
  await expect.poll(() => frame.locator('#video').evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
  await page.screenshot({ path: testInfo.outputPath('短视频桌面.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByRole('button', { name: '下一个视频', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await frame.locator('#video').evaluate((node) => node.getBoundingClientRect().height <= innerHeight)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('短视频手机.png') })

  await expect(page.locator('.host-toolbar')).not.toBeVisible()
  await page.frameLocator('iframe').getByRole('button', { name: '退出短视频', exact: true }).click()
  await expect(page).toHaveURL(/\/files\//)
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('退出短视频会在文件传输完成前释放服务端读取', async ({ page }) => {
  await installShorts(page)
  await page.request.post('/__apps_fixture/media', { data: { enabled: true } })
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const stats = async () => (await page.request.get('/__apps_fixture/media')).json()
  await expect.poll(async () => (await stats()).active).toBeGreaterThan(0)
  await expect.poll(async () => (await stats()).bytes_sent).toBeGreaterThan(0)
  await page.getByRole('button', { name: '返回文件', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect.poll(async () => (await stats()).active, { timeout: 3000 }).toBe(0)
  const result = await stats()
  expect(result.bytes_sent).toBeLessThan(result.file_size)
})
