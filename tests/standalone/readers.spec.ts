import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { basicPdf, epub, png, zip } from '../browser/readers-fixtures.mjs'
import type { FileEntry } from '../../sdk/types'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const modules = resolve(root, 'node_modules')

declare global {
  interface Window { standaloneImmersion: { active: boolean; calls: boolean[] } }
}

let readerOutDir = ''
let stagingTmp = ''

// 生成各类合成测试文件数据
const samplePng = png(240, 360, [70, 130, 180])
const sampleTxt = Buffer.from(
  '第1章 起点\n这是第一章的内容。\n第2章 进阶\n这是第二章的内容，包含更多文字。\n第3章 终点\n这是第三章终点。',
  'utf8'
)
const sampleEpub = epub(3, false)
const samplePdf = basicPdf()
const sampleCbz = zip([
  ['01.png', png(400, 600, [180, 50, 50])],
  ['02.png', png(400, 600, [50, 180, 50])],
  ['03.png', png(400, 600, [50, 50, 180])],
])
// 长条漫：真实页高远大于 1.45 比例估高，用于验证快速滚动的页码映射。
const stripPng = png(240, 4800, [40, 120, 200])
const sampleStrip = zip(
  Array.from({ length: 40 }, (_, i) => [`${String(i + 1).padStart(2, '0')}.png`, stripPng])
)
// 参差条漫：短页与超长页交替的图片目录，中位数估高无法代表任何一页，
// 用于回归“滑动一段时间后页码映射虚高、视图被带跳几十页”。
// 图宽 1200 大于阅读视口，适宽只会缩小——与真实条漫一致。
const raggedHeights = Array.from({ length: 40 }, (_, i) => (i < 3 ? 2000 : 12_000))
const raggedPages = raggedHeights.map((height, i) => png(1200, height, [90, 60, 160]))
// 参差条漫压缩包：与目录版同构（3 短卡 + 37 长条页）。回归用户真实场景——
// 韩漫合集 zip 里平面估高被短卡带偏、快滚穿越未加载区时索引虚高跳几十页。
const raggedStrip = zip(raggedPages.map((data, i) => [`${String(i + 1).padStart(2, '0')}.png`, data]))

test.beforeAll(async () => {
  stagingTmp = await mkdtemp(join(tmpdir(), 'tgdrive-readers-build-'))
  readerOutDir = join(stagingTmp, 'reader')

  // 统一入口使用真实 Vite 构建；kind 只决定合成内容，不决定应用 ID。
  await build({
    configFile: false,
    root: resolve(root, 'reader'),
    base: './',
    publicDir: false,
    resolve: {
      alias: {
        mediabunny: resolve(modules, 'mediabunny/dist/modules/src/index.js'),
        'pdfjs-dist': resolve(modules, 'pdfjs-dist'),
        dompurify: resolve(modules, 'dompurify/dist/purify.es.mjs'),
        '@zip.js/zip.js': resolve(modules, '@zip.js/zip.js'),
      },
    },
    build: {
      outDir: readerOutDir,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
    },
  })


})

test.afterAll(async () => {
  if (stagingTmp) {
    await rm(stagingTmp, { recursive: true, force: true }).catch(() => {})
  }
})

/** 为指定测试页面配置路由代理与内存 Drive 注入 */
async function setupApp(
  page: Page,
  options: {
    kind: 'books' | 'comics' | 'mixed'
    viewport?: { width: number; height: number }
    unindexedFiles?: FileEntry[]
    readDelay?: number
    /** 延迟随请求字节数增长：头部探测远快于整图/整块读取，模拟真实网络。 */
    proportionalRead?: boolean
    sourcePaths?: string[]
    shelfNames?: string[]
    /** 额外合成文件（如长篇小说），追加到当前书库。 */
    extraFiles?: { entry: FileEntry; data: Buffer }[]
    dark?: boolean
  }
) {
  const { kind, viewport = { width: 1000, height: 700 }, unindexedFiles = [], readDelay = 0, proportionalRead = false, sourcePaths = ['/书库'], shelfNames = [], extraFiles = [], dark = false } = options
  await page.setViewportSize(viewport)

  const outsideRequests: string[] = []
  page.on('request', (req) => {
    const url = req.url()
    if (/^https?:\/\//.test(url) && !url.startsWith('http://standalone.local/')) {
      outsideRequests.push(url)
    }
  })

  // 准备合成文件
  const rootDir: FileEntry = {
    id: 1,
    name: '书库',
    path: '/书库',
    is_dir: true,
    size: 0,
    content_version: 'v1',
    created_at: 1000,
    modified_at: 1000,
    favorite: false,
  }

  const bookFiles: { entry: FileEntry; data: Buffer }[] = [
    {
      entry: {
        id: 101,
        name: '长篇.txt',
        path: '/书库/长篇.txt',
        is_dir: false,
        size: sampleTxt.length,
        content_version: 'v1',
        created_at: 1000,
        modified_at: 1000,
        favorite: false,
      },
      data: sampleTxt,
    },
    {
      entry: {
        id: 102,
        name: '示例.epub',
        path: '/书库/示例.epub',
        is_dir: false,
        size: sampleEpub.length,
        content_version: 'v1',
        created_at: 1010,
        modified_at: 1010,
        favorite: false,
      },
      data: sampleEpub,
    },
    {
      entry: {
        id: 103,
        name: '标准.pdf',
        path: '/书库/标准.pdf',
        is_dir: false,
        size: samplePdf.length,
        content_version: 'v1',
        created_at: 1020,
        modified_at: 1020,
        favorite: false,
      },
      data: samplePdf,
    },
  ]

  const comicFiles: { entry: FileEntry; data: Buffer }[] = [
    {
      entry: {
        id: 201,
        name: '漫画01.cbz',
        path: '/书库/漫画01.cbz',
        is_dir: false,
        size: sampleCbz.length,
        content_version: 'v1',
        created_at: 2000,
        modified_at: 2000,
        favorite: false,
      },
      data: sampleCbz,
    },
    {
      entry: {
        id: 202,
        name: '长条漫.cbz',
        path: '/书库/长条漫.cbz',
        is_dir: false,
        size: sampleStrip.length,
        content_version: 'v1',
        created_at: 2001,
        modified_at: 2001,
        favorite: false,
      },
      data: sampleStrip,
    },
    {
      entry: {
        id: 205,
        name: '参差条漫.zip',
        path: '/书库/参差条漫.zip',
        is_dir: false,
        size: raggedStrip.length,
        content_version: 'v1',
        created_at: 2004,
        modified_at: 2004,
        favorite: false,
      },
      data: raggedStrip,
    },
    {
      entry: {
        id: 204,
        name: '参差条漫',
        path: '/书库/参差条漫',
        is_dir: true,
        size: 0,
        content_version: 'v1',
        created_at: 2003,
        modified_at: 2003,
        favorite: false,
      },
      data: Buffer.alloc(0),
    },
    ...raggedPages.map((data, i) => ({
      entry: {
        id: 300 + i,
        name: `${String(i + 1).padStart(2, '0')}.png`,
        path: `/书库/参差条漫/${String(i + 1).padStart(2, '0')}.png`,
        is_dir: false,
        size: data.length,
        content_version: 'v1',
        created_at: 2010 + i,
        modified_at: 2010 + i,
        favorite: false,
      } satisfies FileEntry,
      data,
    })),
  ]

  const activeFiles = [...(kind === 'mixed' ? [...bookFiles, ...comicFiles] : kind === 'books' ? bookFiles : comicFiles), ...extraFiles]
  const allEntries: FileEntry[] = [rootDir, ...activeFiles.map((f) => f.entry), ...unindexedFiles]
  const dataMap = new Map<number, Buffer>()
  activeFiles.forEach((f) => dataMap.set(f.entry.id, f.data))

  // 虚拟 origin 静态文件拦截服务
  const outDir = readerOutDir
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    // WebKit 会拦截内存 blob: 图片；仅放行本夹具 origin 创建的本地资源，外部请求仍阻断。
    if (url.startsWith('blob:http://standalone.local/')) { await route.continue(); return }
    if (!url.startsWith('http://standalone.local/')) {
      await route.abort()
      return
    }

    const relPath = url.replace('http://standalone.local/', '').split('?')[0] || 'index.html'
    const filePath = join(outDir, relPath)

    try {
      const content = await readFile(filePath)
      let contentType = 'application/octet-stream'
      if (filePath.endsWith('.html')) contentType = 'text/html; charset=utf-8'
      else if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) contentType = 'application/javascript; charset=utf-8'
      else if (filePath.endsWith('.css')) contentType = 'text/css; charset=utf-8'
      else if (filePath.endsWith('.json')) contentType = 'application/json; charset=utf-8'

      await route.fulfill({
        status: 200,
        contentType,
        body: content,
      })
    } catch {
      await route.abort()
    }
  })

  // 在客户端注入符合规范的内存 Drive SDK
  const serializedList: { id: number; hex: string }[] = [...dataMap.entries()].map(([id, buf]) => ({
    id,
    hex: buf.toString('hex'),
  }))

  await page.addInitScript(
    ({ kind, entries, serializedList, readDelay, proportionalRead, sourcePaths, shelfNames, dark }) => {
      const storageStore = new Map<string, { key: string; value: any; revision: string; updated_at: number }>()
      const sources = sourcePaths.map((path, index) => {
        const source = entries.find(file => file.path === path && file.is_dir)!
        return { nodeId: source.id, name: shelfNames[index] ?? (source.path.split('/').pop() || '我的网盘'), path: source.path, contentVersion: source.content_version, addedAt: 1, rootConfirmed: false }
      })
      storageStore.set('library:shelves:v1', { key: 'library:shelves:v1', value: { schemaVersion: 1, sources }, revision: 'sources-1', updated_at: 1 })
      window.standaloneImmersion = { active: false, calls: [] }
      if (kind !== 'mixed') storageStore.set('preferences', { key: 'preferences', value: { mode: 'scroll', fit: 'width' }, revision: 'prefs-1', updated_at: 1 })
      let revCount = 0

      const dataEntries = new Map<number, Uint8Array>()
      for (const item of serializedList) {
        const len = item.hex.length / 2
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) {
          bytes[i] = parseInt(item.hex.substring(i * 2, i * 2 + 2), 16)
        }
        dataEntries.set(item.id, bytes)
      }

      ;(window as any).tgdrive = {
        ready: Promise.resolve({
          id: 'reader',
          name: '阅读馆',
          version: '1.0.0',
          api_version: 2,
          dark,
          capabilities: ['ui.setImmersive', 'ui.immersiveBackground'],
        }),
        settings: {
          get: async () => ({ source_dir: '/书库' }),
          patch: async () => ({}),
          open: async () => {},
        },
        ui: {
          close: async () => {},
          download: async () => {},
          setImmersive: async (active: boolean) => {
            window.standaloneImmersion.active = active
            window.standaloneImmersion.calls.push(active)
          },
        },
        on: () => () => {},
        media: {
          url: async (ref: any) => {
            const id = typeof ref === 'number' ? ref : ref.id
            const bytes = dataEntries.get(id)
            if (!bytes) return ''
            return URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
          },
        },
        files: {
          list: async ({ path, cursor, limit = 200 }: any) => {
            const list = entries.filter((e: any) => {
              if (e.path === path) return false
              const parent = e.path.substring(0, e.path.lastIndexOf('/')) || '/'
              return parent === path
            })
            return {
              entries: list,
              path,
              has_more: false,
              next_cursor: null,
            }
          },
          stat: async (ref: any) => {
            const found = entries.find((e: any) =>
              'id' in ref && ref.id !== undefined ? e.id === ref.id : e.path === ref.path
            )
            if (!found) throw new Error('File not found')
            return found
          },
          readRange: async (ref: any, offset: number, length: number) => {
            const id = typeof ref === 'number' ? ref : ref.id
            const full = dataEntries.get(id)
            if (!full) throw new Error('No data for file ' + id)
            if (readDelay > 0) {
              // 比例模式：延迟 ≈ rtt + (readDelay - rtt) × 字节占比；64 KiB 头部探测快，整块慢。
              const delay = proportionalRead
                ? Math.min(readDelay, 60 + Math.round((readDelay - 60) * Math.min(1, length / (2 * 1024 * 1024))))
                : readDelay
              await new Promise((resolve) => setTimeout(resolve, delay))
            }
            return full.slice(offset, offset + length)
          },
          searchPage: async () => ({ results: [], has_more: false, next_cursor: null }),
        },
        storage: {
          get: async (key: string) => storageStore.get(key) || null,
          set: async (key: string, value: any, expectedRevision?: string | null) => {
            const current = storageStore.get(key)
            if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
              throw Object.assign(new Error('存储冲突'), { code: 'storage_conflict' })
            }
            const record = { key, value, revision: `r${++revCount}`, updated_at: Date.now() }
            storageStore.set(key, record)
            return record
          },
          delete: async (key: string, expectedRevision?: string) => {
            storageStore.delete(key)
            return { ok: true }
          },
          list: async ({ prefix }: any = {}) => {
            const records = [...storageStore.values()].filter(
              (r) => !prefix || r.key.startsWith(prefix)
            )
            return { records, next_cursor: null }
          },
        },
      }
    },
    {
      kind,
      entries: allEntries,
      serializedList,
      readDelay,
      proportionalRead,
      sourcePaths,
      shelfNames,
      dark,
    }
  )

  await page.goto('http://standalone.local/index.html')
  await expect(page.locator('#app')).toBeVisible()

  return { outsideRequests }
}

async function expandLibraryFilters(page: Page) {
  const toggle = page.locator('#btn-library-filters')
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

async function enterShelf(page: Page) {
  const card = page.locator('#view-library .shelf-card').first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.locator('#items .library-card').first()).toBeVisible()
}

test.describe('standalone 真实无头浏览器全套阅读器验收', () => {
  test('手机书库紧凑首屏、折叠筛选与独立多选工具栏', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const { outsideRequests } = await setupApp(page, { kind: 'mixed', viewport: { width: 390, height: 844 } })
      await page.locator('#tab-library').click()
      await enterShelf(page)
      const toggle = page.locator('#btn-library-filters'), panel = page.locator('#library-filter-panel')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(panel).toBeHidden()
      const firstCard = page.locator('#items .library-card').first()
      const cardBox = (await firstCard.boundingBox())!
      const headerBox = (await page.locator('.mobile-header').boundingBox())!
      expect(headerBox.height, '插件顶栏不超过 50px').toBeLessThanOrEqual(50)
      // 手机由选中的筛选标签表达当前书库，重复的标题区隐藏，路径保留在标签提示里。
      await expect(page.locator('.library-heading')).toBeHidden()
      await expect(page.locator('#mobile-library-chips [aria-current="page"]')).toHaveAttribute('title', /\//)
      expect(cardBox.y, '390px 手机书籍首行应在 225px 内出现').toBeLessThanOrEqual(225)
      expect(await page.locator('#library-filter-count').isVisible()).toBe(false)
      await page.screenshot({ path: test.info().outputPath('mobile-library-compact.png') })
      await toggle.click()
      await expect(panel).toBeVisible()
      await page.locator('#filter-format').selectOption('cbz')
      await expect(page.locator('#items .library-card')).toHaveCount(2)
      await expect(page.locator('#library-filter-count')).toHaveText('1')
      await page.screenshot({ path: test.info().outputPath('mobile-library-expanded.png') })
      await page.locator('#btn-library-filters-done').click()
      await expect(panel).toBeHidden()
      await expect(toggle).toBeFocused()
      await page.screenshot({ path: test.info().outputPath('mobile-library-filtered.png') })
      await expandLibraryFilters(page)
      await expect(page.locator('#filter-format')).toHaveValue('cbz')
      await page.locator('#filter-kind').selectOption('comics')
      await expect(page.locator('#filter-kind')).toHaveValue('comics')
      await expect(page.locator('#filter-format')).toHaveValue('')
      await expect(panel).toBeVisible()
      await page.locator('#btn-library-clear-filters').click()
      await expect(page.locator('#library-filter-count')).toBeHidden()
      await expect(page.locator('#items .library-card')).toHaveCount(7)
      await page.getByRole('button', { name: '管理分组', exact: true }).click()
      await page.getByRole('textbox', { name: '新分组名称', exact: true }).fill('精选')
      await page.getByRole('button', { name: '新建', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '分组名称：精选', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.getByRole('button', { name: '批量分组', exact: true }).click()
      await expect(panel).toBeHidden()
      await expect(page.locator('#book-group-selection')).toBeVisible()
      await page.locator('#items [data-file-id="101"]').click()
      await expect(page.locator('#group-selection-count')).toHaveText('已选 1 本')
      await page.getByRole('combobox', { name: '移动到分组', exact: true }).selectOption({ label: '精选' })
      await page.getByRole('button', { name: '移动', exact: true }).click()
      await expect(page.locator('#items [data-file-id="101"] .book-group-badge')).toHaveText('精选')
      await page.screenshot({ path: test.info().outputPath('mobile-library-selection.png') })
      await page.getByRole('button', { name: '退出多选', exact: true }).click()
      await expect(page.locator('#book-group-selection')).toHaveCount(0)
      await expect(panel).toBeHidden()
      const controls = await page.locator('.mobile-header button, .library-toolbar button:visible, .library-heading button:visible').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      }))
      expect(controls.every(box => box.width >= 44 && box.height >= 44), '折叠后所有触控按钮保持 44px 点击区').toBe(true)
      expect(await page.locator('.ui-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(outsideRequests).toEqual([])
      expect(errors).toEqual([])
    } finally { await context.close() }
  })

  test('桌面书库常驻筛选与长书库名称不溢出', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const name = 'A_Long_Unbreakable_Library_Name_'.repeat(2)
    const { outsideRequests } = await setupApp(page, { kind: 'mixed', viewport: { width: 1280, height: 900 }, shelfNames: [name] })
    await page.locator('#nav-library').click()
    await enterShelf(page)
    await expect(page.locator('#btn-library-filters')).toBeHidden()
    await expect(page.locator('#library-filter-panel')).toBeVisible()
    await expect(page.locator('.library-heading h2')).toHaveText(name)
    const heading = (await page.locator('.library-heading').boundingBox())!
    expect(heading.height).toBeLessThanOrEqual(47)
    expect(await page.locator('.ui-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('desktop-library-compact.png') })
    expect(outsideRequests).toEqual([])
    expect(errors).toEqual([])
  })

  for (const width of [390, 1280]) {
    test(`漫画全屏适页、适宽与悬浮菜单 ${width}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const height = 900
      const { outsideRequests } = await setupApp(page, { kind: 'mixed', viewport: { width, height } })
      await page.locator('#nav-library, #tab-library').filter({ visible: true }).first().click()
      await enterShelf(page)
      await page.locator('#items .library-card', { hasText: '漫画01' }).click()
      await expect(page.locator('#position')).not.toHaveText('')
      const viewport = page.locator('#viewport'), image = viewport.locator('img').first()
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(400)
      const geometry = () => page.evaluate(() => {
        const viewport = document.getElementById('viewport')!, image = viewport.querySelector('img')!
        const box = viewport.getBoundingClientRect(), picture = image.getBoundingClientRect(), style = getComputedStyle(viewport)
        return { x: box.x, y: box.y, width: box.width, height: box.height, imageWidth: picture.width, imageHeight: picture.height,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] }
      })
      const fitted = await geometry()
      expect(fitted.x).toBe(0); expect(fitted.y).toBe(0)
      expect(fitted.width).toBe(width); expect(fitted.height).toBe(height)
      expect(fitted.padding).toEqual(['0px', '0px', '0px', '0px'])
      expect(fitted.imageWidth / fitted.imageHeight).toBeCloseTo(2 / 3, 3)
      expect(fitted.imageWidth).toBe(width)
      expect(fitted.imageHeight).toBeCloseTo(width * 1.5, 2)
      if (width > 768) {
        expect(fitted.imageHeight, '适宽小图超过视口时应允许上下滚动').toBeGreaterThan(height)
        await expect(page.locator('#app')).toHaveAttribute('data-controls', 'visible')
        await page.mouse.click(width / 2, height / 2)
      }
      await expect(page.locator('#app')).toHaveAttribute('data-controls', 'hidden')
      expect(await geometry()).toEqual(fitted)
      expect(await page.evaluate(() => window.standaloneImmersion.active)).toBe(true)
      await page.screenshot({ path: test.info().outputPath('comic-fullscreen.png') })
      await viewport.focus(); await page.keyboard.press('Escape')
      await expect(page.locator('#back')).toBeVisible()
      expect(await geometry()).toEqual(fitted)
      await page.locator('#preferences-toggle').click()
      expect(await geometry()).toEqual(fitted)
      await page.locator('#fit').selectOption('width')
      await expect.poll(async () => (await geometry()).imageWidth).toBe(width)
      expect((await geometry()).imageHeight).toBeCloseTo(width * 1.5, 2)
      await page.locator('#zoom').selectOption('0.5')
      await expect.poll(async () => (await geometry()).imageWidth).toBe(width / 2)
      await page.locator('#fit').selectOption('page')
      await page.locator('#zoom').selectOption('1')
      await expect.poll(async () => (await geometry()).imageHeight).toBe(Math.min(height, width * 1.5))
      await page.locator('#preferences [data-close-panel]').click()
      await page.locator('#back').click()
      await expect(page.locator('#app-ui')).toBeVisible()
      // 手机书库同样保持沉浸（插件自带返回网盘）；桌面返回书库后恢复宿主外壳。
      await expect.poll(() => page.evaluate(() => window.standaloneImmersion.active)).toBe(width < 768)
      expect(errors).toEqual([]); expect(outsideRequests).toEqual([])
    })
  }

  for (const width of [320, 1440]) {
    test(`主页手动目录书库切换与库内分组 ${width}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const { outsideRequests } = await setupApp(page, {
        kind: 'mixed', viewport: { width, height: 900 }, sourcePaths: ['/书库', '/书库/参差条漫'],
      })
      const sidebar = page.locator('#library-sidebar'), chips = page.locator('#mobile-library-chips')
      const mobile = width < 769
      // 手机没有抽屉：书库入口在书库页顶部横滑筛选；桌面仍用常驻侧栏。
      const shortcuts = mobile ? chips : sidebar
      const choose = async (id: string) => {
        if (mobile && !(await chips.isVisible())) await page.locator('#tab-library').click()
        await shortcuts.locator(`[data-library-id="${id}"]`).click()
        await expect(page.locator('#items .library-card').first()).toBeVisible()
        await expandLibraryFilters(page)
      }
      await expect(page.locator('#view-home')).toBeVisible()
      if (mobile) {
        await expect(sidebar).toBeHidden()
        await expect(page.locator('#btn-mobile-libraries')).toHaveCount(0)
        await expect(chips).toBeHidden()
        await page.locator('#tab-library').click()
        await expect(chips).toBeVisible()
        await expect(chips.locator('#chip-library-all')).toHaveAttribute('aria-current', 'page')
        const scroll = await chips.evaluate(element => ({ overflow: getComputedStyle(element).overflowX, page: document.documentElement.scrollWidth <= innerWidth }))
        expect(scroll).toEqual({ overflow: 'auto', page: true })
      } else {
        await expect(sidebar).toBeVisible()
        const box = (await sidebar.boundingBox())!
        expect(box.y).toBe(0); expect(box.height).toBe(900)
      }
      await expect(shortcuts.locator('[data-library-id^="kind:"], [data-library-id^="format:"], [data-library-id^="group:"]')).toHaveCount(0)
      await choose('source:1')
      await page.locator('#filter-format').selectOption('pdf')
      await expect(page.locator('#filter-format')).toHaveValue('pdf')
      await expect(page.locator('#items .library-card')).toHaveCount(1)
      await page.locator('#filter-kind').selectOption('comics')
      await expect(page.locator('#filter-kind')).toHaveValue('comics')
      await expect(page.locator('#filter-format')).toHaveValue('')
      await expect(page.locator('#items .library-card')).toHaveCount(4)
      await page.locator('#library-search').fill('无匹配关键词')
      await expect(page.locator('#items .library-card')).toHaveCount(0)
      await choose('source:204')
      await expect(page.locator('#filter-source')).toHaveValue('204')
      await expect(page.locator('#filter-kind')).toHaveValue('')
      await expect(page.locator('#library-search')).toHaveValue('')
      await expect(page.locator('#items .library-card')).toHaveCount(1)
      await expect(page.locator('#items .library-card .file-mark')).toHaveText('目录')
      await choose('source:1')
      await page.getByRole('button', { name: '管理分组', exact: true }).click()
      await page.getByRole('textbox', { name: '新分组名称', exact: true }).fill('小说')
      await page.getByRole('button', { name: '新建', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '分组名称：小说', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.getByRole('button', { name: '批量分组', exact: true }).click()
      await page.locator('#items [data-file-id="101"]').click()
      await page.getByRole('combobox', { name: '移动到分组', exact: true }).selectOption({ label: '小说' })
      await page.getByRole('button', { name: '移动', exact: true }).click()
      await expect(page.locator('#items [data-file-id="101"] .book-group-badge')).toHaveText('小说')
      const groupId = await page.locator('#filter-book-group option', { hasText: '小说' }).getAttribute('value')
      await page.getByRole('button', { name: '退出多选', exact: true }).click()
      await page.locator('#nav-home, #tab-home').filter({ visible: true }).first().click()
      await expect(page.locator('#view-home')).toBeVisible()
      if (mobile) await page.locator('#tab-library').click()
      await expect(shortcuts.locator('[data-library-id="source:1"]')).toContainText('书库')
      await page.screenshot({ path: test.info().outputPath('sidebar-home.png') })
      await shortcuts.locator('[data-library-id="source:1"]').click()
      await expandLibraryFilters(page)
      await page.locator('#filter-book-group').selectOption(groupId!)
      await expect(page.locator('#items .library-card')).toHaveCount(1)
      await expect(page.locator('#items .library-card')).toHaveAttribute('data-file-id', '101')
      await page.locator('#items .library-card').click()
      await expect(page.locator('#position')).not.toHaveText('')
      if (await page.locator('#app.immersive').count()) { await page.locator('#viewport').focus(); await page.keyboard.press('Escape') }
      await page.locator('#back').click()
      await expect(page.locator('#app-ui')).toBeVisible()
      await expect(page.locator('#filter-book-group')).toHaveValue(groupId!)
      await page.getByRole('button', { name: '管理分组', exact: true }).click()
      await page.getByRole('textbox', { name: '分组名称：小说', exact: true }).fill('文学')
      await page.getByRole('button', { name: '改名', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '分组名称：文学', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await expect(shortcuts.locator('[data-library-id="source:1"]')).toContainText('书库')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(outsideRequests).toEqual([])
      expect(errors).toEqual([])
    })
  }

  for (const width of [390, 1280]) {
    test(`阅读馆混合书库同入口筛选并切换文字与漫画 ${width}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const { outsideRequests } = await setupApp(page, { kind: 'mixed', viewport: { width, height: 900 } })
      await page.locator('#nav-library, #tab-library').filter({ visible: true }).first().click()
      await enterShelf(page)
      const cards = page.locator('#items .library-card')
      await expect(cards.filter({ hasText: '长篇' })).toBeVisible()
      await expect(cards.filter({ hasText: '漫画01' })).toBeVisible()
      // kind 仍表示夹具内容；合并应用需识别每个文件的格式来选择底层解析器。
      for (const [format, title, marker] of [
        ['txt', '长篇', '.flow-content'],
        ['cbz', '漫画01', '.comic-page img'],
        ['epub', '示例', '.flow-content'],
        ['pdf', '标准', 'canvas'],
        ['images', '参差条漫', '.comic-page img'],
      ]) {
        await expandLibraryFilters(page)
        await page.getByRole('combobox', { name: '筛选格式', exact: true }).selectOption(format!)
        await expect(cards.filter({ hasText: title! })).toHaveCount(1)
        await cards.filter({ hasText: title! }).click()
        await expect(page.locator('#reader')).toBeVisible()
        await expect(page.locator('#reading-status')).toHaveText('')
        // 参差条漫按图片比例自动进入连续滚动，会同时渲染多页。
        await expect(page.locator(`#viewport ${marker}`).first()).toBeVisible()
        if (format === 'txt' || format === 'epub') await expect(page.locator('#mode')).toHaveValue('page')
        else {
          await expect(page.locator('#fit')).toHaveValue(format === 'pdf' ? 'page' : 'width')
          if (format !== 'pdf') await expect(page.locator('#comic-mode')).toHaveValue(format === 'images' ? 'scroll' : 'single')
        }
        if (await page.locator('#app.immersive').count()) {
          await page.locator('#viewport').focus()
          await page.keyboard.press('Escape')
        }
        await page.locator('#back').click()
        await expect(page.locator('#app-ui')).toBeVisible()
      }
      await page.getByRole('combobox', { name: '筛选格式', exact: true }).selectOption('')
      await expect(cards.filter({ hasText: '长篇' })).toBeVisible()
      await expect(cards.filter({ hasText: '漫画01' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(outsideRequests).toEqual([])
      expect(errors).toEqual([])
    })
  }

  test('1. 多视口适配（320、390、430、横屏844x390、768、1440）与触控尺寸及无水平溢出', async ({
    page,
  }) => {
    const viewports = [
      { width: 320, height: 568, label: '320小屏手机' },
      { width: 390, height: 844, label: '390标准手机' },
      { width: 430, height: 932, label: '430大屏手机' },
      { width: 844, height: 390, label: '手机横屏' },
      { width: 768, height: 1024, label: '768平板' },
      { width: 1440, height: 900, label: '1440桌面端' },
    ]

    for (const vp of viewports) {
      const { outsideRequests } = await setupApp(page, { kind: 'books', viewport: vp })

      // 切换到书库视图（自适应桌面侧栏与移动端底栏）
      const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
      await libBtn.click()
      await enterShelf(page)
      await expect(page.locator('#items .library-card').first()).toBeVisible()
      if (vp.width <= 768) {
        await expect(page.locator('#library-filter-panel')).toBeHidden()
        expect((await page.locator('#items .library-card').first().boundingBox())!.y, `${vp.label} 首行封面及时出现`).toBeLessThanOrEqual(225)
      }
      expect(await page.locator('.ui-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)

      // 验证页面无水平溢出
      const isOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(isOverflow, `${vp.label} 下书库页面不应发生水平溢出`).toBe(false)

      // 单卷作品点击直达阅读器
      await page.locator('#items .library-card', { hasText: '长篇' }).first().click()
      await expect(page.locator('#reader')).toBeVisible()
      await expect(page.locator('#viewport')).toContainText('这是第一章的内容')
      // 正文可先于 open() 完成挂载；位置出现后，opened() 才已完成默认收起工具栏。
      await expect(page.locator('#position')).not.toHaveText('')

      // 手机/平板窄屏下阅读器自进入沉浸模式：先唤出工具栏再操作菜单。
      // 桌面端视口下验证设置面板步进按钮触控尺寸满足 >= 44px
      if (vp.width >= 1000) {
        const prefBtn = page.locator('#preferences-toggle')
        await prefBtn.click()
        const stepBtn = page.locator('.step-btn').first()
        await expect(stepBtn).toBeVisible()
        const box = await stepBtn.boundingBox()
        expect(box!.width, `${vp.label} 下步进按钮宽度需 >= 44px`).toBeGreaterThanOrEqual(44)
        expect(box!.height, `${vp.label} 下步进按钮高度需 >= 44px`).toBeGreaterThanOrEqual(44)
        await prefBtn.click()
      } else if (await page.locator('#app.immersive').count()) {
        await expect(page.locator('#app.immersive')).toHaveCount(1)
        // 唤出沉浸工具栏存在轻微竞态：仅在工具栏未显示时按键，避免无效重复触发；
        // 若面板恰好打开首键仅关面板，下一轮再补一键即可唤出。
        await expect(async () => {
          if (!(await page.locator('#back').isVisible())) {
            await page.locator('#viewport').focus()
            await page.keyboard.press('Escape')
          }
          await expect(page.locator('#back')).toBeVisible({ timeout: 1_500 })
        }).toPass({ timeout: 15_000 })
      }

      // 从阅读器更多菜单进入作品详情，详情页同样不得水平溢出
      await page.locator('#reader-more-toggle').click()
      await page.locator('#btn-reader-detail').click()
      await expect(page.locator('#detail-title')).toBeVisible()
      const isDetailOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(isDetailOverflow, `${vp.label} 下详情页面不应发生水平溢出`).toBe(false)

      // 返回内容库
      await page.locator('#btn-detail-back').click()
      await expect(page.locator('#app-ui')).toBeVisible()

      // 验证全程绝无外部网络请求
      expect(outsideRequests).toEqual([])
    }
  })

  test('2. 真实长篇 TXT 阅读、阅读目录定位与书签记录', async ({ page }) => {
    const { outsideRequests } = await setupApp(page, { kind: 'books' })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)

    // 单卷作品点击直达阅读器
    await page.locator('#items .library-card', { hasText: '长篇' }).first().click()
    await expect(page.locator('#reader')).toBeVisible()
    await expect(page.locator('#viewport')).toContainText('这是第一章的内容')

    // 按需加载阅读目录（验证不写阅读进度）
    await page.locator('#toc-toggle').click()
    await expect(page.locator('#navigation .toc-item-btn')).toHaveCount(3)

    // 点击第2章直接阅读
    await page.locator('#navigation .toc-item-btn', { hasText: '第2章' }).click()
    await expect(page.locator('#viewport')).toContainText('这是第二章的内容')

    // 添加书签：书签列表收在「更多」里，顶栏只留快捷书签开关
    await page.locator('#reader-more-toggle').click()
    await page.locator('#bookmarks-toggle').click()
    await page.locator('#bookmark-name').fill('独立书签测试')
    await page.locator('#add-bookmark').click()
    await expect(page.getByRole('textbox', { name: '修改书签名称' })).toHaveValue('独立书签测试')

    // 返回书库
    await page.locator('#back').click()
    await expect(page.locator('#app-ui')).toBeVisible()
    expect(outsideRequests).toEqual([])
  })

  test('3. 真实 EPUB 2/3 阅读、章节导航与防 XSS 注入（无脚本执行、无外部资源）', async ({ page }) => {
    const { outsideRequests } = await setupApp(page, { kind: 'books' })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)

    // 单卷作品点击直达阅读器
    await page.locator('#items .library-card', { hasText: '示例' }).first().click()
    await expect(page.locator('#reader')).toBeVisible()
    await expect(page.locator('#reading-status')).toHaveText('')

    // 验证正文呈现且 DOM 中绝不执行恶意注入脚本
    await expect(page.locator('#viewport')).toContainText('起点')
    const isInjected = await page.evaluate(() => (window as any).__readerInjected ?? false)
    expect(isInjected, '沙箱中不应执行 EPUB 内部内联脚本').toBe(false)

    // 验证绝无外部网络请求
    expect(outsideRequests).toEqual([])

    await page.locator('#back').click()
  })

  test('4. 真实 PDF 解析、Canvas 渲染与独立缩略图', async ({ page }) => {
    const { outsideRequests } = await setupApp(page, { kind: 'books' })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)

    // 单卷作品点击直达阅读器
    await page.locator('#items .library-card', { hasText: '标准' }).first().click()
    await expect(page.locator('#reader')).toBeVisible()
    await expect(page.locator('#reading-status')).toHaveText('', { timeout: 20000 })

    // 验证真实 Canvas 绘制
    const canvas = page.locator('#viewport canvas').first()
    await expect(canvas).toBeVisible()

    // 检查 Canvas 是否有实际像素内容
    const hasPixels = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement
      const ctx = c.getContext('2d')
      if (!ctx) return false
      const imgData = ctx.getImageData(0, 0, Math.min(100, c.width), Math.min(100, c.height))
      return imgData.data.some((p) => p > 0)
    })
    expect(hasPixels, 'PDF 必须由 PDF.js 实际绘制到 Canvas 上').toBe(true)

    expect(outsideRequests).toEqual([])
    await page.locator('#back').click()
  })

  test('5. 真实漫画（CBZ）阅读与单双页翻页控制', async ({ page }) => {
    const { outsideRequests } = await setupApp(page, { kind: 'comics' })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)

    // 单卷作品点击直达阅读器
    await page.locator('#items .library-card', { hasText: '漫画01' }).first().click()
    await expect(page.locator('#reader')).toBeVisible()
    await expect(page.locator('#reading-status')).toHaveText('')

    // 漫画图片真实渲染
    await expect(page.locator('#viewport img').first()).toBeVisible()

    // 切换为双页模式
    await page.locator('#preferences-toggle').click()
    const modeSelect = page.locator('#comic-mode')
    if (await modeSelect.isVisible()) {
      await modeSelect.selectOption('double')
      await expect(page.locator('#viewport')).toHaveAttribute('data-comic-mode', 'double')
    }

    expect(outsideRequests).toEqual([])
    await page.locator('#back').click()
  })

  test('6. 手机端书库只能上下滚动且底部导航贴底，长文件名不撑破宽度', async ({ browser }) => {
    // 超长不可断行英文文件名：下划线无断行机会，是历史上把内容区变成双向滚动容器的典型内容。
    const longName = (index: number) =>
      `A_Very_Long_Unbreakable_Comic_Name_v000123456789012345_${index}.cbz`
    const unindexedFiles: FileEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: 300 + i,
      name: longName(i),
      path: `/书库/${longName(i)}`,
      is_dir: false,
      size: 1000,
      content_version: 'v1',
      created_at: 3000 + i,
      modified_at: 3000 + i,
      favorite: false,
    }))

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()
    try {
      const { outsideRequests } = await setupApp(page, {
        kind: 'comics',
        viewport: { width: 390, height: 844 },
        unindexedFiles,
      })

      // 手机端从底部标签栏进入书库
      await page.locator('#tab-library').click()
      await enterShelf(page)
      await expect(page.locator('#items .library-card').first()).toBeVisible()
      expect(await page.locator('#items .library-card').count()).toBeGreaterThanOrEqual(30)

      // 内容区必须锁定竖向：overflow-x 显式 hidden，且没有任何横向溢出。
      const metrics = await page.evaluate(() => {
        const ui = document.querySelector('.ui-content') as HTMLElement
        return {
          overflowX: getComputedStyle(ui).overflowX,
          scrollWidth: ui.scrollWidth,
          clientWidth: ui.clientWidth,
          scrollHeight: ui.scrollHeight,
          clientHeight: ui.clientHeight,
          docOverflow: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      expect(metrics.overflowX, '手机书库内容区 overflow-x 必须为 hidden，防止被左右拖动').toBe('hidden')
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
      expect(metrics.docOverflow).toBe(false)
      expect(metrics.scrollHeight, '书库内容必须足够高以验证竖向滚动').toBeGreaterThan(metrics.clientHeight)

      // 真实触摸拖动：横向带不动内容，纵向能滚屏。
      const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const session = await page.context().newCDPSession(page)
        try {
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: from.x, y: from.y, id: 1 }],
          })
          for (let i = 1; i <= 8; i++) {
            await session.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [
                {
                  x: from.x + ((to.x - from.x) * i) / 8,
                  y: from.y + ((to.y - from.y) * i) / 8,
                  id: 1,
                },
              ],
            })
          }
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } finally {
          await session.detach()
        }
      }
      await swipe({ x: 320, y: 500 }, { x: 40, y: 500 })
      expect(
        await page.locator('.ui-content').evaluate((el) => el.scrollLeft),
        '横向触摸拖动不允许带动书库内容'
      ).toBe(0)

      await swipe({ x: 195, y: 700 }, { x: 195, y: 450 })
      expect(
        await page.locator('.ui-content').evaluate((el) => el.scrollTop),
        '纵向触摸拖动必须正常滚动书库'
      ).toBeGreaterThan(0)

      // 手机操作页面骨架：顶栏在顶、标签栏贴底、内容区夹在中间滚动。
      const header = (await page.locator('.mobile-header').boundingBox())!
      const nav = (await page.locator('.mobile-bottom-nav').boundingBox())!
      const ui = (await page.locator('.ui-content').boundingBox())!
      expect(header.y).toBe(0)
      expect(nav.y + nav.height, '底部导航栏必须贴住屏幕底边').toBe(844)
      expect(ui.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
      expect(ui.y + ui.height).toBeLessThanOrEqual(nav.y + 1)
      expect(ui.height).toBeGreaterThan(0)

      expect(outsideRequests).toEqual([])
    } finally {
      await context.close()
    }
  })

  test('7. 长条漫快速滚动不虚报页码，真实页高修正后不向前跳页', async ({ page }) => {
    // 读取延迟 800ms：确保跳跃后未知页来不及加载，页码映射只能依赖占位估高。
    await setupApp(page, { kind: 'comics', readDelay: 800 })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)
    await page.locator('#items .library-card', { hasText: '长条漫' }).first().click()
    await expect(page.locator('#reading-status')).toHaveText('')
    const viewport = page.locator('#viewport')

    // 等首页真实加载完成，并等至少三页采样让未知页占位学习到真实页高（轨道显著变高即生效）。
    await expect.poll(() => viewport.evaluate((node) => {
      const figure = node.querySelector('figure.comic-page') as HTMLElement | null
      return figure ? Math.round(figure.getBoundingClientRect().height) : 0
    }), { timeout: 5000 }).toBeGreaterThan(4000)
    await expect.poll(() => viewport.evaluate((node) => Math.round(node.scrollHeight)), { timeout: 8000 }).toBeGreaterThan(80_000)
    const realHeight = await viewport.evaluate(
      () => document.querySelector('figure.comic-page')!.getBoundingClientRect().height
    )

    // 模拟快速惯性甩动：一次跨越约 4.2 个真实页高，途经多个未加载占位页。
    await viewport.evaluate((node, target) => { node.scrollTop = target }, Math.round(realHeight * 4.2))
    await page.waitForTimeout(250)
    const positionText = (await page.locator('#position').textContent()) ?? ''
    const mapped = Number(positionText.split(' / ')[0])
    // 物理位置落在第 5 页（1 基）；修复前固定估高会把它虚报到 12 页左右。
    expect(Number.isFinite(mapped) && mapped > 0, `页码指示异常：${positionText}`).toBe(true)
    expect(mapped, `快速滚动后页码不应虚报：${positionText}`).toBeLessThanOrEqual(7)
    expect(mapped).toBeGreaterThanOrEqual(3)

    // 加载完成后视图与页码保持一致，不出现向前跳页。
    await page.waitForTimeout(3500)
    const settled = await viewport.evaluate((node) => {
      const box = node.getBoundingClientRect()
      let visible: number | null = null
      for (const figure of [...node.querySelectorAll('figure.comic-page')] as HTMLElement[]) {
        const rect = figure.getBoundingClientRect()
        if (rect.top <= box.top + 80 && rect.bottom > box.top + 80) visible = Number(figure.dataset.index)
      }
      return {
        scrollTop: Math.round(node.scrollTop),
        visible,
        position: document.querySelector('#position')?.textContent ?? '',
      }
    })
    expect(settled.visible, `加载后视图应与页码一致：${JSON.stringify(settled)}`).not.toBeNull()
    expect(Math.abs((settled.visible ?? 0) - (mapped - 1)), `加载后不应向前跳页：${JSON.stringify(settled)}`).toBeLessThanOrEqual(2)
  })

  test('8. 参差条漫阅读中快滚不再被估高带跳几十页，页码与真实内容一致', async ({ page }) => {
    // 比例延迟：64 KiB 头部探测远快于整图读取，模拟真实网络。
    await setupApp(page, { kind: 'comics', readDelay: 800, proportionalRead: true })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)
    await page.locator('#items .library-card', { hasText: '参差条漫' }).first().click()
    await expect(page.locator('#reading-status')).toHaveText('', { timeout: 15_000 })
    const viewport = page.locator('#viewport')

    // 等首页与头部探测就位：轨道高度达到真实内容量级（探测环内的页已精确）。
    await expect
      .poll(() => viewport.evaluate((node) => Math.round(node.scrollHeight)), { timeout: 12_000 })
      .toBeGreaterThan(80_000)

    // 一次大幅快滚。真实内容落在第 8 页（1 基）附近；修复前首页短图让学习估高收敛到
    // 2000，同一位置会被虚报到 30 页上下，阅读位置被带跳几十页且永久丢失中间内容。
    await viewport.evaluate((node) => { node.scrollTop = 50_000 })
    await page.waitForTimeout(1_200)
    const result = await viewport.evaluate((node, heights) => {
      const image = node.querySelector<HTMLElement>('figure.comic-page img')
      const width = image ? image.getBoundingClientRect().width : node.clientWidth
      const cum = [0]
      for (const height of heights) cum.push(cum[cum.length - 1]! + (height * width) / 1200)
      let expected = 0
      while (expected + 1 < cum.length && cum[expected + 1]! <= node.scrollTop) expected++
      return {
        scrollTop: Math.round(node.scrollTop),
        expected,
        reported: Number(((document.querySelector('#position')?.textContent) ?? '').split(' / ')[0]) - 1,
      }
    }, raggedHeights)
    expect(
      Math.abs(result.reported - result.expected),
      `页码应与真实内容一致：${JSON.stringify(result)}`
    ).toBeLessThanOrEqual(1)
  })

  test('9. 压缩包参差条漫快滚不跳几十页：窗口探测真实尺寸穿越短卡区', async ({ page }) => {
    // 用户的真实形态：几百 MB 韩漫合集 zip、一册上千页。压缩包页经 readHead
    // 只解压条目头部（读够即中止，约一个共享分块），窗口内拿到真实尺寸。
    await setupApp(page, { kind: 'comics', readDelay: 600, proportionalRead: true })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()
    await enterShelf(page)
    await page.locator('#items .library-card', { hasText: '参差条漫.zip' }).first().click()
    await expect(page.locator('#reading-status')).toHaveText('', { timeout: 20_000 })
    const viewport = page.locator('#viewport')

    // 等首屏加载与窗口探测就位。
    await page.waitForTimeout(2_500)

    // 大幅快滚到 50_000px：真实内容落在第 6 页（0 基）内。
    // 修复前：短卡把平面估高带偏，长条页占位过矮，同一位置被虚报到 ~30 页。
    await viewport.evaluate((node) => { node.scrollTop = 50_000 })
    await page.waitForTimeout(1_800)
    const result = await viewport.evaluate((node, heights) => {
      const image = node.querySelector<HTMLElement>('figure.comic-page img')
      const width = image ? image.getBoundingClientRect().width : node.clientWidth
      const cum = [0]
      for (const height of heights) cum.push(cum[cum.length - 1]! + (height * width) / 1200)
      let expected = 0
      while (expected + 1 < cum.length && cum[expected + 1]! <= node.scrollTop) expected++
      return {
        scrollTop: Math.round(node.scrollTop),
        expected,
        reported: Number(((document.querySelector('#position')?.textContent) ?? '').split(' / ')[0]) - 1,
      }
    }, raggedHeights)
    expect(
      Math.abs(result.reported - result.expected),
      `压缩包页码应与真实内容一致：${JSON.stringify(result)}`
    ).toBeLessThanOrEqual(1)
  })
})

for (const width of [320, 1440]) {
  test('图书分组创建、批量移动、筛选、改名和删除 ' + width, async ({ page }) => {
    await setupApp(page, { kind: 'books', viewport: { width, height: 900 } })
    await page.locator('#nav-library, #tab-library').filter({ visible: true }).first().click()
    await enterShelf(page)
    await expect(page.locator('#items .library-card')).toHaveCount(3)
    await expandLibraryFilters(page)
    await page.getByRole('button', { name: '管理分组', exact: true }).click()
    await page.getByRole('textbox', { name: '新分组名称', exact: true }).fill('小说')
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '分组名称：小说', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: '批量分组', exact: true }).click()
    await page.locator('.library-card[data-file-id="101"]').click()
    await expect(page.locator('#reader')).toBeHidden()
    await page.getByRole('combobox', { name: '移动到分组', exact: true }).selectOption({ label: '小说' })
    await page.getByRole('button', { name: '移动', exact: true }).click()
    await expect(page.locator('.library-card[data-file-id="101"] .book-group-badge')).toHaveText('小说')
    await expandLibraryFilters(page)
    await page.getByRole('combobox', { name: '筛选分组', exact: true }).selectOption({ label: '小说' })
    await expect(page.locator('#items .library-card')).toHaveCount(1)
    await expect(page.locator('#group-selection-count')).toHaveText('已选 0 本')
    await page.getByRole('button', { name: '全选当前页', exact: true }).click()
    await expect(page.locator('#group-selection-count')).toHaveText('已选 1 本')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.ui-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('groups.png') })
    await page.getByRole('button', { name: '管理分组', exact: true }).click()
    await page.screenshot({ path: test.info().outputPath('group-manager.png') })
    await page.getByRole('textbox', { name: '分组名称：小说', exact: true }).fill('文学')
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '分组名称：文学', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('不会删除文件')
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '分组名称：文学', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('combobox', { name: '筛选分组', exact: true }).selectOption({ label: '未分组' })
    await expect(page.locator('#items .library-card')).toHaveCount(3)
    await page.getByRole('button', { name: '退出多选', exact: true }).click()
    await page.locator('.library-card[data-file-id="101"]').click()
    await expect(page.locator('#reader')).toBeVisible()
  })
}

// ==================== iPhone 主屏幕阅读界面（2026-11 改版） ====================
const novelText = Buffer.from(Array.from({ length: 6 }, (_, chapter) => `第${chapter + 1}章 远行之${['始', '路', '雨', '城', '夜', '归'][chapter]}\n` + Array.from({ length: 40 }, (_, line) =>
  `　　${chapter + 1}-${line + 1} 清晨的雾气还没有散去，他沿着河岸慢慢往前走，脚下的石板被露水打湿，远处传来几声犬吠。风从山谷里吹过来，带着松针和泥土的味道。`).join('\n')).join('\n'), 'utf8')
const novel: { entry: FileEntry; data: Buffer } = {
  entry: { id: 150, name: '远行.txt', path: '/书库/远行.txt', is_dir: false, size: novelText.length, content_version: 'v1', created_at: 3000, modified_at: 3000, favorite: false },
  data: novelText,
}
const shotDir = process.env.TGDRIVE_UI_SHOTS ?? join(tmpdir(), 'tgdrive-ui-shots')
const iphone = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

async function openNovel(page: Page) {
  if (await page.locator('#tab-library').isVisible()) await page.locator('#tab-library').click()
  await enterShelf(page)
  await page.locator('.library-card[data-file-id="150"]').click()
  await expect(page.locator('#reader')).toBeVisible()
  await expect(page.locator('#reading-status')).toHaveText('')
  await expect(page.locator('#position')).not.toHaveText('')
}
async function tapCenter(page: Page) {
  const box = (await page.locator('#viewport').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('iPhone 主屏幕阅读界面', () => {
  for (const dark of [false, true]) {
    test(`书库与阅读页简洁全屏 ${dark ? '深色' : '浅色'}`, async ({ browser }) => {
      const context = await browser.newContext(iphone)
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await setupApp(page, { kind: 'mixed', extraFiles: [novel], dark, viewport: iphone.viewport })
        const suffix = dark ? 'dark' : 'light'
        // 书库界面在手机上也进入沉浸，不再显示宿主顶栏。
        await expect.poll(() => page.evaluate(() => window.standaloneImmersion.active)).toBe(true)
        await page.screenshot({ path: join(shotDir, `reader-home-${suffix}.png`) })
        await page.locator('#tab-library').click()
        await page.screenshot({ path: join(shotDir, `reader-library-${suffix}.png`) })
        await enterShelf(page)
        await page.screenshot({ path: join(shotDir, `reader-shelf-${suffix}.png`) })
        await page.locator('#tab-me').click()
        await expect(page.locator('#btn-me-close')).toBeVisible()
        await page.screenshot({ path: join(shotDir, `reader-me-${suffix}.png`) })
        await openNovel(page)
        // 打开正文后工具栏默认隐藏，只留常驻章节与进度。
        await expect(page.locator('#app')).toHaveAttribute('data-controls', 'hidden')
        await expect(page.locator('#meta-chapter')).toBeVisible()
        await expect(page.locator('#meta-progress')).toContainText('第 1/6 章')
        await page.screenshot({ path: join(shotDir, `reader-page-${suffix}.png`) })
        await tapCenter(page)
        await expect(page.locator('#app')).toHaveAttribute('data-controls', 'visible')
        for (const id of ['toc-toggle', 'appearance-toggle', 'preferences-toggle', 'paging-toggle', 'bookmark-quick', 'back', 'progress']) await expect(page.locator(`#${id}`)).toBeVisible()
        await expect(page.locator('#previous')).toBeHidden()
        await expect(page.locator('#sync')).toHaveCSS('position', 'absolute')
        await page.screenshot({ path: join(shotDir, `reader-controls-${suffix}.png`) })
        await page.locator('#preferences-toggle').click()
        await expect(page.locator('#pref-advanced')).toBeHidden()
        await page.screenshot({ path: join(shotDir, `reader-typography-${suffix}.png`) })
        await page.locator('#preferences [data-font-step="1"]').click()
        await expect(page.locator('#font-size-value')).toHaveText('19')
        await page.locator('#pref-advanced-toggle').click()
        await expect(page.locator('#font-size')).toBeVisible()
        await page.locator('#preferences [data-close-panel]').click()
        await page.locator('#appearance-toggle').click()
        await page.screenshot({ path: join(shotDir, `reader-theme-${suffix}.png`) })
        await page.locator('#appearance [data-close-panel]').click()
        await page.locator('#paging-toggle').click()
        await expect(page.locator('#paging [data-proxy="mode"] [data-value="page"]')).toHaveAttribute('aria-pressed', 'true')
        await page.screenshot({ path: join(shotDir, `reader-paging-${suffix}.png`) })
        expect(errors).toEqual([])
      } finally { await context.close() }
    })
  }

  test('跟手翻页、边缘让给系统、书签开关与进度条跳章', async ({ browser }) => {
    const context = await browser.newContext(iphone)
    const page = await context.newPage()
    try {
      await setupApp(page, { kind: 'mixed', extraFiles: [novel], viewport: iphone.viewport })
      await openNovel(page)
      const box = (await page.locator('#viewport').boundingBox())!, y = box.y + box.height / 2
      const pageIndex = () => page.locator('#position').getAttribute('data-page')
      expect(await pageIndex()).toBe('0')
      // 拖动过程中正文跟随手指移动。
      await page.mouse.move(box.x + 300, y); await page.mouse.down()
      await page.mouse.move(box.x + 250, y, { steps: 3 }); await page.mouse.move(box.x + 150, y, { steps: 4 })
      await expect(page.locator('.flow-content')).toHaveAttribute('style', /translate3d\(-1\d\dpx/)
      await page.mouse.up()
      await expect.poll(pageIndex).toBe('1')
      await expect(page.locator('.flow-content')).not.toHaveAttribute('style', /translate3d/)
      // 慢速拖动距离不足时回弹不翻页（快速轻扫 24px 以上会按甩动翻页）。
      await page.mouse.move(box.x + 300, y); await page.mouse.down()
      for (let step = 1; step <= 6; step++) { await page.mouse.move(box.x + 300 - step * 5, y); await page.waitForTimeout(40) }
      await page.mouse.up()
      await page.waitForTimeout(400)
      expect(await pageIndex()).toBe('1')
      // 左边缘起手的横滑留给系统返回手势。
      await page.mouse.move(box.x + 8, y); await page.mouse.down(); await page.mouse.move(box.x + 200, y, { steps: 6 }); await page.mouse.up()
      await page.waitForTimeout(400)
      expect(await pageIndex()).toBe('1')
      // 桌面鼠标拖动会选中文字（触屏横滑不会），先清掉，避免点按被当作选字。
      await page.evaluate(() => getSelection()?.removeAllRanges())
      // 点按左右 30% 区域翻页。
      await page.mouse.click(box.x + box.width * .2, y)
      await expect.poll(pageIndex).toBe('0')
      await tapCenter(page)
      await page.locator('#bookmark-quick').click()
      await expect(page.locator('#bookmark-quick')).toHaveAttribute('aria-pressed', 'true')
      await page.locator('#bookmark-quick').click()
      await expect(page.locator('#bookmark-quick')).toHaveAttribute('aria-pressed', 'false')
      await page.locator('#chapter-next').click()
      await expect(page.locator('#position')).toHaveAttribute('data-section', '1')
      await page.locator('#progress').fill('4')
      await expect(page.locator('#position')).toHaveAttribute('data-section', '3')
    } finally { await context.close() }
  })

  test('长条漫自动连续滚动，普通漫画保持单页', async ({ browser }) => {
    const context = await browser.newContext(iphone)
    const page = await context.newPage()
    try {
      await setupApp(page, { kind: 'mixed', viewport: iphone.viewport })
      await page.locator('#tab-library').click()
      await enterShelf(page)
      await page.locator('.library-card[data-file-id="202"]').click()
      await expect(page.locator('#viewport')).toHaveAttribute('data-format', 'comic')
      await expect(page.locator('#comic-mode')).toHaveValue('scroll')
      await page.screenshot({ path: join(shotDir, 'reader-strip.png') })
      await tapCenter(page)
      await page.locator('#back').click()
      await page.locator('.library-card[data-file-id="201"]').click()
      await expect(page.locator('#viewport')).toHaveAttribute('data-format', 'comic')
      await page.waitForTimeout(500)
      await expect(page.locator('#comic-mode')).toHaveValue('single')
      await page.screenshot({ path: join(shotDir, 'reader-comic.png') })
    } finally { await context.close() }
  })
})
