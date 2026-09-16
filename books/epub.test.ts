import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EpubReader } from './epub'
import { Archive } from '../reader/archive'
import { RangeFile } from '../reader/io'
import { defaults } from '../reader/state'
import { deferred, file, memoryDrive } from '../reader/library/test-fixtures'
import { zip } from '../tests/browser/readers-fixtures.mjs'
import type { ViewContext } from '../reader/view'

const readers: EpubReader[] = []
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, right: 1, top: 0, bottom: 1, width: 1, height: 1 }) })
})
afterEach(() => {
  readers.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren(); vi.unstubAllGlobals()
  if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect)
  else delete (Range.prototype as Partial<Range>).getBoundingClientRect
})
function epub(version: 2 | 3, drm = false, customNav?: string) {
  const nav = customNav ?? (version === 3
    ? '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml">卷一</a><ol><li><a href="one.xhtml#middle">同章中点</a><ol><li><a href="one.xhtml#end">同章尾声</a></li></ol></li></ol></li><li><a href="two.xhtml">卷二</a></li><li><a href="https://invalid.example/a">外部</a></li></ol></nav></body></html>'
    : '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>卷一</text></navLabel><content src="one.xhtml"/><navPoint><navLabel><text>同章中点</text></navLabel><content src="one.xhtml#middle"/><navPoint><navLabel><text>同章尾声</text></navLabel><content src="one.xhtml#end"/></navPoint></navPoint></navPoint><navPoint><navLabel><text>卷二</text></navLabel><content src="two.xhtml"/></navPoint></navMap></ncx>')
  return zip([
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'],
    ['OPS/book.opf', `<package><metadata><title>分层目录</title></metadata><manifest><item id="nav" href="nav.${version === 3 ? 'xhtml' : 'ncx'}" ${version === 3 ? 'properties="nav"' : ''}/><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine toc="nav"><itemref idref="one"/><itemref idref="one"/><itemref idref="two"/></spine></package>`],
    [`OPS/nav.${version === 3 ? 'xhtml' : 'ncx'}`, nav],
    ['OPS/one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一段</p><p id="middle">第二段</p><p id="end">第三段</p></body></html>'],
    ['OPS/two.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>终章</p></body></html>'],
    ...(drm ? [['META-INF/encryption.xml', '<encryption><EncryptedData><EncryptionMethod Algorithm="unknown"/><CipherData><CipherReference URI="OPS/one.xhtml"/></CipherData></EncryptedData></encryption>'] as [string, string]] : []),
  ])
}
function fixture(bytes: Uint8Array) {
  const mock = memoryDrive(), entry = mock.binary(file(2, '/目录.epub'), bytes), controller = new AbortController()
  const viewport = document.createElement('main'); document.body.append(viewport)
  const context: ViewContext = { drive: mock.drive, file: entry, viewport, signal: controller.signal, prefs: { ...defaults }, changed: vi.fn(), error: vi.fn() }
  const reader = new EpubReader(context); readers.push(reader)
  return { mock, controller, viewport, context, reader }
}
describe('EPUB 层级目录及独立准备', () => {
  it.each([2, 3] as const)('EPUB %s 保留三级目录；同 XHTML 锚点和重复 spine 不复制正文', async version => {
    const { reader, viewport, context, mock } = fixture(epub(version)), text = vi.spyOn(Archive.prototype, 'text')
    const first = await reader.loadNavigation()
    expect(first.map(item => [item.label, item.depth, item.location.index])).toEqual([['卷一', 0, 0], ['同章中点', 1, 0], ['同章尾声', 2, 0], ['卷二', 0, 1]])
    expect(first[1]!.location.entry).toBe('OPS/one.xhtml#middle')
    expect(reader.sections).toHaveLength(2)
    const calls = text.mock.calls.length
    expect(await reader.loadNavigation()).toEqual(first); expect(text).toHaveBeenCalledTimes(calls)
    expect(text.mock.calls.map(call => call[0])).not.toContain('OPS/one.xhtml')
    expect(text.mock.calls.map(call => call[0])).not.toContain('OPS/two.xhtml')
    expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    await reader.open(first[1]!.location)
    expect(reader.current().index).toBe(0)
    expect(viewport.querySelectorAll('article')).toHaveLength(1)
    expect(viewport.textContent).toBe('第一段第二段第三段')
    await reader.turn(1)
    expect(reader.current().index).toBe(1); expect(viewport.textContent).toBe('终章')
  })
  it('多级 span 父标题只借有效 spine 子目标，保留已有父链接，空组和外链不伪造入口', async () => {
    const nav = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
      + '<li><span>部一</span><ol><li><span>卷组</span><ol><li><a href="https://invalid.example/">外部</a></li><li><a href="missing.xhtml">非正文目标</a></li><li><a href="one.xhtml#middle">有效章节</a></li></ol></li></ol></li>'
      + '<li><a href="two.xhtml">自有目标</a><ol><li><a href="one.xhtml#end">子章节</a></li></ol></li>'
      + '<li><span>空组</span><ol><li><a href="../../outside.xhtml">越界</a></li></ol></li></ol></nav></body></html>'
    const { reader, viewport, context, mock } = fixture(epub(3, false, nav)), text = vi.spyOn(Archive.prototype, 'text')
    const items = await reader.loadNavigation()
    expect(items.map(item => [item.label, item.depth, item.location.entry])).toEqual([
      ['部一', 0, 'OPS/one.xhtml#middle'], ['卷组', 1, 'OPS/one.xhtml#middle'], ['有效章节', 2, 'OPS/one.xhtml#middle'],
      ['自有目标', 0, 'OPS/two.xhtml#'], ['子章节', 1, 'OPS/one.xhtml#end'],
    ])
    expect(reader.sections).toHaveLength(2); expect(await reader.loadNavigation()).toEqual(items)
    expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    expect(text.mock.calls.some(([path]) => path === 'OPS/one.xhtml' || path === 'OPS/two.xhtml')).toBe(false)
  })
  it('目录准备不能绕过 DRM 检查，失败释放归档与 Range', async () => {
    const { reader, viewport, context } = fixture(epub(3, true)), closed = vi.spyOn(Archive.prototype, 'destroy'), range = vi.spyOn(RangeFile.prototype, 'destroy')
    await expect(reader.loadNavigation()).rejects.toThrow('DRM')
    expect(closed).toHaveBeenCalled(); expect(range).toHaveBeenCalled()
    expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled()
  })
  it('目录慢请求可取消，迟到准备结果不会改动新页面', async () => {
    const { reader, mock, controller, viewport, context } = fixture(epub(3)), started = deferred(), closed = vi.spyOn(Archive.prototype, 'destroy')
    mock.readRange.mockImplementationOnce(async (_ref, _offset, _length, options) => {
      started.resolve()
      return new Promise<never>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }))
    })
    const pending = reader.loadNavigation(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise; controller.abort(); viewport.textContent = '新详情'
    await rejected
    expect(closed).toHaveBeenCalled(); expect(viewport.textContent).toBe('新详情'); expect(context.changed).not.toHaveBeenCalled()
  })
})
