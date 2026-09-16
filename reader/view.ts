/** 各阅读格式共用的位置、界面和设置契约；显示页码不作为持久化位置。 */
import type { Drive, FileEntry } from '../sdk/types'
import type { Location, Preferences, ReaderFit, ReaderFont, ReadingMode } from './state'
export interface Section { label: string; entry?: string }
export interface NavigationItem { label: string; location: Location; depth?: number }
export interface NavigationState {
  sectionIndex: number; sectionCount: number
  pageIndex?: number; pageCount?: number
  canPrevious: boolean; canNext: boolean
  /** 只有正文真实末端可见时为 true；不是已读状态，也不能据此自动跳卷。 */
  atEnd?: boolean
  visiblePages?: readonly number[]
  effectiveMode?: ReadingMode
  layoutNotice?: string
}
export interface ReaderCapabilities {
  modes?: readonly ReadingMode[]
  fonts?: readonly ReaderFont[]
  fontSize?: boolean; lineHeight?: boolean; width?: boolean; margin?: boolean
  fits?: readonly ReaderFit[]; zoomLevels?: readonly number[]; pan?: boolean
  direction?: boolean; spreads?: boolean; thumbnails?: boolean
}
export interface ReaderThumbnail {
  url: string; width: number; height: number
  /** 离开视口、替换图片或关闭目录时释放；取消信号和销毁阅读器也会释放。 */
  release(): void
}
export interface ViewContext {
  drive: Drive; file: FileEntry; viewport: HTMLElement; signal: AbortSignal; prefs: Preferences
  changed: () => void; error: (error: unknown) => void
  navigate?: (work: () => Promise<void>) => Promise<void>
}
export interface ReaderView {
  title: string
  author?: string
  sections: Section[]
  navigation?: NavigationItem[]
  capabilities?: ReaderCapabilities
  /** 详情用独立实例按需读取目录，结束后 destroy；不会打开正文或发布进度。 */
  loadNavigation?(): Promise<NavigationItem[]>
  thumbnail?(index: number, signal: AbortSignal): Promise<ReaderThumbnail>
  pan?(x: number, y: number): void
  open(location?: Location): Promise<void>
  current(): Location
  navigationState(): NavigationState
  turn(delta: -1 | 1): Promise<void>
  go(index: number): Promise<void>
  restore(location: Location): Promise<void>
  configure(prefs: Preferences): Promise<void>
  destroy(): void
}
export const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
export const boundedIndex = (index: number, length: number) => Math.min(Math.max(0, Math.trunc(Number.isFinite(index) ? index : 0)), Math.max(0, length - 1))
export function sectionState(index: number, count: number): NavigationState {
  return { sectionIndex: index, sectionCount: count, canPrevious: index > 0, canNext: index < count - 1 }
}
export function contentSize(viewport: HTMLElement) {
  const style = getComputedStyle(viewport)
  const px = (value: string) => parseFloat(value) || 0
  return { width: Math.max(1, viewport.clientWidth - px(style.paddingLeft) - px(style.paddingRight)), height: Math.max(1, viewport.clientHeight - px(style.paddingTop) - px(style.paddingBottom)) }
}
/** 缩略图编码独立于正文；取消后到达的 toBlob 回调不能创建泄漏的 URL。 */
export function canvasThumbnail(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<ReaderThumbnail> {
  signal.throwIfAborted()
  const width = canvas.width, height = canvas.height
  if (width < 1 || height < 1 || width > 320 || height > 320) return Promise.reject(new Error('阅读缩略图尺寸无效'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('缩略图已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob((blob) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { abort(); return }
        if (!blob) { reject(new Error('浏览器无法生成阅读缩略图')); return }
        try {
          const url = URL.createObjectURL(blob)
          let released = false
          const release = () => {
            if (released) return
            released = true; signal.removeEventListener('abort', release); URL.revokeObjectURL(url)
          }
          signal.addEventListener('abort', release, { once: true })
          if (signal.aborted) { release(); abort(); return }
          resolve({ url, width, height, release })
        } catch (error) { reject(error) }
      }, 'image/png')
    } catch (error) { signal.removeEventListener('abort', abort); reject(error) }
  })
}
export const PAGE_GAP = 24
export function pageCount(scrollWidth: number, width: number, gap = PAGE_GAP) {
  // 容忍布局舍入的一像素误差，不能在末尾制造空白页。
  return Math.max(1, Math.ceil((scrollWidth + gap - 1) / Math.max(1, width + gap)))
}
export function revealRect(rect: DOMRect, viewport: HTMLElement, stride?: number) {
  const box = viewport.getBoundingClientRect()
  if (stride) viewport.scrollLeft = Math.max(0, Math.floor((rect.left - box.left + viewport.scrollLeft + 1) / stride)) * stride
  else viewport.scrollTop += rect.top - box.top - (parseFloat(getComputedStyle(viewport).paddingTop) || 0)
}
const textIndexes = new WeakMap<HTMLElement, { first: ChildNode | null; nodes: { node: Text; start: number; end: number }[]; total: number }>()
/** 横向分页按列序而非 glyph 的纵坐标搜索，字符索引仍为原文 UTF-16 偏移。 */
export function textPosition(root: HTMLElement, viewport: HTMLElement, offset?: number, stride?: number) {
  let index = textIndexes.get(root)
  if (!index || index.first !== root.firstChild) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    index = { first: root.firstChild, nodes: [], total: 0 }
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.length) {
        const start = index.total
        index.total += node.length
        // EPUB 缩进空白通常没有几何框，但仍计入持久化偏移；搜索时跳过它们。
        if (node.data.trim() || /^(pre|break-spaces)/.test(getComputedStyle(node.parentElement!).whiteSpace)) index.nodes.push({ node, start, end: index.total })
      }
    }
    textIndexes.set(root, index)
  }
  const { nodes, total } = index
  if (!total || !nodes.length) return 0
  const rectAt = (offset: number) => {
    let low = 0, high = nodes.length - 1
    while (low < high) { const middle = (low + high) >>> 1; if (nodes[middle]!.end <= offset) low = middle + 1; else high = middle }
    const item = nodes[low]!
    let local = Math.max(0, Math.min(item.node.length - 1, offset - item.start))
    const char = item.node.data.charCodeAt(local)
    if (char >= 0xdc00 && char <= 0xdfff && local > 0) local--
    const length = (item.node.data.codePointAt(local) ?? 0) > 0xffff ? 2 : 1
    const range = document.createRange(); range.setStart(item.node, local); range.setEnd(item.node, Math.min(item.node.length, local + length))
    return range.getBoundingClientRect()
  }
  if (offset !== undefined) {
    const selected = Math.max(0, Math.min(total - 1, offset)), rect = rectAt(selected)
    if (rect.height || rect.width) revealRect(rect, viewport, stride)
    return selected
  }
  const box = viewport.getBoundingClientRect()
  const top = box.top + (parseFloat(getComputedStyle(viewport).paddingTop) || 0)
  const page = stride ? Math.round(viewport.scrollLeft / stride) : 0
  let low = 0, high = total - 1
  while (low < high) {
    const middle = (low + high) >>> 1, rect = rectAt(middle)
    const before = stride
      ? Math.floor((rect.left - box.left + viewport.scrollLeft + 1) / stride) < page
      : rect.bottom <= top
    if ((rect.height || rect.width) && before) low = middle + 1
    else high = middle
  }
  return low
}
