import { expect, type Page } from '@playwright/test'
/** 既有功能测试通过无障碍入口打开工具栏，手势另外用真实触摸上下文验收。 */
export async function revealReader(page: Page) {
  const frame = page.frameLocator('iframe')
  if (await frame.locator('#app.immersive').count()) {
    await frame.locator('#viewport').focus()
    await page.keyboard.press('Escape')
  }
  await expect(frame.locator('#back')).toBeVisible()
}
export async function closeReaderPanel(page: Page) {
  const frame = page.frameLocator('iframe')
  if (await frame.locator('[role="dialog"]').count()) await page.keyboard.press('Escape')
}
