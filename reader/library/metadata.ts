/** 按需读取 ComicInfo、OPF 和 PDF 文档信息；扫描器不调用这些提取器。 */
import type { Drive, FileEntry } from '../../sdk/types'
import { Archive, archivePath, relativeResource } from '../archive'
import { LIMITS, RangeFile, isImage, isAbort } from '../io'
import { BudgetCache, CACHE_BUDGETS, metadataTasks } from './cache'
import { cleanMetadata, elementText, elements, metadataText, safeXml, validNumber } from './metadata-value'
import { LibraryError, errorMessage, type BibliographicMetadata, type ReadingUnit } from './model'
import type { LibraryAccess } from './sources'
import type { PdfDocumentHandle } from './pdf-document'

export type PdfOpener = (drive: Drive, file: FileEntry, signal: AbortSignal) => Promise<PdfDocumentHandle>

export interface MetadataResult { schemaVersion: 1; metadata: BibliographicMetadata; coverPath?: string; warnings: string[] }
const empty = (): MetadataResult => ({ schemaVersion: 1, metadata: {}, warnings: [] })
export function parseComicInfo(text: string): BibliographicMetadata {
  const doc = safeXml(text)
  if (doc.documentElement.localName !== 'ComicInfo') throw new LibraryError('invalid_comicinfo', 'ComicInfo 根节点无效')
  const child = (name: string) => elementText([...doc.documentElement.children].find(element => element.localName === name))
  const authors = ['Writer', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Translator'].flatMap(name => child(name)?.split(/[,，;；]/) ?? [])
  return cleanMetadata({ title: child('Title'), series: child('Series'), volume: validNumber(child('Volume')), number: validNumber(child('Number')),
    authors, description: child('Summary'), publisher: child('Publisher'), language: child('LanguageISO'), year: validNumber(child('Year'), 9999) })
}
export async function comicArchiveMetadata(archive: Archive, signal: AbortSignal): Promise<MetadataResult> {
  const paths = [...archive.entries].filter(([path, item]) => !item.directory && path.split('/').pop()?.toLowerCase() === 'comicinfo.xml').map(([path]) => path)
  const path = paths.find(path => !path.includes('/')) ?? (paths.length === 1 ? paths[0] : undefined)
  if (!path) return { ...empty(), warnings: paths.length ? ['多个 ComicInfo 无法确定归属，保留文件名'] : [] }
  return { ...empty(), metadata: parseComicInfo(await archive.text(path, signal)) }
}
export async function epubArchiveMetadata(archive: Archive, signal: AbortSignal): Promise<MetadataResult> {
  const container = safeXml(await archive.text('META-INF/container.xml', signal))
  const root = elements(container, 'rootfile').find(element => element.getAttribute('media-type') === 'application/oebps-package+xml') ?? elements(container, 'rootfile')[0]
  const rawPath = root?.getAttribute('full-path')
  if (!rawPath) throw new LibraryError('invalid_epub', 'EPUB 缺少 OPF 清单')
  const path = archivePath(decodeURIComponent(rawPath)), doc = safeXml(await archive.text(path, signal))
  if (doc.documentElement.localName !== 'package') throw new LibraryError('invalid_epub', 'EPUB OPF 根节点无效')
  if (archive.entries.has('META-INF/encryption.xml')) {
    const encryption = safeXml(await archive.text('META-INF/encryption.xml', signal))
    const inside = (uri: string) => { try { return archive.entries.has(archivePath(decodeURIComponent(uri))) } catch { return false } }
    for (const data of elements(encryption, 'EncryptedData')) {
      const algorithm = elements(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm'), references = elements(data, 'CipherReference').map(item => item.getAttribute('URI') ?? '')
      if (['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(algorithm ?? '') && /\.(ttf|otf|woff2?)$/i.test(references[0] ?? '')) { relativeResource('', references[0] ?? ''); continue }
      // 与 books/epub.ts 保持一致：声明加密但包内不存在所指条目时，是剥离重打包残留的无效标记，忽略即可。
      if (!references.some(uri => inside(uri))) continue
      throw new LibraryError('encrypted_epub', '不支持 DRM 或加密 EPUB 内容')
    }
  }
  const metadataRoot = [...doc.documentElement.children].find(element => element.localName === 'metadata')
  const values = (name: string) => metadataRoot ? [...metadataRoot.children].filter(element => element.localName === name && (!element.namespaceURI || element.namespaceURI === 'http://purl.org/dc/elements/1.1/')).map(element => elementText(element)) : []
  const metadata = cleanMetadata({ title: values('title')[0], authors: values('creator'), description: values('description')[0], language: values('language')[0], publisher: values('publisher')[0] })
  const manifest = [...doc.documentElement.children].find(element => element.localName === 'manifest')
  const items = manifest ? [...manifest.children].filter(item => item.localName === 'item') : []
  const coverId = metadataRoot && elements(metadataRoot, 'meta').find(item => item.getAttribute('name')?.toLowerCase() === 'cover')?.getAttribute('content')
  const covers = items.filter(item => (item.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image'))
  const legacy = coverId ? items.find(item => item.getAttribute('id') === coverId) : undefined
  if (!covers.length && legacy) covers.push(legacy)
  const selected = covers[0]
  let coverPath: string | undefined
  if (selected) {
    const ref = relativeResource(path, selected.getAttribute('href') ?? '')
    if (!isImage(ref.path) || !/^image\/(?:jpeg|png|gif|webp|avif|bmp)$/i.test(selected.getAttribute('media-type') ?? '')) throw new LibraryError('unsafe_cover', 'EPUB 封面不是受支持的包内位图')
    if (!archive.entries.has(ref.path)) throw new LibraryError('missing_cover', 'EPUB 封面资源不存在')
    coverPath = ref.path
  } else {
    const guide = elements(doc, 'reference').find(item => item.getAttribute('type') === 'cover')
    if (guide) {
      const ref = relativeResource(path, guide.getAttribute('href') ?? '')
      if (isImage(ref.path) && archive.entries.has(ref.path)) coverPath = ref.path
    }
  }
  return { schemaVersion: 1, metadata, coverPath, warnings: [] }
}
export function pdfMetadata(info: unknown, xmp?: string): BibliographicMetadata {
  const value = info && typeof info === 'object' ? info as Record<string, unknown> : {}
  let embedded: BibliographicMetadata = {}
  if (xmp) {
    const doc = safeXml(xmp)
    embedded = cleanMetadata({ title: elementText(elements(doc, 'title')[0]), authors: elements(doc, 'creator').flatMap(element => {
      const list = elements(element, 'li'); return list.length ? list.map(item => elementText(item)) : [elementText(element)]
    }), description: elementText(elements(doc, 'description')[0]) })
  }
  return cleanMetadata({ title: embedded.title ?? value.Title, authors: embedded.authors ?? (typeof value.Author === 'string' ? value.Author.split(/[,，;；]/) : undefined), description: embedded.description ?? value.Subject })
}
export function validMetadataResult(raw: unknown): raw is MetadataResult {
  const result = raw as MetadataResult | null
  return !!result && result.schemaVersion === 1 && !!result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
    && (result.coverPath === undefined || typeof result.coverPath === 'string' && (() => { try { return archivePath(result.coverPath) === result.coverPath } catch { return false } })())
    && Array.isArray(result.warnings) && result.warnings.length <= 16 && result.warnings.every(message => typeof message === 'string' && message.length <= 500)
}
export function metadataKey(file: FileEntry) { return JSON.stringify(['metadata', file.id, file.content_version, file.is_dir]) }

export class MetadataService {
  readonly cache: BudgetCache<MetadataResult>
  private controller = new AbortController()
  private paused = false
  constructor(private drive: Drive, private access: LibraryAccess, cache?: BudgetCache<MetadataResult>, private openPdf?: PdfOpener) {
    this.cache = cache ?? new BudgetCache(drive, 'metadata', CACHE_BUDGETS.metadata, validMetadataResult)
  }
  async get(unit: ReadingUnit, signal: AbortSignal): Promise<MetadataResult> {
    if (this.paused) throw new LibraryError('library_paused', '阅读馆后台任务已暂停')
    const current = AbortSignal.any([signal, this.controller.signal])
    return metadataTasks.run(current, async () => {
      const { file } = await this.access.file(unit.nodeId, current, unit.file.content_version)
      const cached = await this.cache.get(metadataKey(file), current)
      if (cached) { await this.access.file(file.id, current, file.content_version); return { ...cached, metadata: cleanMetadata(cached.metadata) } }
      let result = empty()
      try {
        if (unit.format === 'cbz' || unit.format === 'zip' || unit.format === 'epub') {
          const archive = new Archive(new RangeFile(this.drive, file, current, unit.format === 'epub' ? LIMITS.epub : LIMITS.archive))
          try { await archive.open(); result = unit.format === 'epub' ? await epubArchiveMetadata(archive, current) : await comicArchiveMetadata(archive, current) }
          finally { archive.destroy() }
        } else if (unit.format === 'pdf') {
          if (!this.openPdf) throw new LibraryError('pdf_unsupported', '当前应用不支持 PDF 格式')
          const handle = await this.openPdf(this.drive, file, current)
          try { const value = await handle.document.getMetadata(); current.throwIfAborted(); result.metadata = pdfMetadata(value.info, value.metadata?.getRaw()) }
          finally { await handle.destroy() }
        } else if (unit.format === 'images') {
          let cursor: string | null = null, count = 0
          do {
            const page = await this.access.list(file.id, cursor, current); count += page.entries.length
            const info = page.entries.find(entry => !entry.is_dir && entry.name.toLowerCase() === 'comicinfo.xml')
            if (info) {
              const checked = await this.access.file(info.id, current, info.content_version)
              const source = new RangeFile(this.drive, checked.file, current, LIMITS.markup)
              try {
                const bytes = await source.read(0, info.size, LIMITS.markup)
                const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
                result.metadata = parseComicInfo(new TextDecoder(encoding, { fatal: true }).decode(bytes))
              } finally { source.destroy() }
              break
            }
            if (!page.has_more) break
            if (!page.next_cursor || page.next_cursor === cursor) throw new LibraryError('invalid_cursor', '元数据查找分页游标无效')
            cursor = page.next_cursor
          } while (count < 10000)
        }
      } catch (error) {
        current.throwIfAborted()
        if (isAbort(error)) throw error
        // 安全失败只回退书名占位，显式返回告警；不输出未经验证的部分元数据。
        result = { ...empty(), warnings: [metadataText(errorMessage(error), 500) ?? '元数据读取失败'] }
      }
      current.throwIfAborted(); await this.access.file(file.id, current, file.content_version)
      if (!result.warnings.length) await this.cache.set(metadataKey(file), result, current)
      return result
    })
  }
  pause() { this.paused = true; this.controller.abort() }
  resume() { if (this.paused) { this.paused = false; this.controller = new AbortController() } }
  destroy() { this.pause(); this.cache.destroy() }
}
