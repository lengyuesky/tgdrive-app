import { expect, test } from '@playwright/test'
import { installCinema as open } from './cinema-helpers'

test('影视播放中的远端 CAS 更新不会被本地旧进度覆盖', async ({ page }) => {
  await open(page)
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '查看影视：星际旅程 S01E01.mp4', exact: true }).click()
  await frame.locator('#detail-play').click()
  await expect.poll(() => frame.locator('#video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(1)
  await frame.locator('#toggle-play').click()
  await expect(frame.locator('#sync-status')).toHaveText('进度已同步')
  // 直接经真实存储网关写入远端修订，模拟另一设备更新，不修改播放器持有的旧修订。
  await frame.locator('body').evaluate(async () => {
    const drive = (window as any).tgdrive
    const { records } = await drive.storage.list({ prefix: 'progress:' })
    const record = records[0]
    await drive.storage.set(record.key, { ...record.value, seconds: 8 }, record.revision)
  })
  await frame.locator('#forward').click()
  await expect(frame.locator('#sync-remote')).toBeVisible()
  const remote = await frame.locator('body').evaluate(async () => (await (window as any).tgdrive.storage.list({ prefix: 'progress:' })).records[0].value.seconds)
  expect(remote).toBe(8)
  await frame.locator('#sync-remote').click()
  await expect.poll(() => frame.locator('#video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeCloseTo(8, 0)
  await expect(frame.locator('#sync-remote')).not.toBeVisible()
  await frame.locator('#player-back').click()
})

test('影视离开取消慢速原视频 Range，重开和停用不会遗留旧播放器', async ({ page }) => {
  await open(page)
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '查看影视：星际旅程 S01E02.mkv', exact: true }).click()
  await expect(frame.locator('#detail-status')).toHaveText('')
  await page.request.post('/__apps_fixture/media', { data: { enabled: true } })
  await frame.locator('#detail-play').click()
  const active = async () => (await (await page.request.get('/__apps_fixture/media')).json()).active
  await expect.poll(active).toBeGreaterThan(0)
  await frame.locator('#player-back').click()
  await page.request.post('/__apps_fixture/media', { data: { enabled: false } })
  await expect.poll(active, { timeout: 5000 }).toBe(0)
  await expect(frame.locator('#video')).not.toHaveAttribute('src', /.+/)
  await frame.getByRole('button', { name: '查看影视：星际旅程 S01E02.mkv', exact: true }).click()
  await frame.locator('#detail-play').click()
  await expect.poll(() => frame.locator('#video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  await page.request.post('/api/apps/cinema/state', { data: { enabled: false } })
  await page.evaluate(() => window.dispatchEvent(new Event('tgdrive-apps-changed')))
  await expect(page.locator('iframe')).toHaveCount(0, { timeout: 20000 })
  await expect(page.locator('.host-toolbar')).toBeVisible()
})

test('影院在小屏和平板宽度保持有界布局与明确导航', async ({ page }, info) => {
  await open(page)
  const frame = page.frameLocator('iframe')
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    await expect(frame.locator('#hero')).toBeVisible()
    expect(await frame.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await frame.locator('#items .poster-card').count()).toBeLessThanOrEqual(200)
    await page.screenshot({ path: info.outputPath(`cinema-${width}.png`), fullPage: true })
  }
})
