import { expect, test } from '@playwright/test'
import { createCinemaLibrary, enterCinemaLibrary, installCinema } from './cinema-helpers'

test('影视封面在手机和桌面滚出视口再返回，不重建图片或重复读取', async ({ page }) => {
  const errors: string[] = [], reads: number[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const match = /\/api\/apps\/media\/([^/?]+)/.exec(request.url())
    if (!match) return
    const claim = JSON.parse(Buffer.from(match[1]!.split('.')[0]!, 'base64url').toString())
    if (claim.purpose === 'preview') reads.push(claim.node_id)
  })
  // 安装辅助函数先校验隔离网盘身份，后续只复制和清理合成夹具。
  await installCinema(page, null)
  const root = '/封面滚动回归'
  expect((await page.request.post('/api/fs/mkdir', { data: { path: root } })).ok()).toBe(true)
  try {
    for (let i = 1; i <= 30; i++) {
      const name = `影片 ${String(i).padStart(2, '0')}`
      for (const [from, suffix] of [['/测试影视/星际旅程 S01E01.mp4', 'mp4'], ['/测试影视/poster.png', 'png']]) {
        expect((await page.request.post('/api/fs/copy', { data: { from, to: `${root}/${name}.${suffix}` } })).ok()).toBe(true)
      }
    }
    await createCinemaLibrary(page, '封面回归', root)
    await enterCinemaLibrary(page, '封面回归')
    const frame = page.frameLocator('iframe'), main = frame.locator('#main')
    await expect(frame.locator('#items .poster-card')).toHaveCount(30)
    await expect(frame.locator('#hero .hero-art img')).toBeVisible()
    const ids = await frame.locator('body').evaluate(async (_node, path) => {
      const drive = (window as any).tgdrive
      const cover = await drive.files.stat({ path: `${path}/影片 01.png` })
      const videos = await drive.files.searchPage({ under: path, extensions: ['mp4'] })
      return { cover: cover.id as number, videos: videos.results.map((file: any) => file.id) as number[] }
    }, root)
    const first = frame.locator('#items .poster-card').first(), image = first.locator('.poster-art img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true)
    const original = await image.elementHandle(), initialReads = reads.filter(id => id === ids.cover).length
    expect(original).not.toBeNull(); expect(initialReads).toBeGreaterThan(0)

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      for (let i = 0; i < 2; i++) {
        await main.evaluate(node => { node.scrollTop = node.scrollHeight })
        await expect(first).not.toBeInViewport()
        await expect.poll(() => first.evaluate(node => node.getBoundingClientRect().bottom < document.getElementById('main')!.getBoundingClientRect().top - 150)).toBe(true)
        await expect(frame.locator('#items .poster-card').last().locator('.poster-art img')).toBeVisible()
        await expect(image).toHaveCount(1)
        expect(await image.evaluate((node, previous) => node === previous, original!)).toBe(true)
        await main.evaluate(node => { node.scrollTop = 0 })
        await first.scrollIntoViewIfNeeded()
        await expect(image).toBeInViewport()
        // 等待真实视口观察回调处理完毕，而不是依赖固定延时。
        await main.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        expect(await image.evaluate((node, previous) => node === previous, original!)).toBe(true)
        expect(reads.filter(id => id === ids.cover)).toHaveLength(initialReads)
      }
    }
    expect(reads.filter(id => ids.videos.includes(id))).toEqual([])
    await frame.locator('#library-back').click()
    await expect(frame.locator('#items .poster-card')).toHaveCount(0)
    expect(await original!.evaluate(node => !node.isConnected && !node.hasAttribute('src'))).toBe(true)
    await original!.dispose()
    expect(errors).toEqual([])
  } finally {
    expect((await page.request.post('/api/fs/delete', { data: { paths: [root], permanent: true } })).ok()).toBe(true)
  }
})
