/** 不覆盖正文的点击层，不拦截纵向滚动、选字、链接和双指缩放。 */
interface GestureOptions {
  enabled: () => boolean
  paged: () => boolean
  controls: () => boolean
  toggle: () => void
  turn: (delta: -1 | 1) => void
}
const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('a,button,input,select,textarea,[role="link"],[contenteditable="true"],.flow-block-scroll')
export class ReadingGestures {
  private pointers = new Set<number>()
  private start?: { id: number; x: number; y: number; at: number; top: number; left: number; moved: number }
  constructor(private viewport: HTMLElement, private options: GestureOptions) {
    viewport.addEventListener('pointerdown', this.down)
    viewport.addEventListener('pointermove', this.move)
    viewport.addEventListener('pointerup', this.up)
    viewport.addEventListener('pointercancel', this.cancel)
  }
  private selected() { return !!window.getSelection()?.toString() }
  private down = (event: PointerEvent) => {
    this.pointers.add(event.pointerId)
    if (this.pointers.size !== 1 || event.button !== 0 || !this.options.enabled() || this.selected() || interactive(event.target)) { this.start = undefined; return }
    this.start = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), top: this.viewport.scrollTop, left: this.viewport.scrollLeft, moved: 0 }
  }
  private move = (event: PointerEvent) => {
    if (this.start?.id === event.pointerId) this.start.moved = Math.max(this.start.moved, Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y))
  }
  private up = (event: PointerEvent) => {
    const start = this.start
    this.start = undefined; this.pointers.delete(event.pointerId)
    if (!start || start.id !== event.pointerId || this.pointers.size || !this.options.enabled() || this.selected() || interactive(event.target) || (window.visualViewport?.scale ?? 1) > 1.01) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y, elapsed = performance.now() - start.at
    if (this.options.paged() && !this.options.controls() && elapsed < 1000 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      event.preventDefault(); this.options.turn(dx < 0 ? 1 : -1); return
    }
    if (elapsed > 350 || Math.max(start.moved, Math.hypot(dx, dy)) > 10 || Math.abs(start.top - this.viewport.scrollTop) > 2 || Math.abs(start.left - this.viewport.scrollLeft) > 2) return
    const box = this.viewport.getBoundingClientRect(), x = (event.clientX - box.left) / Math.max(1, box.width)
    if (this.options.controls() || x >= .25 && x <= .75) { event.preventDefault(); this.options.toggle() }
    else if (this.options.paged()) { event.preventDefault(); this.options.turn(x < .25 ? -1 : 1) }
  }
  private cancel = (event: PointerEvent) => { this.pointers.delete(event.pointerId); this.start = undefined }
  destroy() {
    this.viewport.removeEventListener('pointerdown', this.down); this.viewport.removeEventListener('pointermove', this.move)
    this.viewport.removeEventListener('pointerup', this.up); this.viewport.removeEventListener('pointercancel', this.cancel)
    this.pointers.clear(); this.start = undefined
  }
}
