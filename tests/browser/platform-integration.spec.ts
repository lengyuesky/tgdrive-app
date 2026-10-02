import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function clean(page: Page) {
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  const data = await (await page.request.get('/api/apps')).json()
  for (const app of data.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
}
async function install(page: Page, id: string) {
  const data = await (await page.request.get('/api/apps')).json(), app = data.available.find((a: any) => a.manifest.id === id)
  const response = await page.request.post(`/api/apps/catalog/${id}/install`, { data: { digest: app.digest } })
  expect(response.ok()).toBe(true)
  const installed = await response.json(); expect(installed.scope_mode).toBe('none'); return installed
}
test.beforeEach(async ({ page }) => { await clean(page) })

test('新安装先授权，从文件打开图书并定位回文件页', async ({ page }) => {
  await install(page, 'books')
  await page.goto('/apps/books')
  await expect(page.getByRole('button', { name: '选择目录并授权' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.getByRole('button', { name: '选择目录并授权' }).click()
  const picker = page.getByRole('dialog', { name: '选择允许应用读取的目录', exact: true })
  await picker.getByTitle('/测试图书', { exact: true }).click()
  await picker.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('dialog', { name: '授权目录', exact: true }).getByRole('button', { name: '允许读取', exact: true }).click()
  await expect(page.frameLocator('iframe').locator('#btn-home-view-all')).toBeVisible()
  const installed = await (await page.request.get('/api/apps/books')).json()
  expect(installed.scope_mode).toBe('selected'); expect(installed.scope).toEqual(['/测试图书'])
  await page.goto('/files/测试图书')
  const row = page.locator('[title="GBK.txt"]').first()
  await expect(row).toBeVisible(); await row.click({ button: 'right' })
  await page.locator('.ctx-item').getByText('打开方式', { exact: true }).click()
  await page.getByRole('button', { name: '用图书打开', exact: true }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#reader')).toBeVisible()
  await expect(frame.locator('#viewport')).toContainText('中文')
  await frame.locator('#reader-more-toggle').click()
  await frame.getByRole('button', { name: '文件信息', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '文件信息', exact: true })).toContainText('/测试图书/GBK.txt')
  await page.getByRole('dialog', { name: '文件信息', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await frame.getByRole('button', { name: '在文件中显示', exact: true }).click()
  await expect(page).toHaveURL(/\/files\//)
  await expect(page.locator('[title="GBK.txt"]').first()).toBeVisible()
})

test('四款应用通过节点任务打开指定内容，记录就绪状态', async ({ page }) => {
  const files = [['books', '/测试图书/GBK.txt'], ['comics', '/测试漫画/自然页序.cbz'], ['cinema', '/测试影视/电影/示例电影.webm'], ['shorts', '/测试视频/视频1.webm']]
  for (const [id, proposed] of files) {
    await install(page, id!)
    expect((await page.request.patch(`/api/apps/${id}/scope`, { data: { mode: 'all', paths: [] } })).ok()).toBe(true)
    // 视频夹具文件名由生成器决定，按指定测试目录的元数据获取。
    let path = proposed!
    if (id === 'cinema' || id === 'shorts') {
      const launch = await (await page.request.post(`/api/apps/${id}/launch`)).json()
      const search = await (await page.request.post(`/api/apps/${id}/rpc`, { data: { session: launch.session, method: 'files.searchPage', params: { under: id === 'cinema' ? '/测试影视' : '/测试视频', extensions: ['webm'], limit: 10 } } })).json()
      path = search.results[0].path
    }
    await page.goto(`/apps/${id}?open=${encodeURIComponent(path)}`)
    const frame = page.frameLocator('iframe')
    if (id === 'books' || id === 'comics') { await expect(frame.locator('#reader')).toBeVisible(); await expect(frame.locator('#reading-status')).toHaveText('') }
    else { await expect(frame.locator('#video')).toBeVisible(); await expect.poll(() => frame.locator('#video').evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(.1) }
    await expect.poll(async () => (await (await page.request.get(`/api/apps/${id}/health`)).json()).lifecycle.phase).toBe('ready')
  }
})

test('应用详情截图来自真实渲染的合成测试库', async ({ page }) => {
  test.skip(process.env.TGDRIVE_CAPTURE_SCREENSHOTS !== '1', '截图仅在显式生成分发素材时写入')
  await page.setViewportSize({ width: 1200, height: 850 })
  for (const [id, directory] of [['books', '/测试图书'], ['comics', '/测试漫画'], ['cinema', '/测试影视'], ['shorts', '/测试视频']]) {
    const app = await install(page, id!)
    expect((await page.request.post(`/api/apps/${id}/authorize`, { data: { path: directory, expected_revision: app.revision } })).ok()).toBe(true)
    if (id !== 'cinema') expect((await page.request.patch(`/api/apps/${id}/settings`, { data: { source_dir: directory } })).ok()).toBe(true)
    await page.goto(`/apps/${id}`)
    const frame = page.frameLocator('iframe')
    if (id === 'books' || id === 'comics') { await expect(frame.locator('#btn-home-view-all')).toBeVisible(); await frame.locator('#btn-home-view-all').click(); await expect(frame.locator('#items button').first()).toBeVisible() }
    else if (id === 'cinema') await expect(frame.locator('#app')).toBeVisible()
    else await expect.poll(() => frame.locator('#video').evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(.1)
    const output = fileURLToPath(new URL(`../../${id}/screenshots/`, import.meta.url)); await mkdir(output, { recursive: true })
    await page.locator('iframe').screenshot({ path: `${output}home.png` })
  }
})
