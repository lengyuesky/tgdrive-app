import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { PdfReader } from './pdf'
import { openPdfDocument, type PdfDocumentHandle } from '../reader/library/pdf-document'
import { defaults, preferences, type Preferences } from '../reader/state'
import { MiB } from '../reader/io'
import { deferred, file, memoryDrive } from '../reader/library/test-fixtures'
import type { ViewContext } from '../reader/view'

// 实际 legacy 解析另由 pdf-navigation.test 覆盖；此处控制 PDF.js 页任务，断言真实视图的竞争和画布释放。
vi.mock('../reader/library/pdf-document', () => ({ openPdfDocument: vi.fn() }))
const readers: PdfReader[] = []
const opened = vi.mocked(openPdfDocument)
const canvases: HTMLCanvasElement[] = []
let sequence = 0
const created = vi.fn(() => `blob:pdf-${++sequence}`), released = vi.fn()
beforeEach(() => {
  canvases.length = 0; sequence = 0; created.mockClear(); released.mockClear(); opened.mockReset()
  vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: released })
  vi.stubGlobal('devicePixelRatio', 2)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { canvases.push(this); return {} as CanvasRenderingContext2D })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['预览'], { type: 'image/png' })))
})
afterEach(() => { readers.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren(); vi.unstubAllGlobals() })
function documentHandle(natural = { width: 600, height: 900 }) {
  const controller = new AbortController(), waits = new Map<number, ReturnType<typeof deferred<void>>>(), failures = new Set<number>(), cleanups: ReturnType<typeof vi.fn>[] = []
  const rendering = vi.fn((number: number, options: Parameters<PDFPageProxy['render']>[0]) => {
    const wait = waits.get(number)
    const promise = failures.has(number) ? Promise.reject(new Error('页面渲染失败')) : wait?.promise ?? Promise.resolve()
    const cancel = vi.fn(() => wait?.reject(Object.assign(new Error('已取消页面渲染'), { name: 'RenderingCancelledException' })))
    return { promise, cancel, options } as unknown as RenderTask
  })
  const getPage = vi.fn(async (number: number) => {
    const cleanup = vi.fn(); cleanups.push(cleanup)
    return { getViewport: ({ scale }: { scale: number }) => ({ width: natural.width * scale, height: natural.height * scale }), cleanup,
      render: (options: Parameters<PDFPageProxy['render']>[0]) => rendering(number, options) } as unknown as PDFPageProxy
  })
  const getOutline = vi.fn(async () => [
    { title: '卷一', dest: [0], items: [{ title: '章一', dest: [1], items: [] }] },
    { title: '无效外链', dest: null, items: [] },
  ])
  const document = { numPages: 3, getMetadata: vi.fn(async () => ({ info: { Title: '合成 PDF' } })), getOutline, getPage,
    getDestination: vi.fn(async () => [0]), getPageIndex: vi.fn(async () => 0) } as unknown as PDFDocumentProxy
  const destroy = vi.fn(async () => { controller.abort() })
  const handle = { document, source: { signal: controller.signal }, destroy } as unknown as PdfDocumentHandle
  return { handle, getPage, getOutline, rendering, destroy, cleanups, waits, failures, controller }
}
function fixture(prefs: Partial<Preferences> = {}, natural?: { width: number; height: number }) {
  const main = documentHandle(natural), mock = memoryDrive(), controller = new AbortController(), viewport = document.createElement('main')
  document.body.append(viewport); opened.mockResolvedValueOnce(main.handle)
  let width = 1000, height = 600, top = 0, left = 0
  const observers: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback) }; observe() {} disconnect() {} })
  const rect = (left: number, top: number, width: number, height: number) => ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  const canvas = () => viewport.querySelector('canvas')
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
    scrollHeight: { get: () => Math.max(height, parseFloat(canvas()?.style.height ?? '') || 0) },
    scrollWidth: { get: () => Math.max(width, parseFloat(canvas()?.style.width ?? '') || 0) },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, viewport.scrollHeight - height)) } },
    scrollLeft: { get: () => left, set: (value: number) => { left = Math.max(0, Math.min(value, viewport.scrollWidth - width)) } },
  })
  viewport.getBoundingClientRect = () => rect(0, 0, width, height)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLCanvasElement) {
    const w = parseFloat(this.style.width) || 0, h = parseFloat(this.style.height) || 0
    return rect(Math.max(0, (width - w) / 2) - viewport.scrollLeft, -viewport.scrollTop, w, h)
  })
  const context: ViewContext = { drive: mock.drive, file: file(2, '/控制画布.pdf'), viewport, signal: controller.signal, prefs: { ...defaults, ...prefs }, changed: vi.fn(), error: vi.fn() }
  const reader = new PdfReader(context); readers.push(reader)
  return { reader, main, mock, viewport, context, controller, canvas, resize: (w: number, h: number) => { width = w; height = h; observers.forEach(notify => notify()) } }
}
describe('PDF 阅读视图', () => {
  it('层级目录解析可复用且不调用 getPage、render、changed', async () => {
    const { reader, main, viewport, context } = fixture()
    const first = await reader.loadNavigation()
    expect(first).toEqual([{ label: '卷一', depth: 0, location: { format: 'pdf', index: 0 } }, { label: '章一', depth: 1, location: { format: 'pdf', index: 1 } }])
    expect(await reader.loadNavigation()).toEqual(first); expect(main.getOutline).toHaveBeenCalledOnce()
    expect(main.getPage).not.toHaveBeenCalled(); expect(main.rendering).not.toHaveBeenCalled()
    expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled()
  })
  it('fitPage/fitWidth/zoom、原生平移和高度变化均保留物理页，末页顶部不提前完成', async () => {
    const { reader, canvas, context, viewport, resize } = fixture({ fit: 'page' })
    await reader.open({ format: 'pdf', index: 2 })
    expect(canvas()!.style.height).toBe('600px'); expect(canvas()!.style.width).toBe('400px')
    expect(reader.navigationState().atEnd).toBe(true)
    await reader.configure({ ...context.prefs, fit: 'width' })
    expect(canvas()!.style.height).toBe('1500px'); expect(canvas()!.style.width).toBe('1000px')
    expect(reader.navigationState()).toMatchObject({ canNext: false, atEnd: false })
    reader.pan(0, 900); expect(reader.navigationState().atEnd).toBe(true)
    await reader.configure({ ...context.prefs, zoom: 2 })
    expect(canvas()!.style.width).toBe('2000px'); expect(canvas()!.style.height).toBe('3000px')
    expect(viewport.scrollTop).toBe(2400)
    reader.pan(200, -1700); expect(viewport.scrollLeft).toBe(200); expect(viewport.scrollTop).toBe(700)
    await reader.configure({ ...context.prefs, fit: 'page', zoom: 1 })
    resize(1000, 300)
    await vi.waitFor(() => expect(canvas()!.style.height).toBe('300px'))
    expect(reader.current()).toEqual({ format: 'pdf', index: 2 })
    expect(reader.navigationState().atEnd).toBe(true)
  })
  it('失败的新页不覆盖已成功显示的位置和画布；旧渲染取消不能晚到回退页码', async () => {
    const { reader, main, canvas, context } = fixture()
    await reader.open({ format: 'pdf', index: 0 }); const original = canvas()
    main.failures.add(2)
    await expect(reader.go(1)).rejects.toThrow('页面渲染失败')
    expect(reader.current().index).toBe(0); expect(canvas()).toBe(original); expect(original!.width).toBeGreaterThan(0)
    expect(canvases.at(-1)!.width).toBe(0); expect(main.cleanups.every(cleanup => cleanup.mock.calls.length > 0)).toBe(true)
    await reader.configure({ ...context.prefs, fit: 'page' })
    expect(main.getPage).toHaveBeenLastCalledWith(1); expect(reader.current().index).toBe(0)
    main.failures.clear(); main.waits.set(2, deferred())
    const pending = reader.go(1)
    await vi.waitFor(() => expect(main.rendering.mock.calls.filter(([number]) => number === 2)).toHaveLength(2))
    await reader.go(2); await pending
    expect(reader.current().index).toBe(2)
  })
  it('旧平面 page 偏好没有 fit 时 PDF 仍按适宽，不把漫画的适页默认带入 PDF', async () => {
    const prefs = preferences({ ...defaults, mode: 'page' })
    expect(prefs.fit).toBeUndefined()
    const { reader, canvas } = fixture(prefs)
    await reader.open()
    expect(canvas()!.style.width).toBe('1000px'); expect(canvas()!.style.height).toBe('1500px')
  })
  it('极长页面与放大仍保持单画布 16 MiB、单边 16384 像素的预算', async () => {
    const { reader, main } = fixture({ fit: 'width', zoom: 3 }, { width: 300, height: 200000 })
    await reader.open()
    const canvas = main.rendering.mock.calls[0]![1].canvas!
    expect(canvas.width * canvas.height * 4).toBeLessThanOrEqual(16 * MiB)
    expect(canvas.width).toBeLessThanOrEqual(16384); expect(canvas.height).toBeLessThanOrEqual(16384)
    reader.destroy(); expect(canvas.width).toBe(0); expect(canvas.height).toBe(0)
  })
})
describe('PDF 独立缩略图', () => {
  it('另开文档的缩略图不改变正文页、DOM 或进度；结束清理画布、页面和文档', async () => {
    const { reader, main, viewport, context, mock } = fixture(), preview = documentHandle()
    opened.mockResolvedValueOnce(preview.handle)
    await reader.open({ format: 'pdf', index: 1 }); vi.mocked(context.changed).mockClear()
    const saved = reader.current(), element = viewport.firstChild
    const thumbnail = await reader.thumbnail(2, new AbortController().signal)
    expect(preview.getPage).toHaveBeenCalledExactlyOnceWith(3); expect(main.getPage).toHaveBeenCalledExactlyOnceWith(2)
    expect(thumbnail.width).toBeLessThanOrEqual(320); expect(thumbnail.height).toBeLessThanOrEqual(320)
    expect(reader.current()).toEqual(saved); expect(viewport.firstChild).toBe(element); expect(context.changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    expect(preview.destroy).toHaveBeenCalledOnce(); expect(preview.cleanups[0]).toHaveBeenCalledOnce()
    expect(canvases.at(-1)!.width).toBe(0); expect(canvases.at(-1)!.height).toBe(0)
    thumbnail.release(); thumbnail.release(); reader.destroy()
    expect(released).toHaveBeenCalledExactlyOnceWith(thumbnail.url)
  })
  it('全局单 PDF 预览，取消当前缩略图后才运行下一张，不取消正文', async () => {
    const { reader, main } = fixture(), first = documentHandle(), second = documentHandle(), controller = new AbortController()
    first.waits.set(3, deferred())
    opened.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle)
    await reader.open({ format: 'pdf', index: 1 })
    const pending = reader.thumbnail(2, controller.signal), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const next = reader.thumbnail(0, new AbortController().signal)
    await vi.waitFor(() => expect(first.rendering).toHaveBeenCalledOnce())
    expect(opened).toHaveBeenCalledTimes(2); expect(second.getPage).not.toHaveBeenCalled()
    controller.abort(); await rejected
    const result = await next
    expect(first.destroy).toHaveBeenCalledOnce(); expect(second.destroy).toHaveBeenCalledOnce()
    expect(reader.current().index).toBe(1); expect(main.destroy).not.toHaveBeenCalled()
    result.release()
  })
  it('切书取消正文和缩略图，迟到任务不能替换新页面，所有临时画布归零', async () => {
    const { reader, main, viewport, context } = fixture(), preview = documentHandle()
    opened.mockResolvedValueOnce(preview.handle)
    await reader.open(); vi.mocked(context.changed).mockClear()
    main.waits.set(2, deferred()); preview.waits.set(3, deferred())
    const turn = reader.go(1), thumbnail = reader.thumbnail(2, new AbortController().signal)
    const rejectedTurn = expect(turn).rejects.toMatchObject({ name: 'AbortError' }), rejectedThumbnail = expect(thumbnail).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(preview.rendering).toHaveBeenCalledOnce())
    reader.destroy(); viewport.textContent = '新书正文'
    await Promise.all([rejectedTurn, rejectedThumbnail])
    expect(viewport.textContent).toBe('新书正文'); expect(context.changed).not.toHaveBeenCalled()
    expect(main.destroy).toHaveBeenCalledOnce(); expect(preview.destroy).toHaveBeenCalledOnce()
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
})
