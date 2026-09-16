import { startApp } from '../reader/app'
import { extension, LIMITS } from '../reader/io'
import { openPdfDocument } from '../reader/library/pdf-document'

void startApp({
  kind: 'books',
  openPdf: openPdfDocument,
  async create(context) {
    const kind = extension(context.file.name)
    const limit = kind === 'txt' ? LIMITS.txt : kind === 'epub' ? LIMITS.epub : LIMITS.pdf
    if (context.file.size > limit) throw new Error(`文件超过首版 ${limit / 1048576} MiB 上限`)
    if (kind === 'txt') return new (await import('./text')).TextReader(context)
    if (kind === 'epub') return new (await import('./epub')).EpubReader(context)
    if (kind === 'pdf') return new (await import('./pdf')).PdfReader(context)
    throw new Error('图书插件只支持 TXT、EPUB 和 PDF')
  },
}).catch((error) => {
  document.getElementById('app')!.textContent = `图书打开失败：${error.message}`
})
