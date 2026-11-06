import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { FileEntry, FntvConfig, FntvStatus } from '../../sdk/types'

const username = 'fntv-public-test'
const password = 'Fntv-Public-Synthetic-2026'
const legacyDigest = 'e6d33121415fde364729b2ed820e712e85881f82722a3c6c0b9e6cc45e744779'
interface AppEntry { manifest: { id: string; version: string; min_host_version: string }; digest: string; revision: string; scope_mode: string; scope: string[] }
interface MediaItem { guid: string; media_guid: string; file_name: string }

test.beforeEach(async ({ page }) => {
  // 先核验临时夹具身份，再操作合成账号和应用数据。
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  expect((await page.request.post('/__apps_fixture/media', { data: { enabled: false } })).ok()).toBe(true)
  const apps = await (await page.request.get('/api/apps')).json() as { installed: AppEntry[] }
  for (const app of apps.installed) expect((await page.request.delete(`/api/apps/${app.manifest.id}?purge_data=true`)).ok()).toBe(true)
})

async function rpc<T>(page: Page, method: string, params: object = {}): Promise<T> {
  const launch = await page.request.post('/api/apps/fntv/launch', { data: {} })
  expect(launch.ok()).toBe(true)
  const { session } = await launch.json() as { session: string }
  const response = await page.request.post('/api/apps/fntv/rpc', { data: { session, method, params } })
  expect(response.ok()).toBe(true)
  return response.json() as Promise<T>
}

async function wire<T>(page: Page, path: string, token?: string, data?: object, method?: 'PUT'): Promise<T> {
  const response = await page.request.fetch(path, {
    method: method ?? (data === undefined ? 'GET' : 'POST'),
    headers: token ? { Authorization: token } : {},
    ...(data === undefined ? {} : { data }),
  })
  expect(response.ok()).toBe(true)
  const body = await response.json() as { code: number; data: T }
  expect(body.code).toBe(0)
  return body.data
}

async function login(page: Page) {
  return (await wire<{ token: string }>(page, '/v/api/v2/user/loginByPassword', undefined, {
    username, password: createHash('sha256').update(password).digest('hex'),
  })).token
}

async function indexedMovie(page: Page, token: string, config: FntvConfig) {
  await expect.poll(async () => (await rpc<FntvStatus>(page, 'fntv.service.status')).index.state).toBe('ready')
  const items = await wire<{ list: MediaItem[] }>(page, '/v/api/v1/item/list', token, {
    ancestor_guid: config.libraries[0].id, page: 1, page_size: 50,
  })
  const movie = items.list.find(item => item.file_name.endsWith('.mp4'))
  expect(movie).toBeTruthy()
  return movie!
}

test('公开目录安装飞牛服务，授权配置后主动启动，关闭页面继续运行', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/files/')
  await page.getByRole('complementary', { name: '目录侧边栏' }).getByRole('button', { name: '应用中心', exact: true }).click()
  await page.getByRole('tab', { name: /可安装/ }).click()
  const tile = page.locator('[data-app-id="fntv"]')
  await expect(tile).toContainText('飞牛影视服务')
  await expect(tile).toContainText('0.1.1')
  await tile.getByRole('button', { name: '安装', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '安装应用', exact: true })
  await expect(dialog).toContainText('读取文件内容')
  await expect(dialog).toContainText('影视服务')
  await dialog.getByRole('button', { name: '同意并安装', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const installed = await (await page.request.get('/api/apps/fntv')).json() as AppEntry
  expect(installed.manifest).toMatchObject({ version: '0.1.1', min_host_version: '0.3.6' })
  expect(installed.scope_mode).toBe('none')
  expect((await rpc<FntvConfig>(page, 'fntv.config.get')).running).toBe(false)

  await page.goto('/apps/fntv')
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.getByRole('button', { name: '选择目录并授权', exact: true }).click()
  const initialPicker = page.getByRole('dialog', { name: '选择允许应用读取的目录', exact: true })
  await initialPicker.getByTitle('/测试影视', { exact: true }).click()
  await initialPicker.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('dialog', { name: '授权目录', exact: true }).getByRole('button', { name: '允许读取', exact: true }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#service-state')).toHaveText('服务已停止')
  await expect(frame.locator('#start')).toBeDisabled()
  await frame.locator('#username').fill(username)
  await frame.locator('#password').fill(password)
  await frame.locator('#save-account').click()
  await expect(frame.locator('#account-state')).toHaveText('已设置独立影视账号')
  await expect(frame.locator('#password')).toHaveValue('')
  await frame.locator('#library-name').fill('公开目录测试库')
  await frame.locator('#pick-directory').click()
  const picker = page.getByRole('dialog', { name: '选择允许应用读取的目录', exact: true })
  await picker.getByTitle('/测试影视', { exact: true }).click()
  await picker.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('dialog', { name: '授权目录', exact: true }).getByRole('button', { name: '允许读取', exact: true }).click()
  await expect(frame.locator('#picked-directory')).toHaveText('/测试影视')
  await frame.locator('#add-library').click()
  await expect(frame.locator('#libraries')).toContainText('公开目录测试库')
  await expect(frame.locator('#start')).toBeEnabled()
  const scoped = await (await page.request.get('/api/apps/fntv')).json() as AppEntry
  expect(scoped.scope_mode).toBe('selected')
  expect(scoped.scope).toEqual(['/测试影视'])
  await frame.locator('#start').click()
  await expect(frame.locator('#service-state')).toHaveText('服务运行中')
  const config = await rpc<FntvConfig>(page, 'fntv.config.get')
  const token = await login(page)
  const movie = await indexedMovie(page, token, config)
  const range = await page.request.get(`/v/api/v1/media/range/${movie.media_guid}`, { headers: { Authorization: token, Range: 'bytes=4096-5119' } })
  expect(range.status()).toBe(206)
  expect(range.headers()['content-range']).toMatch(/^bytes 4096-5119\/\d+$/)
  expect((await range.body()).length).toBe(1024)

  await page.getByRole('button', { name: '返回文件', exact: true }).click()
  expect((await rpc<FntvStatus>(page, 'fntv.service.status')).running).toBe(true)
  expect((await page.request.get('/v/api/v1/user/info', { headers: { Authorization: token } })).status()).toBe(200)
  await page.goto('/apps/fntv')
  await frame.locator('#stop').click()
  await expect(frame.locator('#service-state')).toHaveText('服务已停止')
  expect((await page.request.get('/v/api/v1/user/info', { headers: { Authorization: token } })).status()).toBe(401)
  expect(errors).toEqual([])
})

test('真实 0.1.0 候选包通过公开目录升级，保留数据和运行状态并撤销旧登录', async ({ page }) => {
  const legacy = await readFile(resolve(import.meta.dirname, '../fixtures/fntv-0.1.0.tgapp'))
  expect(createHash('sha256').update(legacy).digest('hex')).toBe(legacyDigest)
  const imported = await page.request.post(`/api/apps/install?digest=${legacyDigest}`, { data: legacy, headers: { 'Content-Type': 'application/octet-stream' } })
  expect(imported.ok()).toBe(true)
  const old = await imported.json() as AppEntry
  expect(old.manifest.version).toBe('0.1.0')
  expect((await page.request.patch('/api/apps/fntv/scope', { data: { mode: 'selected', paths: ['/测试影视'] } })).ok()).toBe(true)
  await rpc(page, 'fntv.account.set', { username, password })
  const root = await rpc<FileEntry>(page, 'files.stat', { path: '/测试影视' })
  await rpc(page, 'fntv.libraries.set', { libraries: [{ id: '', name: '升级保留测试库', kind: 'movie', root_id: root.id }] })
  await rpc(page, 'fntv.service.start')
  const before = await rpc<FntvConfig>(page, 'fntv.config.get')
  const token = await login(page)
  const movie = await indexedMovie(page, token, before)
  const reference = { item_guid: movie.guid, media_guid: movie.media_guid }
  const link = randomUUID()
  await wire(page, '/v/api/v1/stream', token, { ...reference, ip: link })
  const range = await page.request.get(`/v/api/v1/media/range/${movie.media_guid}`, { headers: { Authorization: token, Range: 'bytes=0-4095' } })
  expect(range.status()).toBe(206)
  await range.body()
  await wire(page, '/v/api/v1/play/record', token, { ...reference, play_link: link, ts: 7.75, subtitle_guid: '_no_display_' })
  await wire(page, '/v/api/v1/item/favorite', token, { item_guid: movie.guid }, 'PUT')
  expect((await wire<{ ts: number }>(page, '/v/api/v1/play/info', token, reference)).ts).toBe(7)

  const catalog = await (await page.request.get('/api/apps')).json() as { available: AppEntry[] }
  expect(catalog.available.map(app => app.manifest.id).sort()).toEqual(['cinema', 'fntv', 'reader', 'shorts'])
  const current = catalog.available.find(app => app.manifest.id === 'fntv')!
  const existing = await (await page.request.get('/api/apps/fntv')).json() as AppEntry
  const upgrade = await page.request.post('/api/apps/catalog/fntv/install', { data: { digest: current.digest, expected_revision: existing.revision } })
  expect(upgrade.ok()).toBe(true)
  const installed = await upgrade.json() as AppEntry
  expect(installed.manifest.version).toBe('0.1.1')
  expect(installed.digest).toBe(current.digest)
  expect(installed.digest).not.toBe(old.digest)
  const after = await rpc<FntvConfig>(page, 'fntv.config.get')
  expect(after.username).toBe(username)
  expect(after.account_configured).toBe(true)
  expect(after.libraries).toEqual(before.libraries)
  expect(after.running).toBe(true)
  expect((await page.request.get('/v/api/v1/user/info', { headers: { Authorization: token } })).status()).toBe(401)
  const fresh = await login(page)
  expect((await wire<{ ts: number }>(page, '/v/api/v1/play/info', fresh, reference)).ts).toBe(7)
  expect((await wire<{ total: number }>(page, '/v/api/v1/favorite/list', fresh, {})).total).toBe(1)
  await rpc(page, 'fntv.service.stop')
})
