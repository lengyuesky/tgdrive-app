/** 只解码视口附近的图片，按像素预算回收 Blob URL。 */
import { imageBlob } from './image'
import { isAbort, MiB } from './io'
export const PICTURE_COST_LIMIT = 128 * MiB
export const pictureCost = (width: number, height: number) => width * height * 4
export interface PictureWindowOptions {
  maxVisible?: number
  verticalMargin?: number
  costLimit?: number
  /** 已解码样本未满该值前，按 DOM 顺序把可见图之后的未知图也纳入加载，供占位估高自举（0 为关闭）。 */
  sampleTarget?: number
}
export class PictureWindow {
  private records = new Map<HTMLImageElement, { url: string; cost: number }>()
  private info = new Map<HTMLImageElement, { width: number; height: number }>()
  private active = new Map<HTMLImageElement, AbortController>()
  private failed = new Set<HTMLImageElement>()
  private desired = new Set<HTMLImageElement>()
  private images: HTMLImageElement[]
  private scheduled = false
  private disposed = false
  constructor(private viewport: HTMLElement, root: HTMLElement, private signal: AbortSignal,
    private read: (image: HTMLImageElement, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>, private error: (error: unknown) => void,
    private layout: (mutate: () => void) => void = (mutate) => mutate(),
    private options?: PictureWindowOptions) {
    this.images = [...root.querySelectorAll<HTMLImageElement>('img[data-resource]')]
    viewport.addEventListener('scroll', this.schedule, { passive: true })
    this.schedule()
  }
  update(root: HTMLElement) {
    this.images = [...root.querySelectorAll<HTMLImageElement>('img[data-resource]')]
    const retained = new Set(this.images)
    for (const image of this.records.keys()) if (!retained.has(image)) this.release(image)
    for (const image of this.info.keys()) if (!retained.has(image)) this.info.delete(image)
    for (const image of this.failed) if (!retained.has(image)) this.failed.delete(image)
    for (const [image, controller] of this.active) if (!retained.has(image)) controller.abort()
    this.schedule()
  }
  private schedule = () => {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    requestAnimationFrame(() => { this.scheduled = false; if (!this.disposed) this.refresh() })
  }
  private refresh() {
    if (this.signal.aborted) { this.destroy(); return }
    const box = this.viewport.getBoundingClientRect(), centerX = (box.left + box.right) / 2, centerY = (box.top + box.bottom) / 2
    // 长图中心可能离视口数万像素，但正在显示的部分仍须优先加载并保留解码结果。
    const distance = (rect: DOMRect) => Math.hypot(
      Math.max(rect.left - centerX, centerX - rect.right, 0) / Math.max(1, box.width),
      Math.max(rect.top - centerY, centerY - rect.bottom, 0) / Math.max(1, box.height),
    )
    const vMargin = (this.options?.verticalMargin ?? 1) * box.height
    const maxVisible = this.options?.maxVisible ?? 3
    const limit = this.options?.costLimit ?? PICTURE_COST_LIMIT
    const visible = this.images.map((image) => ({ image, box: image.getBoundingClientRect() }))
      .filter((item) => item.box.bottom >= box.top - vMargin && item.box.top <= box.bottom + vMargin
        && item.box.right >= box.left - box.width && item.box.left <= box.right + box.width)
      .sort((a, b) => distance(a.box) - distance(b.box)).slice(0, maxVisible)
    this.desired.clear()
    let cost = 0
    for (const { image } of visible) {
      const info = this.info.get(image), pixels = info ? pictureCost(info.width, info.height) : 0
      if (cost + pixels > limit) continue
      this.desired.add(image); cost += pixels
    }
    // 自举采样：真实长页会把后续占位页顶出可见余量，样本永远凑不齐、占位估高无法收敛。
    // 样本未满前按 DOM 顺序补载紧随可见图之后的未知图；未知像素成本暂按 0 计，下一轮刷新重新核算。
    const sampleTarget = this.options?.sampleTarget ?? 0
    if (sampleTarget > 0 && this.info.size < sampleTarget) {
      let last = -1
      for (const image of this.desired) last = Math.max(last, this.images.indexOf(image))
      for (let i = last + 1; i < this.images.length && this.info.size < sampleTarget; i++) {
        const image = this.images[i]!
        // 已知尺寸的图无需再采样；在途加载必须重新纳入 desired，避免下一轮刷新被当作滚离而中断。
        if (this.desired.has(image) || this.info.has(image) || this.failed.has(image)
          || Number(image.getAttribute('width')) > 0) continue
        this.desired.add(image)
      }
    }
    for (const image of this.records.keys()) if (!this.desired.has(image)) this.release(image)
    for (const [image, controller] of this.active) if (!this.desired.has(image)) controller.abort()
    for (const image of this.desired) if (!this.records.has(image) && !this.active.has(image) && !this.failed.has(image) && this.active.size < 2) void this.load(image)
  }
  private async load(image: HTMLImageElement) {
    const controller = new AbortController(), signal = AbortSignal.any([this.signal, controller.signal])
    this.active.set(image, controller)
    try {
      const result = imageBlob(await this.read(image, signal))
      signal.throwIfAborted()
      if (this.disposed || !this.desired.has(image)) return
      this.info.set(image, { width: result.width, height: result.height })
      this.layout(() => {
        image.width = result.width; image.height = result.height
        image.style.width = `${result.width}px`; image.style.minHeight = '0'
        image.style.aspectRatio = `${result.width} / ${result.height}`
      })
      this.refresh()
      if (!this.desired.has(image)) return
      const url = URL.createObjectURL(result.blob)
      this.records.set(image, { url, cost: pictureCost(result.width, result.height) })
      image.onerror = () => { this.failed.add(image); this.release(image); this.error(new Error('图片解码失败，可重新打开本章重试')) }
      this.layout(() => { image.src = url })
    } catch (error) {
      if (!isAbort(error) && !this.disposed) { this.failed.add(image); image.alt = '图片读取失败'; this.error(error) }
    } finally { this.active.delete(image); this.schedule() }
  }
  private release(image: HTMLImageElement) {
    const record = this.records.get(image)
    image.onerror = null; image.removeAttribute('src')
    if (record) URL.revokeObjectURL(record.url)
    this.records.delete(image)
  }
  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.viewport.removeEventListener('scroll', this.schedule)
    for (const controller of this.active.values()) controller.abort()
    for (const image of this.records.keys()) this.release(image)
    this.active.clear(); this.info.clear(); this.failed.clear(); this.images = []
  }
}
