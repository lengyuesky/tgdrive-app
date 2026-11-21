/** 阅读馆只使用页面 SDK；解析器按实际格式加载，初始化不扫描网盘。 */
import { startApp } from '../app'
import { createReader } from '../factory'
import { openPdfDocument } from '../library/pdf-document'
import '../shelf.css'
void startApp({ id: 'reader', kind: 'all', create: createReader, openPdf: openPdfDocument })
  .catch(error => { document.getElementById('app')!.textContent = `阅读馆打开失败：${error instanceof Error ? error.message : String(error)}` })
