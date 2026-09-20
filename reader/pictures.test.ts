import { afterEach, expect, it, vi } from 'vitest'
import { PictureWindow } from './pictures'

const windows: PictureWindow[] = []
afterEach(() => {
  windows.forEach((pictures) => pictures.destroy()); windows.length = 0
  vi.unstubAllGlobals(); document.body.replaceChildren()
})

it('按图片边缘到视口的距离调度，正在阅读的长图优先于附近短图', () => {
  let draw: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { draw = callback; return 1 })
  const viewport = document.createElement('main'), root = document.createElement('div')
  viewport.append(root); document.body.append(viewport)
  const rect = (top: number, height: number) => ({ x: 0, y: top, left: 0, right: 1000, top, bottom: top + height, width: 1000, height }) as DOMRect
  viewport.getBoundingClientRect = () => rect(0, 600)
  for (const [name, top, height] of [['当前长图', -59_000, 60_000], ['下方短图', 1000, 300]] as const) {
    const image = document.createElement('img'); image.dataset.resource = name
    image.getBoundingClientRect = () => rect(top, height); root.append(image)
  }
  const read = vi.fn((_image: HTMLImageElement, signal: AbortSignal) => new Promise<Uint8Array<ArrayBuffer>>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('读取已取消', 'AbortError')), { once: true })
  }))
  windows.push(new PictureWindow(viewport, root, new AbortController().signal, read, vi.fn(), undefined, { maxVisible: 1, verticalMargin: 2 }))
  draw!(0)
  expect(read.mock.calls.map(([image]) => image.dataset.resource)).toEqual(['当前长图'])
})

it('样本未满 sampleTarget 前按 DOM 顺序自举，被长页顶出余量的占位页也纳入加载', () => {
  let draw: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { draw = callback; return 1 })
  const viewport = document.createElement('main'), root = document.createElement('div')
  viewport.append(root); document.body.append(viewport)
  const rect = (top: number, height: number) => ({ x: 0, y: top, left: 0, right: 1000, top, bottom: top + height, width: 1000, height }) as DOMRect
  viewport.getBoundingClientRect = () => rect(0, 600)
  // 首页是真实长图，把后续占位页顶出垂直余量（2×600=1200）之外；占位二已带尺寸属性，无需再采样。
  const images: [string, number, number, number][] = [['当前长图', -59_000, 60_000, 0], ['占位一', 60_000, 1450, 0], ['占位二', 61_450, 1450, 240]]
  for (const [name, top, height, width] of images) {
    const image = document.createElement('img'); image.dataset.resource = name
    if (width > 0) image.setAttribute('width', String(width))
    image.getBoundingClientRect = () => rect(top, height); root.append(image)
  }
  const read = vi.fn((_image: HTMLImageElement, signal: AbortSignal) => new Promise<Uint8Array<ArrayBuffer>>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('读取已取消', 'AbortError')), { once: true })
  }))
  windows.push(new PictureWindow(viewport, root, new AbortController().signal, read, vi.fn(), undefined, { maxVisible: 5, verticalMargin: 2, sampleTarget: 3 }))
  draw!(0)
  // 可见长图优先；余量外的未知占位页被自举纳入；已带尺寸属性的页不再请求；并发上限仍为 2。
  expect(read.mock.calls.map(([image]) => image.dataset.resource)).toEqual(['当前长图', '占位一'])
})
