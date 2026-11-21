/** 不覆盖正文的点击层，不拦截纵向滚动、选字、链接和双指缩放。 */
interface GestureOptions {
  enabled: () => boolean
  paged: () => boolean
  controls: () => boolean
  toggle: () => void
  turn: (delta: -1 | 1) => void
  /** 跟手预览；返回 false 时退回松手后判定的普通横滑。 */
  drag?: (dx: number) => boolean
  /** 结束跟手，delta 为 0 表示回弹。 */
  settle?: (delta: -1 | 0 | 1) => void
}
/** 左右边缘起手的横滑留给系统返回手势，不参与翻页。 */
export const EDGE_GUARD = 20
/** 点按翻页区：左右各 30%，中间 40% 唤出菜单。 */
export const TAP_ZONE = .3
const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('a,button,input,select,textarea,[role="link"],[contenteditable="true"],.flow-block-scroll')
export class ReadingGestures {
  private pointers = new Set<number>()
  private start?: { id: number; x: number; y: number; at: number; top: number; left: number; moved: number; firstMoveAt?: number; edge: boolean; dragging?: boolean; lastX: number; lastAt: number; velocity: number }
  constructor(private viewport: HTMLElement, private options: GestureOptions) {
    viewport.addEventListener('pointerdown', this.down)
    viewport.addEventListener('pointermove', this.move)
    viewport.addEventListener('pointerup', this.up)
    viewport.addEventListener('pointercancel', this.cancel)
  }
  private selected() { return !!window.getSelection()?.toString() }
  private down = (event: PointerEvent) => {
    this.pointers.add(event.pointerId)
    if (this.start?.dragging) { this.start.dragging = false; this.options.settle?.(0) }
    if (this.pointers.size !== 1 || event.button !== 0 || !this.options.enabled() || this.selected() || interactive(event.target)) { this.start = undefined; return }
    const box = this.viewport.getBoundingClientRect(), now = performance.now()
    const edge = box.width > EDGE_GUARD * 4 && (event.clientX - box.left < EDGE_GUARD || box.right - event.clientX < EDGE_GUARD)
    this.start = { id: event.pointerId, x: event.clientX, y: event.clientY, at: now, top: this.viewport.scrollTop, left: this.viewport.scrollLeft, moved: 0, edge, lastX: event.clientX, lastAt: now, velocity: 0 }
  }
  private move = (event: PointerEvent) => {
    if (this.start?.id === event.pointerId) {
      this.start.moved = Math.max(this.start.moved, Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y))
      if (this.start.moved > 10) this.start.firstMoveAt ??= performance.now() - this.start.at
      const start = this.start, now = performance.now(), dx = event.clientX - start.x, dy = event.clientY - start.y
      if (now > start.lastAt) { start.velocity = (event.clientX - start.lastX) / (now - start.lastAt); start.lastX = event.clientX; start.lastAt = now }
      if (start.dragging === undefined && start.moved > 10) {
        // 只在一开始判定一次方向：横向为主且不在系统边缘才进入跟手，其余交给原生滚动。
        start.dragging = !start.edge && !!this.options.drag && this.pointers.size === 1 && this.options.enabled() && this.options.paged() && !this.options.controls()
          && !this.selected() && Math.abs(dx) > Math.abs(dy) * 1.2 && (start.firstMoveAt ?? 0) <= 350
          && this.options.drag(dx)
      } else if (start.dragging) {
        if (this.pointers.size > 1 || (window.visualViewport?.scale ?? 1) > 1.01) { start.dragging = false; this.options.settle?.(0); return }
        this.options.drag?.(dx)
      }
    }
  }
  private up = (event: PointerEvent) => {
    const start = this.start
    this.start = undefined; this.pointers.delete(event.pointerId)
    if (start?.dragging && start.id === event.pointerId) {
      const dx = event.clientX - start.x, width = Math.max(1, this.viewport.getBoundingClientRect().width)
      const flick = Math.abs(start.velocity) > .35 && Math.abs(dx) > 24 && Math.sign(start.velocity) === Math.sign(dx)
      event.preventDefault(); this.options.settle?.(Math.abs(dx) > width * .18 || flick ? (dx < 0 ? 1 : -1) : 0)
      return
    }
    if (!start || start.id !== event.pointerId || this.pointers.size || !this.options.enabled() || this.selected() || interactive(event.target) || (window.visualViewport?.scale ?? 1) > 1.01) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y, elapsed = performance.now() - start.at
    // 原生平移或长按后的拖动优先于翻页，不能先判横滑再检查滚动位移。
    if (Math.abs(start.top - this.viewport.scrollTop) > 2 || Math.abs(start.left - this.viewport.scrollLeft) > 2) return
    if (this.options.paged() && !this.options.controls() && !start.edge && elapsed < 1000 && (start.firstMoveAt ?? elapsed) <= 350 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      event.preventDefault(); this.options.turn(dx < 0 ? 1 : -1); return
    }
    if (elapsed > 350 || Math.max(start.moved, Math.hypot(dx, dy)) > 10) return
    const box = this.viewport.getBoundingClientRect(), x = (event.clientX - box.left) / Math.max(1, box.width)
    if (this.options.controls() || x >= TAP_ZONE && x <= 1 - TAP_ZONE) { event.preventDefault(); this.options.toggle() }
    else if (this.options.paged()) { event.preventDefault(); this.options.turn(x < TAP_ZONE ? -1 : 1) }
  }
  private cancel = (event: PointerEvent) => {
    const start = this.start
    this.pointers.delete(event.pointerId); this.start = undefined
    if (start?.dragging) this.options.settle?.(0)
  }
  destroy() {
    this.viewport.removeEventListener('pointerdown', this.down); this.viewport.removeEventListener('pointermove', this.move)
    this.viewport.removeEventListener('pointerup', this.up); this.viewport.removeEventListener('pointercancel', this.cancel)
    if (this.start?.dragging) this.options.settle?.(0)
    this.pointers.clear(); this.start = undefined
  }
}
