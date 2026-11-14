import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
async function open(page: Page, path: string, publicBackend = false, backendUrl?: string) {
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
    await frame.locator('#backend-url').fill(backendUrl ?? fixture.backend_url)
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
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(1)
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
  const sources: string[] = []
  // 同一影片有两个资料源时依次尝试，前一来源详情不符不应跳过整部影片。
  await page.route(`**/api/apps/${appId}/rpc`, async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'scraper.search' && body.params.number === 'ABC-123') {
      await route.fulfill({ json: { candidates: ['Unavailable', 'Fixture'].map(provider => ({ provider, id: 'abc123', number: 'ABC-123', title: '多来源合成影片' })) } })
    } else await route.continue()
  })
  page.on('request', request => {
    if (!request.url().endsWith(`/api/apps/${appId}/rpc`)) return
    const body = request.postDataJSON()
    if (body?.method === 'files.searchPage') searched.push(body.params)
    if (body?.method === 'scraper.preview' && body.params.candidate) sources.push(body.params.candidate.provider)
  })
  const frame = await open(page, root)
  expect(searched).toHaveLength(0)
  await startRun(page)
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 2，跳过 103，失败 0。', { timeout: 60_000 })
  expect(searched.length).toBeGreaterThanOrEqual(2)
  expect(sources).toEqual(['Unavailable', 'Fixture'])
  await expect(frame.locator('#total-count')).toHaveText('105')
  await expect(frame.locator('#more-results')).toBeVisible()
  await frame.locator('#more-results').click()
  await expect(frame.locator('#results .result-row')).toHaveCount(104)
  await expect(frame.locator('#results .result-row').filter({ hasText: 'ZZZ-789.mp4' })).toContainText('未找到 ZZZ-789 的匹配资料')
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

test('单部海报故障记录失败，保留 NFO 并从操作记录补齐海报', async ({ page }) => {
  const root = '/刮削验证/故障重试'
  const frame = await open(page, root)
  expect((await page.request.post('/__apps_fixture/scraper', { data: { fail_poster: true } })).ok()).toBe(true)
  const batch = await startRun(page)
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 0，跳过 0，失败 1。')
  expect((await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })).status).toBe('paused')
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

test('前一部先完成，慢查询和海报失败不阻塞后续，重开记录保留原因并只重试未完成项', async ({ page }, info) => {
  const root = '/刮削验证/逐部执行', searched: string[] = []
  const fixture = await (await page.request.get('/__apps_fixture/scraper')).json()
  const image = Buffer.from(await (await fetch(`${fixture.backend_url}v1/images/primary/Fixture/abc123`)).arrayBuffer())
  let healthy = false, release!: () => void
  const laterSearch = new Promise<void>(resolve => { release = resolve })
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://127.0.0.1'), number = decodeURIComponent(url.pathname.split('/').pop()!)
      const json = (data: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data })) }
      if (url.pathname === '/v1/providers') return json({ movie_providers: { Fixture: 'https://fixture.invalid' } })
      if (url.pathname === '/v1/movies/search') {
        const query = url.searchParams.get('q')!; searched.push(query)
        if (query === 'BBB-202' && !healthy) { await laterSearch; response.statusCode = 503; response.end('合成查询故障'); return }
        return json([{ provider: 'Fixture', id: query, number: query, title: '合成目录影片' }])
      }
      if (url.pathname.startsWith('/v1/movies/')) return json({ provider: 'Fixture', id: number, number, title: '合成目录影片', summary: '用于验证逐部完成与单项失败后的连续执行。', release_date: '2025-06-01T00:00:00Z' })
      if (number === 'CCC-303' && !healthy) { response.statusCode = 503; response.end('合成海报故障'); return }
      response.setHeader('Content-Type', 'image/jpeg'); response.end(image)
    })().catch(error => { response.statusCode = 500; response.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    // 仅整理测试响应的显示顺序；所有文件引用、版本和后续写入仍由真实宿主核验。
    await page.route(`**/api/apps/${appId}/rpc`, async route => {
      const body = route.request().postDataJSON()
      if (body?.method === 'files.searchPage' && body.params.under === root) {
        const response = await route.fetch(), data = await response.json()
        data.results.sort((a: FileEntry, b: FileEntry) => a.path.localeCompare(b.path, 'en'))
        await route.fulfill({ response, json: data })
      } else await route.continue()
    })
    const frame = await open(page, root, false, `http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    const originalPoster = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/AAA-101/poster.png` })
    await startRun(page)
    await expect.poll(() => searched.includes('BBB-202')).toBe(true)
    await expect(frame.locator('#done-count')).toHaveText('1')
    const firstNfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/AAA-101/AAA-101.nfo` })
    expect(firstNfo.size).toBeGreaterThan(0)
    expect((await rpc<FileEntry>(page, 'files.stat', { id: originalPoster.id })).content_version).toBe(originalPoster.content_version)
    release()
    await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 2，跳过 1，失败 2。')
    expect(searched).toEqual(['AAA-101', 'BBB-202', 'BBB-202', 'CCC-303', 'DDD-404'])
    const partialNfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/CCC-303/CCC-303.nfo` })
    const lastNfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/DDD-404/DDD-404.nfo` })
    expect(partialNfo.size).toBeGreaterThan(0); expect(lastNfo.size).toBeGreaterThan(0)
    await page.reload()
    await expect(frame.locator('#app')).toBeVisible()
    await expect(frame.locator('#progress-panel')).toBeHidden()
    await frame.getByRole('button', { name: '操作记录', exact: true }).click()
    await expect(frame.locator('.history-card')).toHaveCount(1)
    await frame.locator('.history-card').getByRole('button', { name: '查看结果', exact: true }).click()
    const failedSearch = frame.locator('#record-items .record-row').filter({ hasText: 'BBB-202.mp4' })
    await expect(failedSearch).toContainText('查询 BBB-202 失败')
    await expect(failedSearch).toContainText('503')
    const failedPoster = frame.locator('#record-items .record-row').filter({ hasText: 'CCC-303.mp4' })
    await expect(failedPoster).toContainText('NFO：已完成'); await expect(failedPoster).toContainText('503')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath('scraper-mixed-record.png'), fullPage: true })
    expect(searched).toHaveLength(5)
    // 单条执行明细过期不能遮住已经保存的整次目录错误，也不能允许盲目重试。
    const missingRecord = async (route: import('@playwright/test').Route) => {
      if (route.request().postDataJSON()?.method === 'scraper.record') await route.fulfill({ status: 404, json: { code: 'not_found', error: '执行记录已过期' } })
      else await route.fallback()
    }
    await page.route(`**/api/apps/${appId}/rpc`, missingRecord)
    await frame.locator('.history-card').getByRole('button', { name: '查看结果', exact: true }).click()
    await expect(frame.locator('#record-status')).toContainText('部分执行记录暂时无法核实')
    await expect(failedSearch).toContainText('503'); await expect(frame.locator('#continue-record')).toBeDisabled()
    await page.unroute(`**/api/apps/${appId}/rpc`, missingRecord)
    await frame.locator('.history-card').getByRole('button', { name: '查看结果', exact: true }).click()
    await expect(frame.locator('#continue-record')).toBeEnabled()
    healthy = true
    await frame.locator('#continue-record').click()
    await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 2，跳过 1，失败 0。')
    expect(searched.slice(5)).toEqual(['BBB-202', 'CCC-303'])
    for (const before of [firstNfo, partialNfo, lastNfo, originalPoster]) expect((await rpc<FileEntry>(page, 'files.stat', { id: before.id })).content_version).toBe(before.content_version)
    expect((await rpc<FileEntry>(page, 'files.stat', { path: `${root}/CCC-303/CCC-303.jpg` })).size).toBeGreaterThan(0)
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('页面中未完成的实际番号通过公共后端逐部补齐 NFO，保留已有海报', async ({ page }, info) => {
  test.skip(process.env.TGDRIVE_SCRAPER_PUBLIC_BACKEND !== '1', '需显式启用指定公共服务的网络验收')
  test.setTimeout(240_000)
  const root = '/刮削验证/实际番号', numbers = ['ABF-159', 'ADN-366', 'ADN-725']
  const frame = await open(page, root, true)
  const original = await Promise.all(numbers.map(number => rpc<FileEntry>(page, 'files.stat', { path: `${root}/${number}/poster.png` })))
  await startRun(page)
  await expect(frame.locator('#execution-status')).toContainText(/刮削完成|刮削已停止/, { timeout: 210_000 })
  await info.attach('实际番号页面结果', { body: await frame.locator('#results').innerText(), contentType: 'text/plain' })
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 3，跳过 0，失败 0。')
  const results = []
  for (let index = 0; index < numbers.length; index++) {
    const number = numbers[index], nfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/${number}/${number}.nfo` })
    const poster = await rpc<FileEntry>(page, 'files.stat', { id: original[index].id })
    expect(nfo.size).toBeGreaterThan(0); expect(poster.content_version).toBe(original[index].content_version)
    results.push({ number, nfo, poster })
  }
  await info.attach('实际番号合成目录验收', { body: JSON.stringify({ backend: 'https://metatube-server.hf.space/', results }, null, 2), contentType: 'application/json' })
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

test('SONE-614 同号多来源通过公共后端成功写入标准目录', async ({ page }, info) => {
  test.skip(process.env.TGDRIVE_SCRAPER_PUBLIC_BACKEND !== '1', '需显式启用指定公共服务的网络验收')
  test.setTimeout(180_000)
  const root = '/视频/AV/SONE-614'
  const frame = await open(page, root, true)
  const candidates = await rpc<{ candidates: { provider: string; id: string; number: string }[] }>(page, 'scraper.search', { number: 'SONE-614' })
  expect(candidates.candidates.filter(candidate => candidate.number === 'SONE-614').length).toBeGreaterThan(0)
  const original = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/SONE-614.mp4` })
  const batch = await startRun(page)
  await expect(frame.locator('#execution-status')).toHaveText('刮削完成：成功 1，跳过 0，失败 0。', { timeout: 120_000 })
  const record = await rpc<ScraperRecord>(page, 'scraper.record', { id: batch.id })
  expect(record.status).toBe('completed')
  expect(record.items).toHaveLength(1)
  expect(record.items[0]).toMatchObject({ number: 'SONE-614', target_path: root, status: 'done', result: { nfo: { state: 'done' }, poster: { state: 'done' } } })
  const video = await rpc<FileEntry>(page, 'files.stat', { id: original.id })
  expect(video.path).toBe(original.path); expect(video.content_version).toBe(original.content_version)
  const nfo = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/SONE-614.nfo` })
  const poster = await rpc<FileEntry>(page, 'files.stat', { path: `${root}/SONE-614.jpg` })
  expect(nfo.size).toBeGreaterThan(0); expect(nfo.size).toBeLessThanOrEqual(1024 * 1024)
  expect(poster.size).toBeGreaterThan(0); expect(poster.size).toBeLessThanOrEqual(2 * 1024 * 1024)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: info.outputPath('sone-614-completed.png'), fullPage: true })
  await info.attach('SONE-614 实际刮削结果', { body: JSON.stringify({ backend: 'https://metatube-server.hf.space/', candidates: candidates.candidates.map(({ provider, id, number }) => ({ provider, id, number })), record, nfo, poster }, null, 2), contentType: 'application/json' })
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
