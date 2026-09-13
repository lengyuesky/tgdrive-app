// 合成阅读文件：不访问真实网盘、书籍或网络书源。
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
export function png(width, height, color, noise = false) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let seed = 17
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    raw[y * (width * 3 + 1) + 1 + x] = noise ? seed & 255 : color[x % 3]
  }
  const chunk = (kind, data) => {
    const type = Buffer.from(kind), head = Buffer.alloc(4), checksum = Buffer.alloc(4)
    head.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([head, type, data, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
export function zip(files) {
  const local = [], central = []; let offset = 0
  for (const [name, input] of files) {
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input), filename = Buffer.from(name), compressed = deflateRawSync(data), checksum = crc32(data)
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20,4); head.writeUInt16LE(0x800,6); head.writeUInt16LE(8,8); head.writeUInt16LE(33,12); head.writeUInt32LE(checksum,14); head.writeUInt32LE(compressed.length,18); head.writeUInt32LE(data.length,22); head.writeUInt16LE(filename.length,26)
    local.push(head, filename, compressed)
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314,4); head.copy(entry,6,4,30); entry.writeUInt32LE(0o100644 * 65536,38); entry.writeUInt32LE(offset,42)
    central.push(entry,filename); offset += head.length + filename.length + compressed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16)
  return Buffer.concat([...local, directory, end])
}
export function epub(version = 3, paginated = false, imagesOnly = false) {
  const nav = version === 3
    ? `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml">起点</a></li>${paginated ? '<li><a href="one.xhtml#middle">同章中点</a></li>' : ''}<li><a href="two.xhtml#end">终点</a></li></ol></nav></body></html>`
    : '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="p1"><navLabel><text>起点</text></navLabel><content src="one.xhtml"/></navPoint><navPoint id="p2"><navLabel><text>终点</text></navLabel><content src="two.xhtml#end"/></navPoint></navMap></ncx>'
  const navFile = version === 3 ? 'nav.xhtml' : 'toc.ncx'
  const paragraphs = (start) => Array.from({ length: 80 }, (_, i) => `<p>段落 ${start + i}：在移动设备验证单列分页、字符锚点、横竖屏和图片异步加载。每个段落都可以恢复到正确的位置。</p>`).join('\n  ')
  const longChapter = `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>分页起点</h1><p><a href="#middle">前往同章中点</a></p>${paragraphs(1)}<h2 id="middle">同章中点锚点</h2><img src="images/page.png" alt="分页插图"/>${paragraphs(81)}<table><tr><td>表格内容换行，不丢失文字。</td><td>第二列</td></tr></table><p>本章末尾标记</p></body></html>`
  return zip([
    ['mimetype','application/epub+zip'],
    ['META-INF/container.xml','<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['Book/content.opf',`<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>合成 EPUB ${version}</dc:title><dc:creator>阅读器测试</dc:creator></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="${navFile}" media-type="${version === 3 ? 'application/xhtml+xml' : 'application/x-dtbncx+xml'}" ${version === 3 ? 'properties="nav"' : ''}/></manifest><spine toc="nav"><itemref idref="one"/><itemref idref="two"/></spine></package>`],
    [`Book/${navFile}`,nav],
    ['Book/one.xhtml',imagesOnly ? `<html xmlns="http://www.w3.org/1999/xhtml"><body>${Array.from({ length: 4 }, (_, i) => `<img src="images/page.png" alt="纯图 ${i + 1}"/>`).join('')}</body></html>` : paginated ? longChapter : '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>起点：安全阅读</h1><p>这是一段中文图书正文。</p><script>window.__readerInjected = true</script><style>body { background: red; }</style><img src="images/page.png" alt="合成插图"/><img src="https://reader-test.invalid/track.png"/><p><a href="two.xhtml#end">前往终点</a></p><a href="https://reader-test.invalid/">禁用的外链</a></body></html>'],
    ['Book/two.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="end">终点：章节跳转成功</h1><p>书签应该恢复到这里。</p></body></html>'],
    ['Book/images/page.png',png(240,imagesOnly ? 960 : 320,[32,128,100])],
  ])
}
export function basicPdf() {
  const stream = 'BT /F1 22 Tf 36 760 Td (PDF STANDARD FONT TEST) Tj ET\nq 0.2 0.5 0.7 rg 40 400 300 180 re f Q'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n', offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
export async function seedReaders(destination) {
  const put = async (path, data) => { const target = `${destination}/${path}`; await mkdir(dirname(target), { recursive: true }); await writeFile(target, data) }
  const paragraphs = Array.from({ length: 6000 }, (_, i) => `正文第 ${i + 1} 行：在临时网盘验证长篇阅读和字符位置恢复。`).join('\n')
  await put('测试图书/长篇.txt', `第1章 起点\n${paragraphs}\n第2章 终点\n这里是超过 256 KiB 的正文结尾。`)
  await put('测试图书/GBK.txt', Buffer.from([0xb5,0xda,0x31,0xd5,0xc2,0x20,0xd6,0xd0,0xce,0xc4,0x0a,0xc4,0xe3,0xba,0xc3]))
  await put('测试图书/UTF16.txt', Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from('第1章 起点\nUTF16 中文正文\n第2章 终点', 'utf16le')]))
  await put('测试图书/示例3.epub', epub(3)); await put('测试图书/示例2.epub', epub(2))
  await put('测试图书/分页.epub', epub(3, true))
  await put('测试图书/纯图.epub', epub(3, false, true))
  await put('测试图书/损坏.epub', 'not a zip')
  await put('测试图书/中文.pdf', await readFile(new URL('../fixtures/chinese.pdf', import.meta.url)))
  await put('测试图书/标准字体.pdf',basicPdf())
  for (const [name, color] of [['1.png',[190,50,50]],['2.png',[50,170,70]],['10.png',[50,80,200]]]) await put(`测试漫画/目录漫画/第1章/${name}`,png(240,360,color))
  await put('测试漫画/目录漫画/第2章/1.png',png(240,360,[160,90,160]))
  await put('测试漫画/自然页序.cbz',zip([['10.png',png(240,360,[50,80,200])],['1.png',png(240,360,[190,50,50])],['2.png',png(240,360,[50,170,70])],['__MACOSX/._1.png','ignore'],['readme.txt','非图片附件']]))
  await put('测试漫画/长册.cbz',zip(Array.from({length:200},(_,i)=>[`${i+1}.png`,png(120,180,[i%200,80,100])])))
  const image = png(768,1024,[0,0,0],true)
  await put('测试漫画/大漫画.zip',zip(Array.from({length:10},(_,i)=>[`${i+1}.png`,image])))
  await put('测试漫画/越界.zip',zip([['../escape.png',png(16,16,[0,0,0])]]))
  await put('测试漫画/超限.zip',zip([['bomb.png',Buffer.alloc(33 * 1024 * 1024)]]))
  return destination
}
