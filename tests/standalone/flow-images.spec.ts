import { expect, test } from '@playwright/test'
import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { png } from '../browser/readers-fixtures.mjs'
import type { PictureWindow } from '../../reader/pictures'

declare global {
  interface Window {
    flowPicturesBundle: { PictureWindow: typeof PictureWindow }
    flowPictures: PictureWindow
    flowPictureErrors: string[]
  }
}

let script = ''
let styles = ''
const picture = png(240, 960, [32, 128, 100])

test.beforeAll(async () => {
  styles = await readFile(new URL('../../reader/style.css', import.meta.url), 'utf8')
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../reader/pictures.ts', import.meta.url)),
        name: 'flowPicturesBundle',
        formats: ['iife'],
      },
    },
  })
  const output = Array.isArray(result) ? result[0]! : result
  if (!('output' in output)) throw new Error('图片窗口测试需要完整构建结果')
  const chunk = output.output.find(item => item.type === 'chunk')
  if (!chunk) throw new Error('图片窗口测试构建缺少脚本')
  script = chunk.code
})

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`分页图片在解码等待、完成和移出缓存时保留四页 ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const width = viewport.width - 24, height = viewport.height - 32
    // 暂停浏览器实际图片请求，稳定制造已有尺寸、尚未解码的状态。
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let requests = 0
    await page.route('http://flow-fixture.invalid/*.png', async route => {
      requests++
      await blocked
      await route.fulfill({ status: 200, contentType: 'image/png', body: picture })
    })
    await page.setContent(`<style>${styles}</style>
      <main class="flow-pages" style="width:${width}px;height:${height}px">
        <article class="flow-content is-paginated" style="column-width:${width}px;--page-width:${width}px;--page-height:${height}px">
          ${Array.from({ length: 4 }, (_, index) => `<img data-resource="picture-${index}" alt="纯图 ${index + 1}">`).join('')}
        </article>
      </main>`)
    await page.addScriptTag({ content: script })
    const pager = page.locator('.flow-pages')
    const pages = () => pager.evaluate(element => Math.ceil((element.scrollWidth + 23) / (element.clientWidth + 24)))
    try {
      await page.evaluate(bytes => {
        const create = URL.createObjectURL.bind(URL)
        let sequence = 0
        URL.createObjectURL = object => object instanceof Blob && object.type === 'image/png'
          ? `http://flow-fixture.invalid/${++sequence}.png`
          : create(object)
        window.flowPictureErrors = []
        window.flowPictures = new window.flowPicturesBundle.PictureWindow(
          document.querySelector<HTMLElement>('.flow-pages')!,
          document.querySelector<HTMLElement>('.flow-content')!,
          new AbortController().signal,
          async () => new Uint8Array(bytes),
          error => window.flowPictureErrors.push(String(error)),
        )
      }, [...picture])
      await expect.poll(() => requests).toBeGreaterThan(0)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await pages()).toBe(4)
      for (const image of await page.locator('img[src]').all()) {
        const box = (await image.boundingBox())!
        expect(box.height).toBeCloseTo(height, 1)
        expect(box.width / box.height).toBeCloseTo(1 / 4, 3)
        expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(0)
      }

      release()
      await expect.poll(() => page.locator('img[src]').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 240))).toBe(true)
      expect(await pages()).toBe(4)
      await pager.evaluate(element => { element.scrollLeft = 3 * (element.clientWidth + 24) })
      await expect.poll(() => page.getByAltText('纯图 4', { exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240)
      await expect(page.getByAltText('纯图 1', { exact: true })).not.toHaveAttribute('src')
      expect(await pages()).toBe(4)
      expect(await page.evaluate(() => window.flowPictureErrors)).toEqual([])
    } catch (error) {
      await info.attach('图片布局状态', {
        contentType: 'application/json',
        body: JSON.stringify(await pager.evaluate(element => ({
          width: element.clientWidth, height: element.clientHeight,
          scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
          images: [...element.querySelectorAll('img')].map(image => ({
            resource: image.dataset.resource, hasSource: image.hasAttribute('src'),
            naturalWidth: image.naturalWidth, rect: image.getBoundingClientRect().toJSON(),
          })),
          errors: window.flowPictureErrors,
        }))),
      })
      throw error
    } finally {
      release()
      await page.evaluate(() => window.flowPictures?.destroy())
    }
  })
}
