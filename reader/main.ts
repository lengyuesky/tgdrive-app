/** 阅读馆以独立应用身份共享书漫数据，解析器根据文件真实类型按需加载。 */
import { startApp } from './app'
import { createReader } from './factory'
import { openPdfDocument } from './library/pdf-document'
import './shelf.css'

void startApp({ id: 'reader', kind: 'all', create: createReader, openPdf: openPdfDocument })
  .catch((error) => {
    document.getElementById('app')!.textContent = `阅读馆打开失败：${error instanceof Error ? error.message : String(error)}`
  })
