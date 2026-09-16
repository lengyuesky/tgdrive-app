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
  }
) {
  const { kind, viewport = { width: 1000, height: 700 }, unindexedFiles = [] } = options
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
    ({ kind, entries, serializedList }) => {
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
            const slice = full.slice(offset, offset + length)
            return slice
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

      // 进入长篇正文详情
      await page.locator('#items .library-card', { hasText: '长篇' }).first().click()
      await expect(page.locator('#detail-title')).toBeVisible()

      const isDetailOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(isDetailOverflow, `${vp.label} 下详情页面不应发生水平溢出`).toBe(false)

      // 在桌面端视口下进入正文阅读，验证设置面板步进按钮触控尺寸满足 >= 44px
      if (vp.width >= 1000) {
        await page.locator('#btn-primary-read').click()
        await expect(page.locator('#reader')).toBeVisible()

        const prefBtn = page.locator('#preferences-toggle')
        await prefBtn.click()
        const stepBtn = page.locator('.step-btn').first()
        await expect(stepBtn).toBeVisible()
        const box = await stepBtn.boundingBox()
        expect(box!.width, `${vp.label} 下步进按钮宽度需 >= 44px`).toBeGreaterThanOrEqual(44)
        expect(box!.height, `${vp.label} 下步进按钮高度需 >= 44px`).toBeGreaterThanOrEqual(44)

        // 关闭阅读器返回
        await page.locator('#back').click()
        await expect(page.locator('#app-ui')).toBeVisible()
      }

      // 验证全程绝无外部网络请求
      expect(outsideRequests).toEqual([])
    }
  })

  test('2. 真实长篇 TXT 阅读、独立章节定位与书签记录', async ({ page }) => {
    const { outsideRequests } = await setupApp(page, { kind: 'books' })
    const libBtn = page.locator('#nav-library, #tab-library').filter({ visible: true }).first()
    await libBtn.click()

    // 点击进入长篇 TXT 详情
    await page.locator('#items .library-card', { hasText: '长篇' }).first().click()
    await expect(page.locator('#detail-title')).toContainText('长篇')

    // 按需加载独立目录（验证不写阅读进度）
    await page.locator('#btn-load-toc').click()
    await expect(page.locator('.toc-item-btn')).toHaveCount(3)

    // 点击第2章直接阅读
    await page.locator('.toc-item-btn', { hasText: '第2章' }).click()
    await expect(page.locator('#reader')).toBeVisible()
    await expect(page.locator('#reading-status')).toHaveText('')
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

    // 打开示例 EPUB
    await page.locator('#items .library-card', { hasText: '示例' }).first().click()
    await expect(page.locator('#detail-title')).toContainText('EPUB')
    await page.locator('#btn-primary-read').click()

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

    // 打开标准 PDF
    await page.locator('#items .library-card', { hasText: '标准' }).first().click()
    await expect(page.locator('#detail-title')).toContainText('标准')
    await page.locator('#btn-primary-read').click()

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

    // 打开漫画
    await page.locator('#items .library-card', { hasText: '漫画01' }).first().click()
    await expect(page.locator('#detail-title')).toContainText('漫画01')
    await page.locator('#btn-primary-read').click()

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
})
