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
  await rpc('storage.set', { key: 'library:sources', expected_revision: source?.revision ?? null, value: { schemaVersion: 1, sources: [{ nodeId: file.id, path, contentVersion: file.content_version, addedAt: Date.now(), rootConfirmed: path === '/' }] } })
  // 原滚动/适宽回归保留显式偏好；混合书库用例保留 reader 首装分页默认值。
  if (legacyPreferences && !await rpc('storage.get', { key: 'preferences' })) {
    await rpc('storage.set', { key: 'preferences', expected_revision: null, value: { mode: 'scroll', fit: 'width' } })
  }
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
