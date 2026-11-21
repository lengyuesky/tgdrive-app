import { testId } from './library/test-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { RangeFile, LIMITS, natural, MiB } from './io'
import { Archive, archivePath, relativeResource } from './archive'
import { imageInfo } from './image'
import { textSections, detectEncoding } from './formats/text'
import { cleanChapter, xml } from './formats/epub'
import { png, zip } from '../tests/fixtures/reader-files.mjs'
import type { HostClient, FileNode } from '@tgdrive/page-sdk'

const entry = (size: number): FileNode => ({ id: testId(2), name: '测试.zip', path: '/测试.zip', size: String(size), created_at: 1, modified_at: 1, parent_id: '1', revision: 'a'.repeat(64), kind: 'file', content_version: 'a'.repeat(64), children_revision: null, has_thumbnail: false })
function source(data: Uint8Array) {
  const readRange = vi.fn(async (_ref: unknown, window: { offset: string; length: string }) => new Uint8Array(data.subarray(Number(window.offset), Number(window.offset) + Number(window.length))))
  const file = new RangeFile({ readRange } as unknown as HostClient, entry(data.length), new AbortController().signal, LIMITS.archive)
  return { file, readRange }
}
describe('阅读器资源与归档', () => {
  it('范围缓存复用且不超过 32 个块，跨块读取不截断', async () => {
    const bytes = new Uint8Array(34 * MiB); bytes[MiB - 1] = 3; bytes[MiB] = 4
    const { file, readRange } = source(bytes)
    expect([...await file.read(MiB - 1, 2)]).toEqual([3, 4])
    await file.read(MiB - 1, 2); expect(readRange).toHaveBeenCalledTimes(2)
    for (let i = 2; i < 34; i++) await file.read(i * MiB, 1)
    await file.read(0, 1); expect(readRange).toHaveBeenCalledTimes(35)
    await expect(file.read(0, LIMITS.entry + 1)).rejects.toThrow()
    file.destroy(); await expect(file.read(0, 1)).rejects.toThrow()
  })
  it('共享分块取消一个等待者不影响另一读者，失败任务也能重试', async () => {
    let resolve!: (bytes: Uint8Array) => void
    const readRange = vi.fn(() => new Promise<Uint8Array>(yes => { resolve = yes }))
    const file = new RangeFile({ readRange } as unknown as HostClient, entry(16), new AbortController().signal, LIMITS.archive)
    const controller = new AbortController()
    const cancelled = file.read(0, 1, LIMITS.entry, controller.signal).catch((error: Error) => error.name)
    const other = file.read(0, 1)
    controller.abort()
    expect(await cancelled).toBe('AbortError'); expect(readRange).toHaveBeenCalledOnce()
    resolve(new Uint8Array(16).fill(7)); expect([...await other]).toEqual([7])
    file.destroy()
    const failedRead = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue(new Uint8Array(16).fill(3))
    const retry = new RangeFile({ readRange: failedRead } as unknown as HostClient, entry(16), new AbortController().signal, LIMITS.archive)
    await expect(retry.read(0, 1)).rejects.toThrow('读取失败')
    expect([...await retry.read(0, 1)]).toEqual([3]); expect(failedRead).toHaveBeenCalledTimes(2)
    retry.destroy()
  })
  it('归档路径只允许包内相对引用', () => {
    expect(relativeResource('OPS/Text/one.xhtml', '../Images/中文.png#top')).toEqual({ path: 'OPS/Images/中文.png', hash: 'top' })
    expect(relativeResource('OPS/one.xhtml', '#章')).toEqual({ path: 'OPS/one.xhtml', hash: '章' })
    for (const path of ['../a','/a','C:/a','a\\b','a//b','a/./b']) expect(() => archivePath(path)).toThrow()
    for (const ref of ['../../a','https://bad/a','data:image/png,x','%2fapi/admin','%2e%2e/%2e%2e/a']) expect(() => relativeResource('OPS/one.xhtml', ref)).toThrow()
  })
  it('按需解压条目并检查 CRC、路径和压缩比', async () => {
    const data = zip([['one.txt','完整正文'], ['二/图片.png',png(16,20,[20,50,90])]])
    const archive = await new Archive(source(data).file).open()
    expect(await archive.text('one.txt')).toBe('完整正文'); archive.destroy()
    await expect(new Archive(source(zip([['../evil.txt','x']])).file).open()).rejects.toThrow()
    await expect(new Archive(source(zip([['bomb.txt',new Uint8Array(MiB)]])).file).open()).rejects.toThrow()
    const bad = Buffer.from(zip([['one.txt','crc test']]))
    // 同步修改本地和中央记录的 CRC，避免仅依赖目录一致性检查。
    bad.writeUInt32LE(1,14)
    const central = bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); bad.writeUInt32LE(1,central+16)
    const corrupt = await new Archive(source(bad).file).open()
    await expect(corrupt.text('one.txt')).rejects.toThrow(); corrupt.destroy()
  })
  it('解码前拒绝像素炸弹和畸形 AVIF，不解析 SVG', () => {
    expect(imageInfo(png(30,40,[1,2,3]))).toEqual({ width:30,height:40,mime:'image/png' })
    const huge = png(2,2,[1,2,3]); huge.writeUInt32BE(100000,16)
    expect(() => imageInfo(huge)).toThrow('像素')
    const avif = Buffer.alloc(32); avif.writeUInt32BE(16); avif.write('ftyp',4); avif.write('avif',8); avif.writeUInt32BE(1,16); avif.write('meta',20); avif.writeBigUInt64BE(2n,24)
    expect(() => imageInfo(avif)).toThrow()
    expect(() => imageInfo(new TextEncoder().encode('<svg width="2" height="3"></svg>'))).toThrow()
  })
})
describe('图书文字与安全重排', () => {
  it('自然页序不受整数溢出、大小写和前导零影响', () => {
    expect(['10.png','2.png','1.png'].sort(natural)).toEqual(['1.png','2.png','10.png'])
    expect(natural('99999999999999999999.png','100000000000000000000.png')).toBeLessThan(0)
    expect(natural('第2章/2.png','第10章/1.png')).toBeLessThan(0)
  })
  it('TXT 全文窗口覆盖每个字符且不拆分代理对，识别编码与章节', () => {
    const text = `第1章 起点\n${'文字😀'.repeat(90000)}\n第2章 终点\n末尾`
    const sections = textSections(text)
    expect(sections.map((section) => text.slice(section.start,section.end)).join('')).toBe(text)
    expect(sections.at(-1)!.label).toBe('第2章 终点')
    for (const section of sections) { expect(section.end-section.start).toBeLessThanOrEqual(32768); expect(text.charCodeAt(section.start)).not.toBeGreaterThanOrEqual(0xdc00) }
    expect(detectEncoding(new Uint8Array([0xff,0xfe,0x00,0x4e]))).toBe('utf-16le')
    expect(detectEncoding(new Uint8Array([0xfe,0xff,0x4e,0x00]))).toBe('utf-16be')
    expect(detectEncoding(new Uint8Array([0xc4,0xe3,0xba,0xc3]))).toBe('gb18030')
  })
  it('EPUB 清洗不保留主动内容、外链、CSS 或外部图片地址', () => {
    const fragment = cleanChapter('<html xmlns="http://www.w3.org/1999/xhtml"><body><script>bad()</script><style>bad</style><p id="x" onclick="bad()" style="color:red">正文</p><a href="two.xhtml#y">内部</a><img src="../img/a.png"/><img src="https://bad/x"/><iframe src="https://bad"/><svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg></body></html>', 'OPS/one.xhtml')
    const div = document.createElement('div'); div.append(fragment)
    expect(div.querySelector('script,style,iframe,svg,[onclick],[style],[src],[href]')).toBeNull()
    expect(div.querySelector('img[data-resource]')?.getAttribute('data-resource')).toBe('img/a.png')
    expect(div.querySelector('[data-link]')?.getAttribute('data-link')).toBe('OPS/two.xhtml#y')
    expect(div.textContent).toContain('正文')
    expect(() => xml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>')).toThrow()
  })
})
