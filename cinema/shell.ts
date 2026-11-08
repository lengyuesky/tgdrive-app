import type { Drive, ReadyContext } from '../sdk/types'

/** 手机与触屏设备：打开即请求宿主沉浸，隐藏宿主顶栏，由插件自带顶栏与返回入口。 */
export const MOBILE_QUERY = '(max-width: 768px), (pointer: coarse)'
/** 与 ui/base.css 的 --tg-bg 保持一致；宿主只接受六位十六进制色。 */
export const THEME_BACKGROUND = { light: '#f2f2f7', dark: '#000000' } as const
/** 播放器区域固定黑底，沉浸时安全区同样填黑。 */
export const PLAYER_BACKGROUND = '#000000'

export interface ShellState { mobile: boolean; playing: boolean; dark: boolean }
export interface ImmersiveRequest { active: boolean; background: string }

/** 单一来源计算宿主沉浸状态：手机常驻沉浸，桌面只在播放时沉浸；背景取当前顶栏或播放器底色。 */
export function immersiveRequest(state: ShellState): ImmersiveRequest {
  return {
    active: state.mobile || state.playing,
    background: state.playing ? PLAYER_BACKGROUND : state.dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light,
  }
}

/** 主题跟随主站：根节点切换 dark 类，原生控件同步配色方案。 */
export function applyTheme(root: HTMLElement, dark: boolean) {
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/**
 * 串行同步宿主沉浸状态，避免首页沉浸与播放沉浸两处互相覆盖。
 * 相同请求不重复发送；宿主不支持能力时静默跳过；失败后允许下次重试。
 */
export class ImmersiveSync {
  private applied: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  constructor(private drive: Pick<Drive, 'ui'>, private context: Pick<ReadyContext, 'capabilities'>, private error: (error: unknown) => void = () => {}) {}
  private supported() { return !!this.context.capabilities?.includes('ui.setImmersive') && typeof this.drive.ui?.setImmersive === 'function' }
  update(state: ShellState) {
    if (this.disposed) return this.queue
    return this.send(immersiveRequest(state))
  }
  /** 离开或卸载时恢复宿主顶栏；之后的状态变化不再请求沉浸。 */
  dispose() {
    if (this.disposed) return this.queue
    const pending = this.send({ active: false, background: '' })
    this.disposed = true
    return pending
  }
  private send(request: ImmersiveRequest) {
    if (!this.supported()) return this.queue
    const options = request.active && this.context.capabilities?.includes('ui.immersiveBackground') ? { background: request.background } : undefined
    const key = `${request.active}:${options?.background ?? ''}`
    if (key === this.applied) return this.queue
    this.applied = key
    this.queue = this.queue.then(() => this.drive.ui.setImmersive(request.active, options)).catch(error => {
      if (this.applied === key) this.applied = null
      this.error(error)
    })
    return this.queue
  }
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }
export type FullscreenMethod = 'native-video' | 'element' | 'page'

/**
 * 全屏降级顺序：手机优先 iOS 原生视频全屏（字幕走 TextTrack 仍可显示），
 * 其次标准元素全屏，最后页面沉浸。桌面保持标准全屏优先，保留自定义控件。
 */
export function fullscreenOrder(video: FullscreenVideo, element: HTMLElement, mobile: boolean): FullscreenMethod[] {
  const native = typeof video.webkitEnterFullscreen === 'function' && video.readyState > 0
  const standard = typeof element.requestFullscreen === 'function'
  const order: FullscreenMethod[] = []
  if (mobile && native) order.push('native-video')
  if (standard) order.push('element')
  if (!mobile && native) order.push('native-video')
  order.push('page')
  return order
}
