import { byteSize } from './files'
/** 所有打开路径共用同一分派：首页、书库、详情目录、历史与宿主启动。 */
import { extension, LIMITS } from './io'
import type { ReaderView, ViewContext } from './view'

export async function createReader(context: ViewContext): Promise<ReaderView> {
  const format = extension(context.file.name)
  if ((context.file.kind === 'directory') || format === 'cbz' || format === 'zip') {
    return new (await import('./formats/comic')).ComicReader(context)
  }
  const limit = format === 'txt' ? LIMITS.txt : format === 'epub' ? LIMITS.epub : format === 'pdf' ? LIMITS.pdf : undefined
  if (!limit) throw new Error('阅读馆支持 TXT、EPUB、PDF、CBZ、ZIP 和图片目录')
  if (byteSize(context.file, limit) > limit) throw new Error(`文件超过 ${limit / 1048576} MiB 上限`)
  if (format === 'txt') return new (await import('./formats/text')).TextReader(context)
  if (format === 'epub') return new (await import('./formats/epub')).EpubReader(context)
  return new (await import('./formats/pdf')).PdfReader(context)
}
