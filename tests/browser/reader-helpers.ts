import { expect, type Page } from '@playwright/test'
/** 夹具直接使用现行来源存储，不借助已移除的目录设置。 */
export async function seedReaderSource(page: Page, id: string, path: string, legacyPreferences = true) {
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.patch(`/api/apps/${id}/scope`, { data: { mode: 'all', paths: [] } })).ok()).toBe(true)
  const launch = await (await page.request.post(`/api/apps/${id}/launch`)).json()
  const rpc = async (method: string, params: object) => {
    const response = await page.request.post(`/api/apps/${id}/rpc`, { data: { session: launch.session, method, params } })
    expect(response.ok()).toBe(true); return response.json()
  }
  const file = await rpc('files.stat', { path })
  const source = await rpc('storage.get', { key: 'library:sources' })
  await rpc('storage.set', { key: 'library:shelves:v1', expected_revision: (await rpc('storage.get', { key: 'library:shelves:v1' }))?.revision ?? null,
    value: { schemaVersion: 1, sources: [{ name: path.split('/').pop() || '我的网盘', nodeId: file.id, path, contentVersion: file.content_version, addedAt: Date.now(), rootConfirmed: path === '/' }] } })
  // 同时保留旧来源种子用于旧包升级验收；新版阅读馆不能采用该键。
  await rpc('storage.set', { key: 'library:sources', expected_revision: source?.revision ?? null, value: { schemaVersion: 1, sources: [{ nodeId: file.id, path, contentVersion: file.content_version, addedAt: Date.now(), rootConfirmed: path === '/' }] } })
  // 原滚动/适宽回归保留显式偏好；混合书库用例保留 reader 首装分页默认值。
  if (legacyPreferences && !await rpc('storage.get', { key: 'preferences' })) {
    await rpc('storage.set', { key: 'preferences', expected_revision: null, value: { mode: 'scroll', fit: 'width' } })
  }
}
/** 选择已经由夹具显式创建的单目录书库；不使用聚合“全部内容”入口。 */
export async function enterReaderShelf(page: Page, path?: string) {
  const frame = page.frameLocator('iframe')
  const cards = frame.locator('#view-home .shelf-card')
  const card = path ? cards.filter({ hasText: path }).first() : cards.first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(frame.locator('#items .library-card').first()).toBeVisible()
}

/** 手机端先通过折叠入口打开筛选；桌面筛选常驻，无需额外操作。 */
export async function expandReaderFilters(page: Page) {
  const toggle = page.frameLocator('iframe').locator('#btn-library-filters')
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

/** 在真实宿主沙箱内通过用户表单手动创建一个书库。 */
export async function createReaderShelf(page: Page, name: string, path: string) {
  const frame = page.frameLocator('iframe')
  await frame.locator('#btn-home-create-shelf, #btn-library-create-shelf, #btn-me-create-shelf').filter({ visible: true }).first().click()
  const dialog = frame.getByRole('dialog', { name: '创建书库', exact: true })
  await dialog.getByRole('textbox', { name: '书库名称', exact: true }).fill(name)
  await dialog.getByRole('textbox', { name: '对应目录', exact: true }).fill(path)
  await dialog.getByRole('button', { name: '创建并扫描', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(frame.locator('#items .library-card').first()).toBeVisible()
}

/** 既有功能测试通过无障碍入口打开工具栏，手势另外用真实触摸上下文验收。 */
export async function revealReader(page: Page) {
  const frame = page.frameLocator('iframe')
  if (await frame.locator('#app.immersive, #app.reader-desktop').count() && !await frame.locator('#back').isVisible()) {
    await frame.locator('#viewport').focus()
    await page.keyboard.press('Escape')
  }
  await expect(frame.locator('#back')).toBeVisible()
}
export async function closeReaderPanel(page: Page) {
  const frame = page.frameLocator('iframe')
  if (await frame.locator('[role="dialog"]').count()) await page.keyboard.press('Escape')
}
