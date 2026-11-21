import { vi } from 'vitest'

// Node 25/26 的实验性 localStorage 会覆盖 jsdom，同一测试进程用内存实现隔离。
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
} satisfies Storage)

/** jsdom 没有布局引擎，提供可控尺寸；真实浏览器几何仍需 Playwright 门禁。 */
export let viewportWidth = 1000
export let viewportHeight = 600
const observers = new Set<TestResizeObserver>()
class TestResizeObserver {
  targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) { observers.add(this) }
  observe(target: Element) { this.targets.add(target); this.notify() }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); observers.delete(this) }
  notify() {
    const entries = [...this.targets].map((target) => ({
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [{ inlineSize: target.getBoundingClientRect().width, blockSize: target.getBoundingClientRect().height }],
    } as unknown as ResizeObserverEntry))
    this.callback(entries, this as unknown as ResizeObserver)
  }
}
export function resizeViewport(width: number, height = 600) {
  viewportWidth = width
  viewportHeight = Math.min(720, height)
  for (const observer of observers) observer.notify()
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)
HTMLElement.prototype.getBoundingClientRect = function () {
  const height = this.classList.contains('viewport-header') ? 36 : viewportHeight
  return { x: 0, y: 0, top: 0, left: 0, right: viewportWidth, bottom: height, width: viewportWidth, height, toJSON: () => ({}) }
}
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get() { return (this as HTMLElement).getBoundingClientRect().height } })
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get() { return viewportWidth } })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get() { return (this as HTMLElement).getBoundingClientRect().height } })
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { get() {
  const element = this as HTMLElement
  const space = element.querySelector<HTMLElement>('.virtual-space')
  return space ? parseFloat(space.style.height) + (element.querySelector('.viewport-header') ? 36 : 0) : viewportHeight
} })
HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
  this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? this.scrollTop
  this.dispatchEvent(new Event('scroll'))
}
