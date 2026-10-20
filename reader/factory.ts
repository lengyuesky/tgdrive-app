/** 所有打开路径共用同一分派：首页、书库、详情目录、历史与宿主启动。 */
import { extension, LIMITS } from './io'
import type { ReaderView, ViewContext } from './view'

export async function createReader(context: ViewContext): Promise<ReaderView> {
  const format = extension(context.file.name)
  if (context.file.is_dir || format === 'cbz' || format === 'zip') {
    return new (await import('../comics/comic')).ComicReader(context)
  }
  const limit = format === 'txt' ? LIMITS.txt : format === 'epub' ? LIMITS.epub : format === 'pdf' ? LIMITS.pdf : undefined
  if (!limit) throw new Error('阅读馆支持 TXT、EPUB、PDF、CBZ、ZIP 和图片目录')
  if (context.file.size > limit) throw new Error(`文件超过 ${limit / 1048576} MiB 上限`)
  if (format === 'txt') return new (await import('../books/text')).TextReader(context)
  if (format === 'epub') return new (await import('../books/epub')).EpubReader(context)
  return new (await import('../books/pdf')).PdfReader(context)
}
