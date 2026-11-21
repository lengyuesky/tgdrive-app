import type { PageUi } from '@tgdrive/page-sdk'
import type { ImmersiveRequest } from '@tgdrive/page-sdk/contract'
export type { ImmersiveRequest } from '@tgdrive/page-sdk/contract'

/** 手机与触屏设备：打开即请求宿主沉浸，隐藏宿主外壳，保留应用自己的返回入口。 */
export const MOBILE_QUERY = '(max-width: 768px), (pointer: coarse)'
/** 与共享 ui/base.css 的 --tg-bg 保持一致，宿主只接受六位十六进制色。 */
export const THEME_BACKGROUND = { light: '#f2f2f7', dark: '#000000' } as const
export const PLAYER_BACKGROUND = '#000000'
export interface ShellState { mobile: boolean; playing: boolean; dark: boolean }
export function immersiveRequest(state: ShellState): ImmersiveRequest {
  return { active: state.mobile || state.playing, background: state.playing ? PLAYER_BACKGROUND : state.dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light }
}
export function applyTheme(root: HTMLElement, dark: boolean) { root.classList.toggle('dark', dark); root.style.colorScheme = dark ? 'dark' : 'light' }

/** 合并页面外观状态的变化顺序；HTTP 请求调度仍完全属于 SDK。 */
export class ImmersiveSync {
  private applied: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  constructor(private ui: Pick<PageUi, 'setImmersive'>, private error: (error: unknown) => void = () => {}) {}
  update(state: ShellState) { return this.disposed ? this.queue : this.send(immersiveRequest(state)) }
  dispose() {
    if (this.disposed) return this.queue
    const pending = this.send({ active: false }); this.disposed = true; return pending
  }
  private send(request: ImmersiveRequest) {
    const key = JSON.stringify(request)
    if (key === this.applied) return this.queue
    this.applied = key
    this.queue = this.queue.then(() => this.ui.setImmersive(request)).catch(error => { if (this.applied === key) this.applied = null; this.error(error) })
    return this.queue
  }
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }
export type FullscreenMethod = 'native-video' | 'element' | 'page'
/** 手机优先原生视频全屏，其次元素全屏，最后页面沉浸；桌面保持自定义控件优先。 */
export function fullscreenOrder(video: FullscreenVideo, element: HTMLElement, mobile: boolean): FullscreenMethod[] {
  const native = typeof video.webkitEnterFullscreen === 'function' && video.readyState > 0
  const standard = typeof element.requestFullscreen === 'function'
  const order: FullscreenMethod[] = []
  if (mobile && native) order.push('native-video')
  if (standard) order.push('element')
  if (!mobile && native) order.push('native-video')
  order.push('page'); return order
}
