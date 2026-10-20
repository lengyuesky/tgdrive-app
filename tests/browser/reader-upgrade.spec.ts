import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { seedReaderSource } from './reader-helpers'
import { readerDefaultPreferences } from '../../reader/state'

/** 旧包路径必须显式指向本机隔离目录，不从生产安装或远程站点取包。 */
test('阅读馆从真实 1.0.0 本地包升级到 1.0.1 保留来源、偏好、进度与书签', async ({ page }) => {
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
  expect(preview.manifest).toMatchObject({ id: 'reader', version: '1.0.0' })
  expect((await page.request.post('/api/apps/install', {
    params: { digest: preview.digest }, data: oldBytes, headers: { 'Content-Type': 'application/octet-stream' },
  })).ok()).toBe(true)
  await seedReaderSource(page, 'reader', '/混合书库', false)
  const launch = await (await page.request.post('/api/apps/reader/launch')).json()
  const rpc = async (method: string, params: object) => {
    const response = await page.request.post('/api/apps/reader/rpc', { data: { session: launch.session, method, params } })
    expect(response.ok()).toBe(true); return response.json()
  }
  const file = await rpc('files.stat', { path: '/混合书库/文字.txt' })
  const preferences = readerDefaultPreferences()
  preferences.comic.mode = 'scroll'; preferences.comic.fit = 'width'; preferences.comic.zoom = .75
  const location = { format: 'txt', index: 0, offset: 4 }
  const records = {
    preferences,
    [`progress:${file.id}`]: { file, title: '升级前文字', location },
    [`bookmark:${file.id}:upgrade`]: { title: '升级前书签', content_version: file.content_version, location },
  }
  for (const [key, value] of Object.entries(records)) await rpc('storage.set', { key, value, expected_revision: null })
  const sources = await rpc('storage.get', { key: 'library:sources' })
  const currentBytes = await readFile(new URL('../../apps/reader-1.0.1.tgapp', import.meta.url))
  await page.goto('/apps')
  await page.locator('input[type="file"][accept=".tgapp,.zip"]').setInputFiles({ name: 'reader-1.0.1.tgapp', mimeType: 'application/octet-stream', buffer: currentBytes })
  const dialog = page.getByRole('dialog', { name: '更新应用', exact: true })
  await expect(dialog).toContainText('1.0.1')
  await dialog.getByRole('button', { name: '同意并更新', exact: true }).click()
  await expect(dialog).toBeHidden()
  const installed = await (await page.request.get('/api/apps/reader')).json()
  expect(installed.manifest.version).toBe('1.0.1')
  expect(installed.digest).not.toBe(preview.digest)
  const refreshed = await (await page.request.post('/api/apps/reader/launch')).json()
  launch.session = refreshed.session
  expect(await rpc('storage.get', { key: 'library:sources' })).toEqual(sources)
  for (const [key, value] of Object.entries(records)) expect((await rpc('storage.get', { key })).value).toEqual(value)
  await page.goto('/apps/reader')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#home-recent-grid .library-card')).toHaveCount(6)
  await expect(frame.locator('#library-sidebar button[title="/混合书库"]')).toBeVisible()
  await frame.locator('[data-library-id="kind:comics"]').click()
  await expect(frame.locator('#items .library-card')).toHaveCount(3)
  await frame.locator('#items .library-card').filter({ hasText: '漫画.cbz' }).click()
  await expect(frame.locator('#reading-status')).toHaveText('')
  await expect(frame.locator('#comic-mode')).toHaveValue('scroll')
  await expect(frame.locator('#fit')).toHaveValue('width')
  await expect(frame.locator('#zoom')).toHaveValue('0.75')
  await expect(page.locator('.host-toolbar')).toBeHidden()
})
