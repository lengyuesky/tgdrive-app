import { expect, type Page } from '@playwright/test'

export async function chooseCinemaDirectory(page: Page, path: string) {
  const frame = page.frameLocator('iframe')
  await frame.locator('#library-pick').click()
  const picker = page.getByRole('dialog', { name: '影视：选择目录', exact: true })
  await expect(picker).toBeVisible()
  // 宿主入场动画会移动目录行；等待动画结束再按实际坐标点击，不强制点击或固定休眠。
  await picker.evaluate(async element => {
    const overlay = element.closest('.el-overlay') ?? element
    await Promise.all(overlay.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
  })
  if (path === '/') await picker.locator('.root-row').click()
  else {
    const parts = path.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const prefix = '/' + parts.slice(0, i + 1).join('/')
      const target = picker.getByTitle(prefix, { exact: true })
      await expect(target).toBeVisible()
      if (i === parts.length - 1) await target.click()
      else await target.locator('..').getByRole('button', { name: '展开目录', exact: true }).click()
    }
  }
  await expect(picker.locator('.picked code')).toHaveText(path)
  await picker.getByRole('button', { name: '确定', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(frame.locator('#library-path')).toHaveText(path)
  await expect(frame.locator('#library-save')).toBeEnabled()
}

export async function createCinemaLibrary(page: Page, name: string, path: string) {
  const frame = page.frameLocator('iframe')
  await frame.locator('#new-library').click()
  await expect(frame.locator('#library-name')).toBeEnabled()
  await frame.locator('#library-name').fill(name)
  await chooseCinemaDirectory(page, path)
  await frame.locator('#library-save').click()
  if (path === '/') {
    await expect(frame.locator('#confirm-title')).toHaveText('将整个网盘加入媒体库？')
    await frame.locator('#confirm-ok').click()
  }
  await expect(frame.locator('#library-edit-dialog')).not.toBeVisible()
  await expect(frame.getByRole('button', { name: `进入媒体库：${name}`, exact: true })).toBeVisible()
}

export async function enterCinemaLibrary(page: Page, name = '测试影视') {
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: `进入媒体库：${name}`, exact: true }).click()
  await expect(frame.locator('#page-title')).toHaveText(name)
  await expect(frame.locator('#items .poster-card').first()).toBeVisible()
}

export async function installCinema(page: Page, source: string | null = '/测试影视', name = '测试影视') {
  // 所有安装和文件写操作只允许在经过身份检查的临时网盘中执行。
  expect(await (await page.request.get('/__apps_fixture')).json()).toEqual({ fixture: 'tgdrive-apps-tests' })
  expect((await page.request.post('/api/auth/login', { data: { username: 'apps-test', password: 'apps-test-only' } })).ok()).toBe(true)
  expect((await page.request.post('/__apps_fixture/media', { data: { enabled: false } })).ok()).toBe(true)
  const index = await (await page.request.get('/api/apps')).json()
  if (index.installed.some((app: any) => app.manifest.id === 'cinema')) expect((await page.request.delete('/api/apps/cinema?purge_data=true')).ok()).toBe(true)
  const app = index.available.find((app: any) => app.manifest.id === 'cinema')
  expect(app?.manifest.version).toBe('1.2.3')
  expect((await page.request.post('/api/apps/catalog/cinema/install', { data: { digest: app.digest } })).ok()).toBe(true)
  await page.goto('/apps/cinema')
  await expect(page.frameLocator('iframe').locator('#empty-title')).toHaveText('尚未创建媒体库')
  await expect(page.frameLocator('iframe').locator('#empty')).toBeVisible()
  if (source !== null) {
    await createCinemaLibrary(page, name, source)
    await enterCinemaLibrary(page, name)
  }
}

export function cinemaRequests(page: Page) {
  const calls: { method: string; params: Record<string, any> }[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/apps/cinema/rpc') && request.method() === 'POST') {
      const body = request.postDataJSON()
      calls.push({ method: body.method, params: body.params })
    }
  })
  return { calls, enumerations: () => calls.filter(call => call.method === 'files.list' || call.method === 'files.searchPage') }
}
