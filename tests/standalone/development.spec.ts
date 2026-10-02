import { test, expect } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
let directory: string, server: ChildProcess
test.beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'tgdrive-sdk-browser-'))
  execFileSync(process.execPath, ['tools/create-app.mjs', 'test-viewer', resolve(directory, 'app')])
  server = spawn(process.execPath, ['tools/dev-host.mjs', resolve(directory, 'app')], { env: { ...process.env, TGDRIVE_DEV_PORT: '4191' }, stdio: 'pipe' })
  await new Promise<void>((resolveReady, reject) => { server.stdout!.once('data', () => resolveReady()); server.once('error', reject); server.once('exit', code => reject(new Error(`模拟宿主提前退出：${code}`))) })
})
test.afterAll(async () => { server?.kill(); if (directory) await rm(directory, { recursive: true, force: true }) })
test('独立脚手架在真实沙箱中授权、查看文件并保持私有数据修订契约', async ({ page }) => {
  await page.goto('http://127.0.0.1:4191')
  await expect(page.locator('#status')).toHaveText('应用已就绪')
  await page.locator('input[type=file]').setInputFiles({ name: '示例.txt', mimeType: 'text/plain', buffer: Buffer.from('测试文件') })
  page.once('dialog', dialog => dialog.accept())
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '选择目录', exact: true }).click()
  await frame.getByRole('button', { name: '示例.txt', exact: true }).click()
  await expect(page.locator('#status')).toContainText('示例.txt')
  const result = await frame.locator('body').evaluate(async () => {
    const drive = window.tgdrive
    const record = await drive.storage.set('sample', { page: 1 }, null)
    let conflict = false
    try { await drive.storage.set('sample', { page: 2 }, null) } catch { conflict = true }
    return { value: (await drive.storage.get('sample'))?.value, conflict, revision: record.revision }
  })
  expect(result.value).toEqual({ page: 1 }); expect(result.conflict).toBe(true); expect(result.revision).toBeTruthy()
  expect((await page.request.get('http://127.0.0.1:4191/app/%2e%2e%2ftools%2fmock-host.js')).status()).toBe(404)
})
