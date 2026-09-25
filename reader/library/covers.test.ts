import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoverService, ViewportCoverLoader, validThumbnailRecord } from './covers'
import { downscaleCover } from './cover-image'
import { openPdfDocument, type PdfDocumentHandle } from './pdf-document'
import { LibraryAccess } from './sources'
import { deferred, file, memoryDrive, signal, sources, unit } from './test-fixtures'
import { epub, png, zip } from '../../tests/browser/readers-fixtures.mjs'

vi.mock('./pdf-document', () => ({ openPdfDocument: vi.fn() }))
const thumbnail = `data:image/png;base64,${png(12, 20, [30, 60, 90]).toString('base64')}`
let delayDecode = false
let images: { onload: (() => void) | null; onerror: (() => void) | null }[] = []
let revoke: ReturnType<typeof vi.fn>
beforeEach(() => {
  images = []; delayDecode = false; revoke = vi.fn()
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn(() => `blob:cover-${images.length}`); static revokeObjectURL = revoke })
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 12
    naturalHeight = 20
    removeAttribute = vi.fn()
    set src(_value: string) { images.push(this); if (!delayDecode) queueMicrotask(() => this.onload?.()) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(thumbnail)
})
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })
function setup(files: ReturnType<typeof file>[]) {
  const root = file(1, '/书', true), mock = memoryDrive([root, ...files]), access = new LibraryAccess(mock.drive)
  access.setSources(sources(root))
  return { ...mock, root, access, service: new CoverService(mock.drive, access, undefined, openPdfDocument) }
}
describe('按需图书与漫画封面适配', () => {
  it('同名图片优先，独立作品可用 cover，混放根目录通用 cover 不套全部', async () => {
    const book = file(2, '/书/正文.txt'), other = file(3, '/书/另一部.txt'), cover = file(4, '/书/cover.png'), same = file(5, '/书/正文.png')
    const mock = setup([book, other]); mock.binary(cover, png(12, 20, [1, 2, 3]))
    const mixed = await mock.service.get(unit(book), signal())
    expect(mixed).toMatchObject({ url: null, origin: 'placeholder' }); expect(mock.readRange).not.toHaveBeenCalled()
    mock.binary(same, png(12, 20, [3, 4, 5]))
    expect(await mock.service.get(unit(book), signal())).toMatchObject({ url: thumbnail, origin: 'same-name' })
    expect(mock.readRange.mock.calls.at(-1)?.[0].id).toBe(same.id)
    const isolated = setup([book]); isolated.binary(cover, png(12, 20, [1, 2, 3]))
    expect((await isolated.service.get(unit(book), signal())).origin).toBe('directory')
    expect(mock.drive.media.url).not.toHaveBeenCalled(); mock.service.destroy(); isolated.service.destroy()
  })
  it('独立目录变成混放目录后，不复用旧通用封面；缓存目标更新或移出范围也失效', async () => {
    const book = file(2, '/书/正文.txt'), mock = setup([book]), cover = mock.binary(file(4, '/书/cover.png'), png(12, 20, [1, 2, 3]))
    expect((await mock.service.get(unit(book), signal())).origin).toBe('directory')
    mock.nodes.set(3, file(3, '/书/另一部.txt')); mock.nodes.set(1, { ...mock.root, content_version: 'v2' })
    expect((await mock.service.get(unit(book), signal())).origin).toBe('placeholder')
    mock.nodes.delete(3); mock.nodes.set(1, { ...mock.root, content_version: 'v3' })
    const same = mock.binary(file(5, '/书/正文.png'), png(12, 20, [2, 3, 4]))
    expect((await mock.service.get(unit(book), signal())).origin).toBe('same-name')
    mock.nodes.set(same.id, { ...same, path: '/范围外/正文.png' }); mock.nodes.delete(cover.id)
    expect((await mock.service.get(unit(book), signal())).url).toBeNull()
    mock.service.destroy()
  })
  it('即使目录在缓存异步命中期间变成混放，也不发布旧通用封面', async () => {
    const book = file(2, '/书/正文.txt'), mock = setup([book])
    mock.binary(file(4, '/书/cover.png'), png(12, 20, [1, 2, 3]))
    expect((await mock.service.get(unit(book), signal())).origin).toBe('directory')
    const gate = deferred(), started = deferred(), get = mock.service.cache.get.bind(mock.service.cache)
    vi.spyOn(mock.service.cache, 'get').mockImplementationOnce(async (...args) => { const value = await get(...args); started.resolve(); await gate.promise; return value })
    const pending = mock.service.get(unit(book), signal()), rejected = expect(pending).rejects.toMatchObject({ code: 'file_changed' })
    await started.promise
    mock.nodes.set(3, file(3, '/书/另一部.txt')); mock.nodes.set(1, { ...mock.root, content_version: 'v2' }); gate.resolve()
    await rejected; mock.service.destroy()
  })
  it('EPUB 内嵌或首图、漫画归档封面和目录直属图复用安全 Archive/像素检查', async () => {
    const mock = setup([])
    const book = mock.binary(file(2, '/书/正文.epub'), epub(3))
    expect((await mock.service.get(unit(book), signal())).origin).toBe('first-image')
    const comic = mock.binary(file(3, '/书/漫画.cbz'), zip([['2.png', png(12, 20, [1, 2, 3])], ['cover.png', png(12, 20, [4, 5, 6])]]))
    expect(await mock.service.get(unit(comic), signal())).toMatchObject({ url: thumbnail, origin: 'first-image' })
    const folder = file(4, '/书/目录', true); mock.nodes.set(4, folder)
    mock.binary(file(5, '/书/目录/01.png'), png(12, 20, [10, 20, 30]))
    expect((await mock.service.get(unit(folder), signal())).origin).toBe('first-image')
    expect(mock.readRange.mock.calls.every(([, , length]) => length <= 1024 * 1024)).toBe(true)
    expect(revoke).toHaveBeenCalledTimes(images.length)
    await vi.waitFor(() => expect(mock.coverPut).toHaveBeenCalledTimes(3))
    expect(mock.coverPut.mock.calls.map(([key]) => key)).toEqual(['unit:2', 'unit:3', 'unit:4'])
    expect(mock.set).not.toHaveBeenCalled()
    mock.service.destroy()
  })
  it('损坏图片、像素炸弹和不安全封面缓存保留文字占位，不调用图片解码或网络', async () => {
    const mock = setup([file(2, '/书/正文.txt')]), huge = png(12, 20, [1, 2, 3]); huge.writeUInt32BE(100000, 16)
    mock.binary(file(3, '/书/正文.png'), huge)
    const result = await mock.service.get(unit(mock.nodes.get(2)!), signal())
    expect(result.url).toBeNull(); expect(result.warnings[0]).toContain('像素'); expect(images).toHaveLength(0)
    expect(validThumbnailRecord({ url: 'https://bad.invalid/x', origin: 'embedded' })).toBe(false)
    expect(validThumbnailRecord({ url: 'data:image/svg+xml;base64,PHN2Zz4=', origin: 'embedded' })).toBe(false)
    expect(validThumbnailRecord({ url: `data:image/png;base64,${huge.toString('base64')}`, origin: 'embedded' })).toBe(false)
    mock.service.destroy()
  })
  it('每个封面生命周期独立；离开范围/版本变化即使命中缓存也不读取旧资源', async () => {
    const mock = setup([file(2, '/书/正文.txt')]), same = mock.binary(file(3, '/书/正文.png'), png(12, 20, [1, 2, 3]))
    const first = await mock.service.get(unit(mock.nodes.get(2)!), signal()), calls = mock.readRange.mock.calls.length
    first.release(); first.release()
    const second = await mock.service.get(unit(mock.nodes.get(2)!), signal())
    expect(second.url).toBe(thumbnail); expect(mock.readRange).toHaveBeenCalledTimes(calls)
    mock.nodes.set(2, { ...mock.nodes.get(2)!, content_version: 'v2' })
    await expect(mock.service.get(unit(file(2, '/书/正文.txt')), signal())).rejects.toMatchObject({ code: 'file_changed' })
    mock.access.setSources({ revision: 'none', config: { schemaVersion: 1, sources: [] } })
    await expect(mock.service.get(unit(same), signal())).rejects.toMatchObject({ code: 'no_sources' })
    second.release(); mock.service.destroy()
  })
  it('封面最多两并发，排队取消不解码；解码取消释放临时 URL', async () => {
    const books = [2, 3, 4].map(id => file(id, `/书/正文${id}.txt`)), mock = setup(books)
    books.forEach(book => mock.binary(file(book.id + 10, book.path.replace('.txt', '.png')), png(12, 20, [1, 2, 3])))
    delayDecode = true
    const controller = new AbortController(), one = mock.service.get(unit(books[0]!), signal()), two = mock.service.get(unit(books[1]!), signal()), three = mock.service.get(unit(books[2]!), controller.signal).catch(error => error.name)
    await vi.waitFor(() => expect(images).toHaveLength(2))
    controller.abort(); expect(await three).toBe('AbortError')
    images.forEach(image => image.onload?.()); await Promise.all([one, two]); expect(images).toHaveLength(2)
    const stop = new AbortController(), decoding = downscaleCover(new Blob(['测试解码取消']), 320, stop.signal)
    const rejected = expect(decoding).rejects.toMatchObject({ name: 'AbortError' }); stop.abort(); await rejected
    expect(revoke).toHaveBeenCalledTimes(3)
    mock.service.destroy()
  })
  it('PDF 预览最多一并发，只渲染第一页并释放画布/文档，不修改页位置或进度', async () => {
    const books = [2, 3, 4].map(id => file(id, `/书/文档${id}.pdf`)), mock = setup(books), renders: ReturnType<typeof deferred<void>>[] = [], pages: number[] = []
    let active = 0, peak = 0, destroyed = 0
    vi.mocked(openPdfDocument).mockImplementation(async () => {
      active++; peak = Math.max(peak, active)
      return { document: { getPage: vi.fn(async (index: number) => { pages.push(index); const done = deferred(); renders.push(done); return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }), render: () => ({ promise: done.promise, cancel: vi.fn() }), cleanup: vi.fn(),
      } }) }, destroy: async () => { active--; destroyed++ } } as unknown as PdfDocumentHandle
    })
    const jobs = books.map(book => mock.service.get(unit(book), signal()))
    for (let index = 0; index < 3; index++) { await vi.waitFor(() => expect(renders).toHaveLength(index + 1)); renders[index]!.resolve() }
    const covers = await Promise.all(jobs)
    expect(covers.every(cover => cover.origin === 'pdf' && cover.url === thumbnail)).toBe(true)
    expect(peak).toBe(1); expect(pages).toEqual([1, 1, 1]); expect(destroyed).toBe(3)
    await vi.waitFor(() => expect(mock.coverRecords.size).toBe(3))
    expect([...mock.coverRecords.values()].every(record => record.key.startsWith('unit:') && (record.meta as { origin: string }).origin === 'pdf')).toBe(true)
    mock.service.destroy()
  })
})

describe('封面库跨会话复用', () => {
  it('新会话命中服务器封面库，不再读取归档或原图', async () => {
    const mock = setup([]), comic = mock.binary(file(3, '/书/漫画.cbz'), zip([['1.png', png(12, 20, [1, 2, 3])]]))
    expect((await mock.service.get(unit(comic), signal())).origin).toBe('first-image')
    await vi.waitFor(() => expect(mock.coverPut).toHaveBeenCalledTimes(1))
    mock.service.destroy()
    const reads = mock.readRange.mock.calls.length, next = new CoverService(mock.drive, mock.access)
    expect(await next.get(unit(comic), signal())).toMatchObject({ url: thumbnail, origin: 'first-image' })
    expect(mock.readRange).toHaveBeenCalledTimes(reads)
    expect(mock.coverGet).toHaveBeenCalledWith(['unit:3'], expect.anything())
    next.destroy()
  })
  it('作品内容变化后封面库记录不再匹配，重新生成并原地覆盖', async () => {
    const mock = setup([]), comic = mock.binary(file(3, '/书/漫画.cbz'), zip([['1.png', png(12, 20, [1, 2, 3])]]))
    await mock.service.get(unit(comic), signal()); mock.service.destroy()
    await vi.waitFor(() => expect(mock.coverRecords.size).toBe(1))
    const before = structuredClone(mock.coverRecords.get('unit:3')!)
    const changed = mock.binary({ ...comic, content_version: 'v2' }, zip([['2.png', png(12, 20, [4, 5, 6])]]))
    const reads = mock.readRange.mock.calls.length, next = new CoverService(mock.drive, mock.access)
    expect((await next.get(unit(changed), signal())).origin).toBe('first-image')
    expect(mock.readRange.mock.calls.length).toBeGreaterThan(reads)
    await vi.waitFor(() => expect(mock.coverPut).toHaveBeenCalledTimes(2))
    expect(mock.coverRecords.size).toBe(1)
    expect(mock.coverRecords.get('unit:3')!.meta).not.toEqual(before.meta)
    next.destroy()
  })
  it('旧宿主没有封面库时只在本次会话内存缓存，不调用封面能力', async () => {
    const root = file(1, '/书', true), mock = memoryDrive([root], {}, { covers: false }), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    const comic = mock.binary(file(3, '/书/漫画.cbz'), zip([['1.png', png(12, 20, [1, 2, 3])]])), service = new CoverService(mock.drive, access)
    expect((await service.get(unit(comic), signal())).url).toBe(thumbnail)
    const reads = mock.readRange.mock.calls.length
    expect((await service.get(unit(comic), signal())).url).toBe(thumbnail)
    expect(mock.readRange).toHaveBeenCalledTimes(reads)
    expect(mock.coverGet).not.toHaveBeenCalled(); expect(mock.coverPut).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    service.destroy()
  })
})

describe('ViewportCoverLoader 可见性与释放', () => {
  it('没有进入视口不取封面，快速移出再进入会补发，销毁不发布旧结果', async () => {
    let intersect!: (entries: { target: HTMLElement; isIntersecting: boolean }[]) => void
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof intersect) { intersect = callback } observe() {} disconnect() {} })
    const release = vi.fn(), requests: { done: ReturnType<typeof deferred<{ url: string; origin: 'embedded'; warnings: string[]; release: typeof release }>>; signal: AbortSignal }[] = []
    const service = { get: vi.fn(async (_unit, signal: AbortSignal) => { const done = deferred<{ url: string; origin: 'embedded'; warnings: string[]; release: typeof release }>(); requests.push({ done, signal }); return done.promise }) } as unknown as CoverService
    const loader = new ViewportCoverLoader(service, signal()), target = document.createElement('div'); document.body.append(target)
    loader.observe(target, unit(file(2, '/书/一.epub')))
    expect(service.get).not.toHaveBeenCalled()
    intersect([{ target, isIntersecting: true }]); expect(requests).toHaveLength(1)
    intersect([{ target, isIntersecting: false }]); intersect([{ target, isIntersecting: true }])
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[0]!.done.resolve({ url: thumbnail, origin: 'embedded', warnings: [], release })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(release).toHaveBeenCalledTimes(1); expect(target.classList.contains('has-cover')).toBe(false)
    loader.destroy(); requests[1]!.done.resolve({ url: thumbnail, origin: 'embedded', warnings: [], release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(target.style.backgroundImage).toBe('')
  })
})
