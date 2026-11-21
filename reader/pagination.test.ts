import { expect, it, vi } from 'vitest'
import { pageCount, PAGE_GAP, revealRect } from './view'
import { PictureWindow } from './pictures'
it('按真实列宽计算页数，末页舍入误差不产生空白页', () => {
  expect(pageCount(0, 390)).toBe(1)
  expect(pageCount(390, 390)).toBe(1)
  expect(pageCount(390 + 414 * 3, 390)).toBe(4)
  expect(pageCount(390 + 414 * 3 + 1, 390)).toBe(4)
  expect(pageCount(390 + 414 * 3 + 2, 390)).toBe(5)
  expect(PAGE_GAP).toBe(24)
})
it('分页锚点按横轴恢复，不把相同纵坐标的后续页当成首页', () => {
  const viewport = document.createElement('main')
  viewport.scrollLeft = 0
  revealRect({ left: 860, top: 20 } as DOMRect, viewport, 414)
  expect(viewport.scrollLeft).toBe(828)
  revealRect({ left: -814, top: 200 } as DOMRect, viewport, 414)
  expect(viewport.scrollLeft).toBe(0)
})
it('二维图片窗口不会读取同一纵坐标上远离当前页的图片', async () => {
  let draw: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { draw = callback; return 1 })
  const viewport = document.createElement('main'), root = document.createElement('article')
  viewport.append(root); document.body.append(viewport)
  const rect = (left: number) => ({ x: left, y: 0, left, right: left + 100, top: 0, bottom: 200, width: 100, height: 200 }) as DOMRect
  for (const [id, left] of [['远处', 6000], ['当前', 20], ['相邻', 1100]] as const) {
    const image = document.createElement('img'); image.dataset.resource = id
    image.getBoundingClientRect = () => rect(left); root.append(image)
  }
  const read = vi.fn((_image: HTMLImageElement, signal: AbortSignal) => new Promise<Uint8Array<ArrayBuffer>>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true })))
  const pictures = new PictureWindow(viewport, root, new AbortController().signal, read, vi.fn())
  try {
    draw!(0)
    expect(read.mock.calls.map(([image]) => image.dataset.resource)).toEqual(['当前', '相邻'])
  } finally { pictures.destroy(); await Promise.resolve(); viewport.remove(); vi.unstubAllGlobals() }
})
