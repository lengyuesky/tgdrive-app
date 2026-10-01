import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextReader, textNavigation, textSections } from './text'
import { defaults, localFonts } from '../reader/state'
import { RangeFile, LIMITS } from '../reader/io'
import { deferred, file, memoryDrive } from '../reader/library/test-fixtures'
import type { ViewContext } from '../reader/view'

const readers: TextReader[] = []
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => {
  readers.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren(); vi.unstubAllGlobals()
  if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect)
  else delete (Range.prototype as Partial<Range>).getBoundingClientRect
})
function fixture(text = '第1章 起点\n正文\n第2章 终点\n尾声') {
  const mock = memoryDrive(), entry = mock.binary(file(2, '/合成.txt'), new TextEncoder().encode(text))
  const controller = new AbortController(), viewport = document.createElement('main'); document.body.append(viewport)
  Object.defineProperties(viewport, { clientWidth: { value: 500 }, clientHeight: { value: 600 } })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value(this: Range) {
    const top = this.startOffset - viewport.scrollTop
    return { left: 0, right: 1, top, bottom: top + 1, width: 1, height: 1 }
  } })
  const context: ViewContext = { drive: mock.drive, file: entry, viewport, signal: controller.signal, prefs: { ...defaults }, changed: vi.fn(), error: vi.fn() }
  const reader = new TextReader(context); readers.push(reader)
  return { mock, reader, context, viewport, controller }
}
describe('TXT 分层目录与独立准备', () => {
  it('长章的每个技术窗口都在父章下，导航偏移仍覆盖真实原文', () => {
    const text = `第1章 起点\n${'文字😀'.repeat(26000)}\n第2章 终点\n末尾`
    const chunks = textSections(text), navigation = textNavigation(chunks)
    expect(navigation[0]).toMatchObject({ label: '第1章 起点', depth: 0, location: { index: 0, offset: 0 } })
    const children = navigation.filter(item => item.depth === 1)
    expect(children.length).toBe(chunks.length - 1)
    expect(children.map(item => item.label)).toEqual(children.map((_, index) => `分段 ${index + 1}`))
    for (const item of children) expect(item.location.offset).toBe(chunks[item.location.index]!.start)
    expect(navigation.at(-1)).toMatchObject({ label: '第2章 终点', depth: 0 })
    expect(chunks.map(chunk => text.slice(chunk.start, chunk.end)).join('')).toBe(text)
  })
  it('目录完整解码但不挂载正文、不发 changed、不保存，重复调用复用准备结果', async () => {
    const { mock, reader, viewport, context } = fixture(`第1章 起点\n${'文本'.repeat(20000)}\n第2章 终点\n尾声`)
    const first = await reader.loadNavigation(), reads = mock.readRange.mock.calls.length
    const second = await reader.loadNavigation()
    expect(second).toEqual(first); expect(second).not.toBe(first)
    expect(mock.readRange).toHaveBeenCalledTimes(reads)
    expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled(); expect(mock.set).not.toHaveBeenCalled()
    expect(reader.sections.length).toBeGreaterThan(2)
    const target = first.find(item => item.depth === 1 && item.location.offset! > 0)!
    await reader.open(target.location)
    expect(reader.current()).toMatchObject(target.location)
    expect(viewport.querySelector('.plain-text')?.textContent).toBeTruthy()
  })
  it('字体、边距、字号重排保留字符锚点，并在销毁时归还视口边距', async () => {
    const { reader, viewport, context } = fixture('第1章 正文\n' + '锚点文字'.repeat(1500))
    viewport.style.paddingLeft = '7px'; viewport.style.paddingRight = '9px'
    await reader.open({ format: 'txt', index: 0, offset: 321 })
    const before = reader.current().offset
    for (const font of ['sans', 'system', 'serif'] as const) {
      await reader.configure({ ...context.prefs, font, margin: 28, fontSize: 26, lineHeight: 2 })
      expect(viewport.querySelector<HTMLElement>('article')!.style.fontFamily).toBe(localFonts[font])
      expect(viewport.style.paddingLeft).toBe('28px'); expect(viewport.style.paddingRight).toBe('28px')
      expect(reader.current().offset).toBe(before)
    }
    reader.destroy()
    // 构造时视口没有内联边距；不能把阅读器设置泄漏给下一本 PDF/漫画。
    expect(viewport.style.paddingLeft).toBe(''); expect(viewport.style.paddingRight).toBe('')
  })
  it('慢解码取消与空文本失败都会释放 Range，迟到结果不挂载或发布', async () => {
    const { mock, reader, viewport, controller, context } = fixture(), start = deferred()
    const destroy = vi.spyOn(RangeFile.prototype, 'destroy')
    mock.readRange.mockImplementationOnce(async (_ref, _offset, _length, options) => {
      start.resolve()
      return new Promise<never>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }))
    })
    const pending = reader.loadNavigation(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await start.promise; controller.abort(); await rejected
    expect(destroy).toHaveBeenCalled(); expect(viewport.childNodes).toHaveLength(0); expect(context.changed).not.toHaveBeenCalled()
    const empty = fixture('')
    await expect(empty.reader.loadNavigation()).rejects.toThrow('为空')
    expect(empty.context.changed).not.toHaveBeenCalled(); expect(destroy.mock.calls.length).toBeGreaterThan(1)
  })
  it('独立目录仍拒绝超 64 MiB TXT，不用目录入口绕过文件限制', () => {
    const mock = memoryDrive(), viewport = document.createElement('main')
    expect(() => new TextReader({ drive: mock.drive, file: { ...file(3, '/过大.txt'), size: LIMITS.txt + 1 }, viewport, signal: new AbortController().signal, prefs: defaults, changed: vi.fn(), error: vi.fn() })).toThrow('64 MiB')
    expect(mock.readRange).not.toHaveBeenCalled()
  })
})

describe('TXT 渐进首屏与正文搜索', () => {
  it('首屏不等待后续慢 Range，后台完成后当前字符位置与正文不变', async () => {
    const text = '第1章 起点\n' + 'abcd\n'.repeat(450000) + '\n第2章 终点\n搜索目标'
    const { reader, mock, viewport } = fixture(text), gate = deferred(), original = mock.readRange.getMockImplementation()!
    mock.readRange.mockImplementation(async (...args) => { if (args[1] >= 1048576) await gate.promise; return original(...args) })
    await reader.open({ format: 'txt', index: 0, offset: 120 })
    const before = viewport.textContent, location = reader.current()
    expect(before).toContain('第1章'); expect(reader.navigationState().atEnd).toBe(false)
    expect(reader.navigationState().layoutNotice).toContain('加载后续')
    gate.resolve()
    await vi.waitFor(() => expect(reader.navigationState().layoutNotice).toBeUndefined())
    expect(reader.current().offset).toBe(location.offset); expect(viewport.textContent).toBe(before)
    expect(reader.navigation.some(item => item.label === '第2章 终点')).toBe(true)
  })
  it('搜索跨章节返回真实字符位置，跳转和高亮不更改正文', async () => {
    const text = '第1章 起点\n中文 [a+b] 开头\n第2章 终点\n另一个 [a+b] 结尾'
    const { reader, viewport } = fixture(text); await reader.open()
    const results = []
    for await (const item of reader.search('[a+b]', new AbortController().signal)) results.push(item)
    expect(results).toHaveLength(2); expect(results[1]!.location.offset).toBe(text.lastIndexOf('[a+b]'))
    await reader.restore(results[1]!.location); reader.highlight(results[1]!)
    expect(window.getSelection()?.toString()).toBe('[a+b]'); expect(viewport.textContent).toContain('另一个 [a+b] 结尾')
  })
  it('后台慢读取销毁后不能继续修改正文或发布位置', async () => {
    const { reader, mock, context } = fixture('abc\n'.repeat(600000)), gate = deferred(), original = mock.readRange.getMockImplementation()!
    mock.readRange.mockImplementation(async (...args) => { if (args[1] >= 1048576) await gate.promise; return original(...args) })
    await reader.open(); reader.destroy(); const calls = vi.mocked(context.changed).mock.calls.length
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(context.changed).toHaveBeenCalledTimes(calls); expect(context.error).not.toHaveBeenCalled()
  })
})
