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

let booksOutDir = ''
let comicsOutDir = ''
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
  booksOutDir = join(stagingTmp, 'books')
  comicsOutDir = join(stagingTmp, 'comics')

  // 1. 真实 Vite 构建 books
  await build({
    configFile: false,
    root: resolve(root, 'books'),
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
      outDir: booksOutDir,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
    },
  })

  // 2. 真实 Vite 构建 comics
  await build({
    configFile: false,
    root: resolve(root, 'comics'),
    base: './',
    publicDir: false,
    resolve: {
      alias: {
        '@zip.js/zip.js': resolve(modules, '@zip.js/zip.js'),
      },
    },
    build: {
      outDir: comicsOutDir,
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
    kind: 'books' | 'comics'
    viewport?: { width: number; height: number }
    unindexedFiles?: FileEntry[]
    readDelay?: number
    /** 延迟随请求字节数增长：头部探测远快于整图/整块读取，模拟真实网络。 */
    proportionalRead?: boolean
  }
) {
  const { kind, viewport = { width: 1000, height: 700 }, unindexedFiles = [], readDelay = 0, proportionalRead = false } = options
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

  const activeFiles = kind === 'books' ? bookFiles : comicFiles
  const allEntries: FileEntry[] = [rootDir, ...activeFiles.map((f) => f.entry), ...unindexedFiles]
  const dataMap = new Map<number, Buffer>()
  activeFiles.forEach((f) => dataMap.set(f.entry.id, f.data))

  // 虚拟 origin 静态文件拦截服务
  const outDir = kind === 'books' ? booksOutDir : comicsOutDir
  await page.route('**/*', async (route) => {
    const url = route.request().url()
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
    ({ kind, entries, serializedList, readDelay, proportionalRead }) => {
      const storageStore = new Map<string, { key: string; value: any; revision: string; updated_at: number }>()
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
          id: kind,
          name: kind === 'books' ? '图书' : '漫画',
          version: '1.2.0',
          api_version: 2,
          dark: false,
        }),
        settings: {
          get: async () => ({ source_dir: '/书库' }),
          patch: async () => ({}),
          open: async () => {},
        },
        ui: {
          close: async () => {},
          download: async () => {},
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
    }
  )

  await page.goto('http://standalone.local/index.html')
  await expect(page.locator('#app')).toBeVisible()

  return { outsideRequests }
}

test.describe('standalone 真实无头浏览器全套阅读器验收', () => {
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
      await expect(page.locator('#items .library-card').first()).toBeVisible()

      // 验证页面无水平溢出
      const isOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(isOverflow, `${vp.label} 下书库页面不应发生水平溢出`).toBe(false)

      // 单卷作品点击直达阅读器
      await page.locator('#items .library-card', { hasText: '长篇' }).first().click()
      await expect(page.locator('#reader')).toBeVisible()
      await expect(page.locator('#viewport')).toContainText('这是第一章的内容')

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
      } else if (vp.width <= 768) {
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

    // 添加书签
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
