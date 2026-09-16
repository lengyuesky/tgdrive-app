import { describe, expect, it, vi } from 'vitest'
import { openPdfDocument } from './pdf-document'
import { MetadataService } from './metadata'
import { LibraryAccess } from './sources'
import { basicPdf } from '../../tests/browser/readers-fixtures.mjs'
import { deferred, file, memoryDrive, signal, sources, unit } from './test-fixtures'

const documentBytes = () => new TextEncoder().encode(basicPdf().toString().replace('/Root 1 0 R >>', '/Root 1 0 R /Info << /Title (Synthetic PDF) /Author (Library Test) /Subject (Document metadata) >> >>'))
describe('独立 PDF 文档适配器', () => {
  it('用实际 PDF.js 和合成 PDF 解析文档元数据，Range 有界，无网络/画布/阅读进度副作用', async () => {
    const mock = memoryDrive([file(1, '/书', true)]), pdf = mock.binary(file(2, '/书/文档.pdf'), documentBytes())
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止外网'))
    const handle = await openPdfDocument(mock.drive, pdf, signal()), page = vi.spyOn(handle.document, 'getPage')
    const metadata = await handle.document.getMetadata()
    expect(metadata.info).toMatchObject({ Title: 'Synthetic PDF', Author: 'Library Test', Subject: 'Document metadata' })
    expect(handle.document.numPages).toBe(1); expect(page).not.toHaveBeenCalled()
    expect(mock.readRange.mock.calls.every(([, , length]) => length <= 1024 * 1024)).toBe(true)
    expect(fetch).not.toHaveBeenCalled(); expect(mock.drive.media.url).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    await handle.destroy(); expect(handle.source.signal.aborted).toBe(true)
    const access = new LibraryAccess(mock.drive); access.setSources(sources(mock.nodes.get(1)!))
    const service = new MetadataService(mock.drive, access, undefined, openPdfDocument)
    const result = await service.get(unit(pdf), signal())
    expect(result).toMatchObject({ metadata: { title: 'Synthetic PDF', authors: ['Library Test'], description: 'Document metadata' }, warnings: [] })
    expect(mock.set.mock.calls.every(([key]) => key.startsWith('library:cache:metadata:'))).toBe(true)
    service.destroy()
  })
  it('真实解析遇坏 PDF 返回错误；慢 Range 取消会销毁文档任务而非继续预取', async () => {
    const mock = memoryDrive(), invalid = mock.binary(file(2, '/坏.pdf'), new TextEncoder().encode('不是 PDF'))
    await expect(openPdfDocument(mock.drive, invalid, signal())).rejects.toThrow()
    const pdf = mock.binary(file(3, '/慢.pdf'), documentBytes()), started = deferred(), controller = new AbortController()
    mock.readRange.mockImplementationOnce(async (_ref, _offset, _length, options) => {
      started.resolve()
      return new Promise<never>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('读取已取消', 'AbortError')), { once: true }))
    })
    const pending = openPdfDocument(mock.drive, pdf, controller.signal), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise; controller.abort(); await rejected
    expect(mock.readRange.mock.calls.at(-1)?.[3]?.signal?.aborted).toBe(true)
  })
})
