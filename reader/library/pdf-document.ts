/** 独立 PDF 文档适配器；不创建阅读视图，也不读写任何阅读进度。 */
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import type { Drive, FileEntry } from '../../sdk/types'
import { LIMITS, MiB, RangeFile, gate } from '../io'
import { LibraryError } from './model'

export interface PdfDocumentHandle { document: PDFDocumentProxy; source: RangeFile; destroy(): Promise<void> }
export async function openPdfDocument(drive: Drive, file: FileEntry, signal: AbortSignal): Promise<PdfDocumentHandle> {
  signal.throwIfAborted()
  // legacy 入口自带 Promise.try 等兼容实现，固定 Node 22 和较旧手机均使用同一文档协议。
  const [{ getDocument, PDFDataRangeTransport }, { WorkerMessageHandler }] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')])
  signal.throwIfAborted()
  ;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler }
  const source = new RangeFile(drive, file, signal, LIMITS.pdf)
  let task: PDFDocumentLoadingTask | undefined, failure: (error: unknown) => void = () => {}, stopped: Promise<void> | undefined
  const failed = new Promise<never>((_resolve, reject) => { failure = reject })
  // 在 getDocument 同步抛错时也不会留下未处理的拒绝。
  void failed.catch(() => {})
  const destroy = () => {
    source.destroy(); signal.removeEventListener('abort', abort)
    return stopped ??= task?.destroy().catch(() => {}) ?? Promise.resolve()
  }
  const abort = () => { failure(signal.reason); void destroy() }
  class Transport extends PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      void source.read(begin, end - begin).then(bytes => { if (!source.signal.aborted) this.onDataRange(begin, bytes) }).catch(error => { failure(error); void destroy() })
    }
    abort() { source.destroy() }
  }
  class Resources {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
      if (!directory || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) throw new LibraryError('pdf_resource', 'PDF 请求了不允许的资源')
      return gate.run(source.signal, () => drive.assets.read(`${directory}/${filename}`, { signal: source.signal }))
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    task = getDocument({ range: new Transport(file.size, new Uint8Array(), true), rangeChunkSize: MiB,
      disableAutoFetch: true, disableStream: true, useWorkerFetch: false, useWasm: false,
      disableFontFace: true, useSystemFonts: false, enableXfa: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: LIMITS.pixels,
      canvasMaxAreaInBytes: 32 * MiB, BinaryDataFactory: Resources, stopAtErrors: true,
    })
    const document = await Promise.race([task.promise, failed])
    signal.throwIfAborted()
    if (document.numPages > 10000 || document.numPages < 1) throw new LibraryError('pdf_pages', 'PDF 页数无效或超过 10000 页')
    return { document, source, destroy }
  } catch (error) {
    await destroy()
    if ((error as Error).name === 'PasswordException') throw new LibraryError('pdf_password', '不支持密码保护的 PDF')
    throw error
  }
}
