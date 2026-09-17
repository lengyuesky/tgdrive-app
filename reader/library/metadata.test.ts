import { describe, expect, it, vi } from 'vitest'
import { Archive } from '../archive'
import { MetadataService, parseComicInfo, pdfMetadata } from './metadata'
import { safeXml } from './metadata-value'
import { LibraryAccess } from './sources'
import { file, memoryDrive, signal, sources, unit } from './test-fixtures'
import { png, zip } from '../../tests/browser/readers-fixtures.mjs'

const container = '<container><rootfiles><rootfile full-path="Book/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
function epubArchive(cover: string, extra = '', entries: [string, string][] = []) {
  return zip([
    ['META-INF/container.xml', container],
    ['Book/content.opf', `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>内嵌书名</dc:title><dc:creator>作者甲</dc:creator><dc:creator>作者乙</dc:creator><dc:description>安全&lt;b&gt;简介&lt;/b&gt;</dc:description>${extra}</metadata><manifest>${cover}<item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>`],
    ['Book/cover.png', png(12, 20, [10, 30, 50])],
    ['Book/body.xhtml', '<html><body>绝不能为获取元数据解析正文</body></html>'],
    ...entries,
  ])
}
function setup(path: string, bytes: Uint8Array) {
  const root = file(1, '/书', true), mock = memoryDrive([root]), entry = mock.binary(file(2, path), bytes), access = new LibraryAccess(mock.drive)
  access.setSources(sources(root))
  return { ...mock, entry, service: new MetadataService(mock.drive, access), access }
}
describe('阅读馆内嵌元数据白名单与安全失败', () => {
  it('ComicInfo 仅提取白名单纯文本，作者去重、卷号校验，不输出 HTML/脚本/外链字段', () => {
    const metadata = parseComicInfo('<ComicInfo><Title>标题</Title><Series>系列</Series><Volume>2</Volume><Number>3.5</Number><Writer>作者甲,作者乙</Writer><Penciller>作者甲</Penciller><Summary>简介&lt;img src="https://bad.invalid/x" /&gt;<script>恶意脚本</script><b>正文</b></Summary><Publisher>出版社</Publisher><LanguageISO>zh</LanguageISO><Year>2024</Year><Web>https://bad.invalid/</Web><Unknown>未知</Unknown></ComicInfo>')
    expect(metadata).toMatchObject({ title: '标题', series: '系列', volume: 2, number: 3.5, authors: ['作者甲', '作者乙'], publisher: '出版社', language: 'zh', year: 2024 })
    expect(metadata.description).toBe('简介正文')
    expect(JSON.stringify(metadata)).not.toMatch(/bad\.invalid|恶意脚本|Unknown|Web|<img/)
    expect(parseComicInfo('<ComicInfo><Number>未知号</Number><Volume>-2</Volume></ComicInfo>')).toEqual({})
  })
  it('XML 实体、外部 DOCTYPE、损坏或过深结构拒绝解析', () => {
    for (const text of ['<!DOCTYPE ComicInfo SYSTEM "https://bad.invalid/data"><ComicInfo/>', '<!DOCTYPE ComicInfo [<!ENTITY x "boom">]><ComicInfo><Title>&x;</Title></ComicInfo>', '<ComicInfo><Title>', `${'<a>'.repeat(40)}${'</a>'.repeat(40)}`]) expect(() => safeXml(text)).toThrow()
  })
  it('CBZ 使用安全 Archive 读取唯一 ComicInfo，目录单元只按需读取直属 ComicInfo', async () => {
    const mock = setup('/书/漫画.cbz', zip([['ComicInfo.xml', '<ComicInfo><Series>星河</Series><Number>2</Number><Writer>作者</Writer></ComicInfo>'], ['1.png', png(12, 20, [1, 2, 3])]]))
    const reads = vi.spyOn(Archive.prototype, 'read')
    const result = await mock.service.get(unit(mock.entry), signal())
    expect(result.metadata).toMatchObject({ series: '星河', number: 2, authors: ['作者'] })
    expect(reads.mock.calls.map(([path]) => path)).toEqual(['ComicInfo.xml'])
    expect(mock.readRange.mock.calls.every(([, , length]) => length <= 1024 * 1024)).toBe(true)
    const count = mock.readRange.mock.calls.length
    await mock.service.get(unit(mock.entry), signal()); expect(mock.readRange).toHaveBeenCalledTimes(count)
    const folder = file(3, '/书/目录', true); mock.nodes.set(3, folder)
    for (let id = 4; id < 204; id++) mock.nodes.set(id, file(id, `/书/目录/${id}.png`))
    const info = mock.binary(file(204, '/书/目录/ComicInfo.xml'), new TextEncoder().encode('<ComicInfo><Title>目录漫画</Title></ComicInfo>'))
    const directory = await mock.service.get(unit(folder), signal())
    expect(directory.metadata.title).toBe('目录漫画')
    expect(mock.readRange.mock.calls.at(-1)?.[0].id).toBe(info.id)
    expect(mock.list.mock.calls.filter(([params]) => params.path === folder.path)).toHaveLength(2)
    mock.service.destroy()
  })
  it('EPUB 3 cover-image 和 EPUB 2 cover meta 适配，只解析 container/OPF，不解析正文或封面像素', async () => {
    for (const [cover, extra] of [
      ['<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>', ''],
      ['<item id="cover" href="cover.png" media-type="image/png"/>', '<meta name="cover" content="cover"/>'],
    ]) {
      const mock = setup('/书/图书.epub', epubArchive(cover!, extra!)), reads = vi.spyOn(Archive.prototype, 'read')
      const result = await mock.service.get(unit(mock.entry), signal())
      expect(result).toMatchObject({ coverPath: 'Book/cover.png', metadata: { title: '内嵌书名', authors: ['作者甲', '作者乙'], description: '安全简介' }, warnings: [] })
      expect(reads.mock.calls.map(([path]) => path)).toEqual(['META-INF/container.xml', 'Book/content.opf'])
      expect(mock.drive.media.url).not.toHaveBeenCalled(); mock.service.destroy(); reads.mockRestore()
    }
  })
  it('外链封面、路径穿越、SVG、实体和压缩炸弹安全失败，返回告警而不保存伪元数据', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止网络'))
    const archives = [
      epubArchive('<item id="cover" href="https://bad.invalid/a.png" media-type="image/png" properties="cover-image"/>'),
      epubArchive('<item id="cover" href="../../a.png" media-type="image/png" properties="cover-image"/>'),
      epubArchive('<item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>'),
      zip([['ComicInfo.xml', '<!DOCTYPE ComicInfo [<!ENTITY x "boom">]><ComicInfo/>']]),
      zip([['ComicInfo.xml', 'x'.repeat(3 * 1024 * 1024)]]),
      zip([['../unsafe.png', png(3, 4, [1, 2, 3])]]),
    ]
    for (let index = 0; index < archives.length; index++) {
      const mock = setup(index < 3 ? '/书/坏.epub' : '/书/坏.cbz', archives[index]!)
      const result = await mock.service.get(unit(mock.entry), signal())
      expect(result.metadata).toEqual({}); expect(result.warnings.length).toBeGreaterThan(0)
      expect(mock.set).not.toHaveBeenCalled(); mock.service.destroy()
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('残留加密声明不阻止元数据提取，指向真实条目的加密声明仍拒绝', async () => {
    const encryption = (uri: string) => [['META-INF/encryption.xml', `<encryption><EncryptedData><EncryptionMethod Algorithm="unknown"/><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`] as [string, string]]
    const cover = '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
    const vestigial = setup('/书/残留.epub', epubArchive(cover, '', encryption('OEBPS/Styles/dkagent.css')))
    const ok = await vestigial.service.get(unit(vestigial.entry), signal())
    expect(ok).toMatchObject({ coverPath: 'Book/cover.png', metadata: { title: '内嵌书名', authors: ['作者甲', '作者乙'] }, warnings: [] })
    vestigial.service.destroy()
    const encrypted = setup('/书/加密.epub', epubArchive(cover, '', encryption('Book/cover.png')))
    const denied = await encrypted.service.get(unit(encrypted.entry), signal())
    expect(denied.metadata).toEqual({}); expect(denied.warnings).toContain('不支持 DRM 或加密 EPUB 内容')
    expect(encrypted.set).not.toHaveBeenCalled(); encrypted.service.destroy()
  })
  it('PDF Info/XMP 白名单只产生纯文本，未知摘要不伪造作者或简介', () => {
    expect(pdfMetadata({ Title: 'PDF 标题', Author: '甲;乙', Subject: '<b>简介</b>', JavaScript: '恶意' })).toEqual({ title: 'PDF 标题', authors: ['甲', '乙'], description: '简介' })
    expect(pdfMetadata({})).toEqual({})
    expect(pdfMetadata({ Title: 'Info' }, '<x xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:title><rdf:Alt><rdf:li>XMP</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>作者</rdf:li></rdf:Seq></dc:creator></x>')).toMatchObject({ title: 'XMP', authors: ['作者'] })
    expect(() => pdfMetadata({}, '<!DOCTYPE x SYSTEM "https://bad.invalid/x"><x/>')).toThrow()
  })
  it('取消和切来源不返回旧缓存或吞掉 AbortError', async () => {
    const mock = setup('/书/漫画.cbz', zip([['ComicInfo.xml', '<ComicInfo><Title>内嵌</Title></ComicInfo>']]))
    const controller = new AbortController(); controller.abort()
    await expect(mock.service.get(unit(mock.entry), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await mock.service.get(unit(mock.entry), signal())
    mock.access.setSources({ config: { schemaVersion: 1, sources: [] }, revision: 'removed' })
    await expect(mock.service.get(unit(mock.entry), signal())).rejects.toMatchObject({ code: 'no_sources' })
    mock.service.destroy()
  })
})
