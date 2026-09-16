import { afterEach, expect, it, vi } from 'vitest'
import { FlowReader } from './flow'
import { defaults } from './state'
import type { ViewContext } from './view'
import type { Drive, FileEntry } from '../sdk/types'

class TestReader extends FlowReader {
  readonly format = 'txt'
  protected async prepare() {}
  protected async content() { return document.createDocumentFragment() }
  current() { return { format: 'txt' as const, index: 0, offset: 0, ratio: 0 } }
  show() {
    this.sections = [{ label: '旧章节' }]
    this.article.textContent = '旧书正文'
    this.context.viewport.replaceChildren(this.article)
  }
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

it('切书后到达的旧排版回调不能重置新书滚动位置', async () => {
  let draw: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { draw = callback; return 1 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const controller = new AbortController(), viewport = document.createElement('main')
  document.body.append(viewport)
  const context: ViewContext = {
    drive: {} as Drive,
    file: { name: '旧书.txt' } as FileEntry,
    signal: controller.signal,
    viewport,
    prefs: { ...defaults },
    changed: vi.fn(),
    error: vi.fn(),
  }
  const reader = new TestReader(context)
  reader.show()
  const operation = reader.configure({ ...defaults, fontSize: 26 })
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(draw).toBeTypeOf('function'))
  controller.abort(); reader.destroy()
  viewport.textContent = '新书正文'; viewport.scrollTop = 120
  draw!(0)
  await rejected
  expect(viewport.textContent).toBe('新书正文')
  expect(viewport.scrollTop).toBe(120)
  expect(context.changed).not.toHaveBeenCalled()
})

it('图片重排已排队时翻页，迟到布局不能把读者拉回上一页', async () => {
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  class Pages extends FlowReader {
    readonly format = 'epub'
    protected async prepare() { this.sections = [{ label: '纯图片章节' }] }
    protected async content() { return document.createDocumentFragment() }
    imageChanged() { this.layout(() => {}) }
  }
  const viewport = document.createElement('main'); document.body.append(viewport)
  const reader = new Pages({ drive: {} as Drive, file: { name: '图片.epub' } as FileEntry, signal: new AbortController().signal,
    viewport, prefs: { ...defaults, mode: 'page' }, changed: vi.fn(), error: vi.fn() })
  const draw = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) }
  async function finish(operation: Promise<void>) {
    let finished = false
    void operation.then(() => { finished = true }, () => { finished = true })
    await vi.waitFor(() => { draw(); expect(finished).toBe(true) }, { interval: 1 })
    await operation
  }
  try {
    await finish(reader.open())
    const pager = viewport.querySelector<HTMLElement>('.flow-pages')!
    Object.defineProperties(pager, { clientWidth: { value: 400 }, scrollWidth: { value: 1248 } })
    const turning = reader.turn(1)
    reader.imageChanged(); draw()
    await finish(turning)
    await Promise.resolve(); await Promise.resolve(); draw()
    expect(reader.navigationState().pageIndex).toBe(1)
    expect(reader.current().ratio).toBe(.5)
  } finally { reader.destroy() }
})

it('最后一章顶部不等于读完，正文尾部进入视口即结束，不必再滚一屏人工留白', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  class Sections extends FlowReader {
    readonly format = 'txt'
    protected async prepare() { this.sections = [{ label: '第一章' }, { label: '末章' }] }
    protected async content() { return document.createDocumentFragment() }
    setHeight(height: number) {
      this.article.getBoundingClientRect = () => ({ top: -this.context.viewport.scrollTop, bottom: height + 600 - this.context.viewport.scrollTop, width: 400, height: height + 600, left: 0, right: 400 }) as DOMRect
    }
  }
  const viewport = document.createElement('main'); document.body.append(viewport)
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400, width: 400, height: 600 }) as DOMRect
  Object.defineProperties(viewport, { clientWidth: { value: 400 }, clientHeight: { value: 600 }, scrollHeight: { value: 1500 } })
  const reader = new Sections({ drive: {} as Drive, file: { name: '末端.txt' } as FileEntry, viewport, signal: new AbortController().signal, prefs: defaults, changed: vi.fn(), error: vi.fn() })
  try {
    await reader.open(); reader.setHeight(900)
    viewport.scrollTop = 900; expect(reader.navigationState().atEnd).toBe(false)
    await reader.go(1)
    expect(reader.navigationState()).toMatchObject({ canNext: false, atEnd: false })
    viewport.scrollTop = 298; expect(reader.navigationState().atEnd).toBe(false)
    viewport.scrollTop = 301; expect(reader.navigationState().atEnd).toBe(true)
    expect(viewport.scrollTop).toBeLessThan(viewport.scrollHeight - viewport.clientHeight)
    reader.destroy(); expect(reader.navigationState().atEnd).toBe(false)
  } finally { reader.destroy() }
})

it('分页只有最后内容单元的最后一列才是末端，可见图片未解码时不提前完成', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  class Images extends FlowReader {
    readonly format = 'epub'
    protected async prepare() { this.sections = [{ label: '图片章节' }] }
    protected async content() { return document.createDocumentFragment() }
    image() { const image = document.createElement('img'); image.dataset.resource = '尾图'; this.article.append(image); return image }
  }
  const viewport = document.createElement('main'); document.body.append(viewport)
  const reader = new Images({ drive: {} as Drive, file: { name: '末端.epub' } as FileEntry, viewport, signal: new AbortController().signal, prefs: { ...defaults, mode: 'page' }, changed: vi.fn(), error: vi.fn() })
  try {
    await reader.open()
    const pager = viewport.querySelector<HTMLElement>('.flow-pages')!
    Object.defineProperties(pager, { clientWidth: { value: 400 }, scrollWidth: { value: 1248 } })
    expect(reader.navigationState().atEnd).toBe(false)
    await reader.turn(1); expect(reader.navigationState().atEnd).toBe(false)
    await reader.turn(1); expect(reader.navigationState().atEnd).toBe(true)
    const image = reader.image()
    expect(reader.navigationState().atEnd).toBe(false)
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 10 } })
    expect(reader.navigationState().atEnd).toBe(true)
  } finally { reader.destroy() }
})
