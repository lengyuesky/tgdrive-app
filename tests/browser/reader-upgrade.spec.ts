import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createReaderShelf } from './reader-helpers'
import { defaultPreferences } from '../../reader/state'

/** 旧包路径必须显式指向本机隔离目录，不从生产安装或远程站点取包。 */
for (const migrateDefault of [false, true]) test(migrateDefault
  ? '阅读馆真实 1.0.1 升级后把旧整页默认迁移为铺满宽度，并保留阅读记录'
  : '阅读馆真实 1.0.1 升级到 1.0.4 不采用旧来源，手动重建后保留偏好、进度与书签', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const previous = process.env.TGDRIVE_READER_PREVIOUS_PACKAGE
  test.skip(!previous, '真实旧包升级验收需要显式提供 TGDRIVE_READER_PREVIOUS_PACKAGE')
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  for (const app of index.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
  const oldBytes = await readFile(previous!)
  const inspected = await page.request.post('/api/apps/inspect', { data: oldBytes, headers: { 'Content-Type': 'application/octet-stream' } })
  expect(inspected.ok()).toBe(true)
  const preview = await inspected.json()
  expect(preview.manifest).toMatchObject({ id: 'reader', version: '1.0.1' })
  expect((await page.request.post('/api/apps/install', {
    params: { digest: preview.digest }, data: oldBytes, headers: { 'Content-Type': 'application/octet-stream' },
  })).ok()).toBe(true)
  expect((await page.request.patch('/api/apps/reader/scope', { data: { mode: 'all', paths: [] } })).ok()).toBe(true)
  const launch = await (await page.request.post('/api/apps/reader/launch')).json()
  const rpc = async (method: string, params: object) => {
    const response = await page.request.post('/api/apps/reader/rpc', { data: { session: launch.session, method, params } })
    expect(response.ok()).toBe(true); return response.json()
  }
  const file = await rpc('files.stat', { path: '/混合书库/文字.txt' })
  // 重建 1.0.1 的真实 V2 结构，不把本版迁移标记写入旧包的测试数据。
  const preferences = defaultPreferences()
  preferences.text.mode = 'page'; preferences.pdf.fit = 'page'
  preferences.comic.mode = 'single'; preferences.comic.fit = 'page'
  if (!migrateDefault) { preferences.comic.mode = 'scroll'; preferences.comic.fit = 'width'; preferences.comic.zoom = .75 }
  const location = { format: 'txt', index: 0, offset: 4 }
  const records = {
    preferences,
    [`progress:${file.id}`]: { file, title: '升级前文字', location },
    [`bookmark:${file.id}:upgrade`]: { title: '升级前书签', content_version: file.content_version, location },
  }
  for (const [key, value] of Object.entries(records)) await rpc('storage.set', { key, value, expected_revision: null })
  const root = await rpc('files.stat', { path: '/混合书库' })
  await rpc('storage.set', { key: 'library:sources', expected_revision: null, value: { schemaVersion: 1, sources: [{ nodeId: root.id, path: root.path, contentVersion: root.content_version, addedAt: 1, rootConfirmed: false }] } })
  const sources = await rpc('storage.get', { key: 'library:sources' })
  const packagePath = process.env.TGDRIVE_APP_CATALOG_DIR
    ? join(process.env.TGDRIVE_APP_CATALOG_DIR, 'reader-1.0.4.tgapp')
    : new URL('../../apps/reader-1.0.4.tgapp', import.meta.url)
  const currentBytes = await readFile(packagePath)
  await page.goto('/apps')
  await page.locator('input[type="file"][accept=".tgapp,.zip"]').setInputFiles({ name: 'reader-1.0.4.tgapp', mimeType: 'application/octet-stream', buffer: currentBytes })
  const dialog = page.getByRole('dialog', { name: '更新应用', exact: true })
  await expect(dialog).toContainText('1.0.4')
  await dialog.getByRole('button', { name: '同意并更新', exact: true }).click()
  await expect(dialog).toBeHidden()
  const installed = await (await page.request.get('/api/apps/reader')).json()
  expect(installed.manifest.version).toBe('1.0.4')
  expect(installed.digest).not.toBe(preview.digest)
  const refreshed = await (await page.request.post('/api/apps/reader/launch')).json()
  launch.session = refreshed.session
  expect(await rpc('storage.get', { key: 'library:sources' })).toEqual(sources)
  for (const [key, value] of Object.entries(records)) expect((await rpc('storage.get', { key })).value).toEqual(value)
  await page.goto('/apps/reader')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('.shelf-card')).toHaveCount(0)
  expect(await rpc('storage.get', { key: 'library:shelves:v1' })).toBeNull()
  const expectedPreferences = migrateDefault
    ? { ...preferences, comicWidthDefault: 1, comic: { ...preferences.comic, fit: 'width' } }
    : preferences
  await expect.poll(async () => (await rpc('storage.get', { key: 'preferences' })).value).toEqual(expectedPreferences)
  for (const [key, value] of Object.entries(records).filter(([key]) => key !== 'preferences')) expect((await rpc('storage.get', { key })).value).toEqual(value)
  expect(await rpc('storage.get', { key: 'library:sources' })).toEqual(sources)
  await createReaderShelf(page, '我重建的书库', '/混合书库')
  await expect(frame.locator('#items .library-card')).toHaveCount(6)
  await expect(frame.locator('#library-sidebar button[title="/混合书库"]')).toBeVisible()
  await frame.locator('#filter-kind').selectOption('comics')
  await expect(frame.locator('#items .library-card')).toHaveCount(3)
  await frame.locator('#items .library-card').filter({ hasText: '漫画.cbz' }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await expect(frame.locator('#comic-mode')).toHaveValue(migrateDefault ? 'single' : 'scroll')
  await expect(frame.locator('#fit')).toHaveValue('width')
  await expect(frame.locator('#zoom')).toHaveValue(migrateDefault ? '1' : '0.75')
  await expect(page.locator('.host-toolbar')).toBeHidden()
  if (migrateDefault) {
    const image = frame.locator('#viewport img').first()
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(240)
    await expect.poll(async () => (await image.boundingBox())!.width).toBe(1280)
    const picture = (await image.boundingBox())!
    expect(picture.height).toBeGreaterThan(900)
    expect(picture.width / picture.height).toBeCloseTo(2 / 3, 3)
    const saved = await rpc('storage.get', { key: 'preferences' })
    await page.reload()
    await expect(frame.locator('.shelf-card')).toHaveCount(1)
    expect(await rpc('storage.get', { key: 'preferences' })).toEqual(saved)
  }
})
