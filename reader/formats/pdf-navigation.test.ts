import { afterEach, describe, expect, it, vi } from 'vitest'
import { PdfReader } from './pdf'
import * as documents from '../library/pdf-document'
import { defaults } from '../state'
import { basicPdf } from '../../tests/fixtures/reader-files.mjs'
import { deferred, file, memoryHost } from '../library/test-fixtures'

const readers: PdfReader[] = []
afterEach(() => { readers.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren() })
async function fixture(bytes: Uint8Array = basicPdf()) {
  const mock = await memoryHost(), entry = await mock.binary(file(2, '/真实合成.pdf'), bytes), viewport = document.createElement('main'), controller = new AbortController()
  document.body.append(viewport)
  const changed = vi.fn(), reader = new PdfReader({ host: mock.host, file: entry, viewport, signal: controller.signal, prefs: { ...defaults }, changed, error: vi.fn() })
  readers.push(reader)
  return { reader, mock, viewport, controller, changed }
}
describe('PDF 独立目录使用实际 legacy 解析', () => {
  it('真实 PDF 目录重复读取不解析正文页面，不创建画布或记录进度，并释放文档', async () => {
    const original = documents.openPdfDocument, handles: documents.PdfDocumentHandle[] = []
    const opened = vi.spyOn(documents, 'openPdfDocument').mockImplementation(async (...args) => {
      const handle = await original(...args); handles.push(handle)
      vi.spyOn(handle.document, 'getPage'); vi.spyOn(handle.document, 'getOutline'); vi.spyOn(handle.document, 'getMetadata')
      return handle
    })
    const { reader, mock, viewport, changed } = await fixture(), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止外网'))
    const first = await reader.loadNavigation()
    expect(first).toEqual([{ label: '第 1 页', depth: 0, location: { format: 'pdf', index: 0 } }])
    expect(await reader.loadNavigation()).toEqual(first)
    expect(opened).toHaveBeenCalledOnce(); expect(handles[0]!.document.getPage).not.toHaveBeenCalled()
    expect(handles[0]!.document.getOutline).toHaveBeenCalledOnce(); expect(handles[0]!.document.getMetadata).toHaveBeenCalledOnce()
    expect(viewport.childNodes).toHaveLength(0); expect(changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(mock.readRange.mock.calls.every(([, rangeWindow]) => {  const length = Number(rangeWindow.length); return length <= 1024 * 1024 })).toBe(true)
    reader.destroy(); expect(handles[0]!.source.signal.aborted).toBe(true)
  })
  it('真实损坏 PDF 与慢 Range 取消不留下正文或迟到进度', async () => {
    const broken = await fixture(new TextEncoder().encode('坏 PDF'))
    await expect(broken.reader.loadNavigation()).rejects.toThrow()
    expect(broken.viewport.childNodes).toHaveLength(0); expect(broken.changed).not.toHaveBeenCalled()
    const { reader, mock, controller, viewport, changed } = await fixture(), started = deferred()
    mock.readRange.mockImplementationOnce(async (_ref, rangeWindow, options) => { const _offset = Number(rangeWindow.offset), _length = Number(rangeWindow.length);
      started.resolve()
      return new Promise<never>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }))
    })
    const pending = reader.loadNavigation(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise; controller.abort(); viewport.textContent = '新详情'; await rejected
    expect(mock.readRange.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    expect(viewport.textContent).toBe('新详情'); expect(changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
  })
})
