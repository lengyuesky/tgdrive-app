import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import type { FileEntry, FntvStatus, ScraperHandle, ScraperRecord } from '../../sdk/types'
import { installCinema } from './cinema-helpers'

const appId = 'media-scraper'
const overview = '完整长简介。'.repeat(5000)

async function rpc<T>(page: Page, method: string, params: object = {}, id = appId): Promise<T> {
  const launch = await page.request.post(`/api/apps/${id}/launch`, { data: {} })
  expect(launch.ok()).toBe(true)
  const { session } = await launch.json() as { session: string }
  const response = await page.request.post(`/api/apps/${id}/rpc`, { data: { session, method, params } })
  expect(response.ok(), `${method} 返回 ${response.status()}`).toBe(true)
  return response.json() as Promise<T>
}
async function install(page: Page, id: string) {
  const index = await (await page.request.get('/api/apps')).json()
  const entry = index.available.find((app: { manifest: { id: string } }) => app.manifest.id === id)
  expect(entry).toBeTruthy()
  expect((await page.request.post(`/api/apps/catalog/${id}/install`, { data: { digest: entry.digest } })).ok()).toBe(true)
}
async function pick(page: Page, path: string, authorize = true) {
  const picker = page.getByRole('dialog', { name: authorize ? '选择允许整理与刮削的目录' : '影视刮削：选择目录', exact: true })
  await expect(picker).toBeVisible()
  await picker.evaluate(async element => {
    const overlay = element.closest('.el-overlay') ?? element
    await Promise.all(overlay.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
  })
  const parts = path.split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    const prefix = '/' + parts.slice(0, index + 1).join('/')
    const item = picker.getByTitle(prefix, { exact: true })
    await expect(item).toBeVisible()
    if (index === parts.length - 1) await item.click()
    else await item.locator('..').getByRole('button', { name: '展开目录', exact: true }).click()
  }
  await picker.getByRole('button', { name: '确定', exact: true }).click()
  await expect(picker).toBeHidden()
  if (authorize) {
    const grant = page.getByRole('dialog', { name: '授权目录', exact: true })
    await expect(grant).toContainText('写入 NFO 和海报')
    await grant.getByRole('button', { name: '允许整理与刮削', exact: true }).click()
    await expect(grant).toBeHidden()
  }
  await expect(page.locator('.el-overlay:visible')).toHaveCount(0)
}
async function open(page: Page, path: string, publicBackend = false) {
  await install(page, appId)
  await page.goto(`/apps/${appId}`)
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.getByRole('button', { name: '选择目录并授权', exact: true }).click()
  await pick(page, path)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#app')).toBeVisible()
  if (!publicBackend) {
    const fixture = await (await page.request.get('/__apps_fixture/scraper')).json()
    await frame.getByRole('button', { name: '设置', exact: true }).click()
    await frame.locator('#backend-url').fill(fixture.backend_url)
    await frame.locator('#save-connection').click()
    await expect(frame.locator('#connection-status')).toHaveText('连接配置已保存。')
    await frame.locator('#check-connection').click()
    await expect(frame.locator('#providers')).toHaveText('Fixture')
    await frame.getByRole('button', { name: '目录刮削', exact: true }).click()
  }
  await frame.locator('#choose').click()
  await pick(page, path, false)
  await expect(frame.locator('#directory')).toHaveText(path)
  await expect(frame.locator('#start')).toBeEnabled()
  await expect(frame.locator('#progress-panel')).toBeHidden()
  await expect(frame.locator('#select-page,#preview,#execute')).toHaveCount(0)
  return frame
}
async function startRun(page: Page) {
  const calls: ScraperHandle[] = []
  const listener = (response: import('@playwright/test').Response) => {
    if (response.url().endsWith(`/api/apps/${appId}/rpc`) && response.request().postDataJSON()?.method === 'scraper.batch.create') {
      void response.json().then(batch => calls.push(batch as ScraperHandle))
    }
  }
  page.on('response', listener)
  try {
    const frame = page.frameLocator('iframe')
    await frame.locator('#start').click()
    await expect.poll(() => calls.length).toBe(1)
    return calls[0]
  } finally { page.off('response', listener) }
}
async function stoppedRecord(page: Page, batch: ScraperHandle) {
  await expect.poll(async () => (await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).status).toMatch(/^(stopping|cancelled)$/)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: false } })).ok()).toBe(true)
  await expect.poll(async () => (await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).status).toBe('cancelled')
  const before = await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })
  expect(before.items[0].status).toBe('needs_verification')
  expect(before.items[0].result.organize.state).toBe('done')
  return before
}

test.beforeEach(async ({ page }) => {
  // 文件写操作只允许在身份已核验的临时 SQLite、内存 Telegram 和合成网盘中执行。
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: false, fail_poster: false } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  for (const entry of index.installed) expect((await page.request.delete(`/api/apps/${entry.manifest.id}?purge_data=true`)).ok()).toBe(true)
})

test('选择目录后一次开始完成全部视频，Cinema 与飞牛读取完整资料', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const root = '/刮削验证/整组'
  const frame = await open(page, root)
  // 退出覆盖模式后，隐藏的单项选项不能阻止默认补缺。
  await frame.getByRole('button', { name: '设置', exact: true }).click()
  await frame.locator('#refresh-mode').check()
  await frame.locator('#update-nfo').uncheck()
  await frame.locator('#update-poster').uncheck()
  await frame.locator('#refresh-mode').uncheck()
  await expect(frame.locator('#refresh-options')).toBeHidden()
  await frame.getByRole('button', { name: '目录刮削', exact: true }).click()
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123.mp4` })).is_dir).toBe(false)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: info.outputPath('scraper-desktop-preview.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.host-toolbar')).toBeHidden()
  expect(await frame.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('scraper-mobile-directory.png'), fullPage: true })
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/scraper')).json()).upload_pending).toBe(true)
  await expect(frame.locator('#total-count')).toHaveText('3')
  await expect(frame.locator('#results .result-row')).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('scraper-mobile-preview.png'), fullPage: true })
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: false } })).ok()).toBe(true)
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 3，跳过 0，失败 0。')
  const record = await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })
  expect(record.status).toBe('completed')
  expect(record.items.every(item => item.status === 'done' && item.result.organize.state === 'done' && item.result.nfo.state === 'done' && item.result.poster.state === 'done')).toBe(true)
  for (const name of ['ABC-123.mp4', 'ABC-123.mkv', 'ABC-123-4K.mp4', 'ABC-123.zh.srt', 'ABC-123.nfo', 'ABC-123.jpg', 'ABC-123-4K.nfo', 'ABC-123-4K.jpg']) {
    expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123/${name}` })).is_dir).toBe(false)
  }
  await frame.getByRole('button', { name: '操作记录', exact: true }).click()
  await frame.locator('.history-card').filter({ hasText: root }).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(frame.locator('#record-items')).toContainText('NFO：已完成')
  await page.screenshot({ path: info.outputPath('scraper-mobile-record.png'), fullPage: true })

  // 使用实际 Cinema 包消费刚生成的文件，覆盖标题、年份、长简介、海报及独立播放入口。
  await installCinema(page, `${root}/ABC-123`, '刮削结果')
  const cinema = page.frameLocator('iframe')
  await expect(cinema.locator('#items .poster-card')).toHaveCount(3)
  await expect(cinema.locator('#items .poster-card h3').first()).toHaveText('星海远航')
  await cinema.locator('#items .poster-card').filter({ has: cinema.locator('p', { hasText: 'MP4' }) }).first().click()
  await expect(cinema.locator('#detail-title')).toHaveText('星海远航')
  await expect(cinema.locator('#detail-meta')).toContainText('2025')
  await expect(cinema.locator('#detail-overview')).toHaveText(overview)
  await expect.poll(() => cinema.locator('#detail-poster img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.screenshot({ path: info.outputPath('cinema-scraped-mobile.png'), fullPage: true })
  await cinema.locator('#detail-play').click()
  await expect(cinema.locator('#playing-title')).toHaveText('星海远航')
  await expect.poll(() => cinema.locator('#video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(.2)
  await cinema.locator('#options-toggle').click()
  await expect(cinema.locator('#autoplay')).not.toBeChecked()
  await expect(cinema.locator('#autoplay')).toBeDisabled()
  await expect(cinema.locator('#series-status')).toContainText('请手动切换视频')
  await cinema.locator('#options-close').click()
  await cinema.locator('#seek').fill('19.5')
  await cinema.locator('#seek').dispatchEvent('change')
  await expect.poll(() => cinema.locator('#video').evaluate(video => (video as HTMLVideoElement).ended)).toBe(true)
  await expect(cinema.locator('#next-countdown')).toBeHidden()
  await cinema.locator('#player-back').click()

  await install(page, 'fntv')
  expect((await page.request.patch('/api/apps/fntv/scope', { data: { mode: 'selected', paths: [root] } })).ok()).toBe(true)
  await rpc(page, 'fntv.account.set', { username: 'scraper-synthetic', password: 'Scraper-Synthetic-2026' }, 'fntv')
  const source = await rpc<FileEntry>(page, 'files.stat', { path: root }, 'fntv')
  await rpc(page, 'fntv.libraries.set', { libraries: [{ id: '', name: '刮削结果', kind: 'movie', root_id: source.id }] }, 'fntv')
  await rpc(page, 'fntv.service.start', {}, 'fntv')
  await expect.poll(async () => (await rpc<FntvStatus>(page, 'fntv.service.status', {}, 'fntv')).index.state).toBe('ready')
  const login = await page.request.post('/v/api/v2/user/loginByPassword', { data: { username: 'scraper-synthetic', password: createHash('sha256').update('Scraper-Synthetic-2026').digest('hex') } })
  expect(login.ok()).toBe(true)
  const token = (await login.json()).data.token as string
  const list = await page.request.post('/v/api/v1/item/list', { headers: { Authorization: token }, data: { page: 1, page_size: 50 } })
  expect(list.ok()).toBe(true)
  const movies = (await list.json()).data.list
  expect(movies).toHaveLength(3)
  expect(movies.every((movie: { title: string; release_date: string }) => movie.title === '星海远航' && movie.release_date === '2025')).toBe(true)
  const detail = await page.request.get(`/v/api/v1/item/${movies[0].guid}`, { headers: { Authorization: token } })
  expect(detail.ok()).toBe(true)
  const description = (await detail.json()).data
  expect(description.overview).toBe(overview)
  const poster = await page.request.get(movies[0].poster, { headers: { Authorization: token } })
  expect(poster.ok()).toBe(true)
  expect((await poster.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  await rpc(page, 'fntv.service.stop', {}, 'fntv')
  expect(errors).toEqual([])
})

test('一键处理超过一页的整个目录，不确定项跳过且子目录视频完成', async ({ page }) => {
  const root = '/刮削验证/完整目录', searched: unknown[] = []
  // 两个精确来源都不能代替用户作出选择；直接跳过，继续真实沙箱中的其他文件。
  await page.route(`**/api/apps/${appId}/rpc`, async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'scraper.search' && body.params.number === 'ZZZ-789') {
      await route.fulfill({ json: { candidates: ['A', 'B'].map(provider => ({ provider, id: 'synthetic', number: 'ZZZ-789', title: '多来源合成影片' })) } })
    } else await route.continue()
  })
  page.on('request', request => {
    if (request.url().endsWith(`/api/apps/${appId}/rpc`) && request.postDataJSON()?.method === 'files.searchPage') searched.push(request.postDataJSON().params)
  })
  const frame = await open(page, root)
  expect(searched).toHaveLength(0)
  await startRun(page)
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 2，跳过 103，失败 0。', { timeout: 60_000 })
  expect(searched.length).toBeGreaterThanOrEqual(2)
  await expect(frame.locator('#total-count')).toHaveText('105')
  await expect(frame.locator('#more-results')).toBeVisible()
  await frame.locator('#more-results').click()
  await expect(frame.locator('#results .result-row')).toHaveCount(104)
  await expect(frame.locator('#results .result-row').filter({ hasText: 'ZZZ-789.mp4' })).toContainText('未找到唯一的番号精确匹配')
  for (const name of ['ABC-123.mp4', 'ABC-123.mkv', 'ABC-123.nfo', 'ABC-123.jpg']) {
    expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/子目录/ABC-123/${name}` })).is_dir).toBe(false)
  }
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123-DEF-456.mp4` })).path).toBe(`${root}/ABC-123-DEF-456.mp4`)
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ZZZ-789.mp4` })).path).toBe(`${root}/ZZZ-789.mp4`)
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/未识别影片100.mp4` })).path).toBe(`${root}/未识别影片100.mp4`)
})

test('真实取消在途写入，点击重试自动核实并补齐资料', async ({ page }) => {
  const root = '/刮削验证/取消操作'
  const frame = await open(page, root)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/scraper')).json()).upload_pending).toBe(true)
  expect((await (await page.request.get('/api/uploads')).json()).sessions).toEqual([])
  await frame.locator('#cancel').click()
  await expect(frame.locator('#execution-status')).toContainText(/正在停止|已停止刮削/)
  await stoppedRecord(page, batch)
  await frame.getByRole('button', { name: '操作记录', exact: true }).click()
  await frame.locator('.history-card').filter({ hasText: root }).getByRole('button', { name: '查看结果', exact: true }).click()
  await frame.locator('#continue-record').click()
  await expect(frame.locator('#execution-status')).toContainText('刮削完成：成功 1')
  expect((await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).items[0].status).toBe('needs_user')
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123/ABC-123.nfo` })).size).toBeGreaterThan(4096)
})

test('关闭真实应用页面会停止在途批次，重新打开不自行续跑', async ({ page }) => {
  const root = '/刮削验证/关闭页面'
  const frame = await open(page, root)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/scraper')).json()).upload_pending).toBe(true)
  await frame.locator('#exit').click()
  await expect(page).toHaveURL(/\/files\//)
  await stoppedRecord(page, batch)
  await page.goto(`/apps/${appId}`)
  await expect(frame.locator('#app')).toBeVisible()
  await expect(frame.locator('#directory')).toHaveText(root)
  await expect(frame.locator('#start')).toBeEnabled()
  await expect(frame.locator('#progress-panel')).toBeHidden()
  expect((await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).status).toBe('cancelled')
})

test('后端海报故障暂停，保留 NFO 并从操作记录补齐海报', async ({ page }) => {
  const root = '/刮削验证/故障重试'
  const frame = await open(page, root)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { fail_poster: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect.poll(async () => (await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).status).toBe('paused')
  const originalNfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123/ABC-123.nfo` })
  expect(originalNfo.size).toBeGreaterThan(4096)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { fail_poster: false } })).ok()).toBe(true)
  await frame.getByRole('button', { name: '操作记录', exact: true }).click()
  await frame.locator('.history-card').filter({ hasText: root }).getByRole('button', { name: '查看结果', exact: true }).click()
  await frame.locator('#continue-record').click()
  await expect(frame.locator('#execution-status')).toContainText('刮削完成：成功 1')
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123/ABC-123.nfo` })).content_version).toBe(originalNfo.content_version)
  expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/ABC-123/ABC-123.jpg` })).size).toBeLessThanOrEqual(2 * 1024 * 1024)
})

test('指定公共 MetaTube 后端经真实沙箱写入合成视频的配套资料', async ({ page }, info) => {
  test.skip(process.env.TGDRIVE_SCRAPER_PUBLIC_BACKEND !== '1', '需显式启用本次用户指定公共服务的网络验收')
  test.setTimeout(180_000)
  const root = '/刮削验证/公共后端'
  const frame = await open(page, root, true)
  await frame.getByRole('button', { name: '设置', exact: true }).click()
  await expect(frame.locator('#backend-url')).toHaveValue('https://metatube-server.hf.space/')
  await frame.locator('#check-connection').click()
  await expect(frame.locator('#connection-status')).toContainText('连接正常', { timeout: 65_000 })
  await frame.getByRole('button', { name: '目录刮削', exact: true }).click()
  const batch = await startRun(page)
  await expect(frame.locator('#execution-status')).toContainText('刮削完成：成功 1', { timeout: 100_000 })
  const record = await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })
  expect(record.status).toBe('completed')
  expect(record.items[0].status).toBe('done')
  const nfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/IPX-001/IPX-001.nfo` })
  const jpg = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/IPX-001/IPX-001.jpg` })
  expect(nfo.size).toBeGreaterThan(0)
  expect(nfo.size).toBeLessThanOrEqual(1024 * 1024)
  expect(jpg.size).toBeGreaterThan(0)
  expect(jpg.size).toBeLessThanOrEqual(2 * 1024 * 1024)
  await info.attach('公共服务写入结果', { body: JSON.stringify({ backend: 'https://metatube-server.hf.space/', record, nfo, jpg }, null, 2), contentType: 'application/json' })
})

test('备份恢复后的未完成记录仅供查看，手动重新开始才创建新任务', async ({ page }) => {
  const root = '/刮削验证/恢复记录'
  const frame = await open(page, root)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { block_uploads: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect.poll(async () => (await (await page.request.get('/__apps_fixture/scraper')).json()).upload_pending).toBe(true)
  await frame.locator('#cancel').click()
  await stoppedRecord(page, batch)
  await expect(frame.locator('#start')).toBeEnabled()
  expect((await page.request.post('/__apps_fixture/scraper', { data: { restore_records: true } })).ok()).toBe(true)
  const restored = await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })
  expect(restored.read_only).toBe(true)
  await frame.getByRole('button', { name: '操作记录', exact: true }).click()
  await frame.locator('.history-card').filter({ hasText: root }).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(frame.locator('#record-status')).toContainText('恢复记录仅供查看')
  await expect(frame.locator('#continue-record')).toBeDisabled()
  await frame.getByRole('button', { name: '目录刮削', exact: true }).click()
  const fresh = await startRun(page)
  expect(fresh.id).not.toBe(batch.id)
  await expect(frame.locator('#execution-status')).toContainText('刮削完成：成功 1')
})
