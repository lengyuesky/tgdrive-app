import { LIMITS, UI_CHANNEL } from '../../contract/types/contract.js'
import type * as C from '../../contract/types/contract.js'
import { validateUiRequest } from './input.js'
import { wireValue } from './wire.js'
import { HostError, SdkError } from './error.js'
import type { BeforeCloseHandler, NoticeListener, PageContext, RequestOptions } from './types.js'

export class PageUi {
  private sequence = 0
  private readonly pending = new Map<string, { resolve: (value: C.UiValue) => void; reject: (error: unknown) => void; cleanup: () => void }>()
  private readonly listeners = new Set<NoticeListener>()
  private readonly closeHandlers = new Set<BeforeCloseHandler>()
  private dialog = false
  private closed = false
  private readonly receive: (event: MessageEvent) => void
  constructor(private readonly frame: Window, private readonly context: PageContext) {
    this.receive = event => {
      if (event.source !== frame.parent || event.origin !== context.host_origin || !event.data || typeof event.data !== 'object') return
      const incoming = event.data as C.UiMessage
      if (incoming.channel !== UI_CHANNEL || incoming.nonce !== context.ui_nonce) return
      let message: C.UiMessage
      try { message = wireValue('UiMessage', incoming) } catch { return }
      if (message.type === 'response') {
        const request = this.pending.get(message.id)
        if (!request || !message.result || !['ok', 'error'].includes(message.result.status)) return
        this.pending.delete(message.id); request.cleanup()
        if (message.result.status === 'error') request.reject(new HostError(0, message.result.error))
        else request.resolve(message.result.value)
      } else if (message.type === 'notice' && message.notice && typeof message.notice === 'object') {
        for (const listener of this.listeners) void Promise.resolve().then(() => listener(message.notice)).catch(() => {})
        if (message.notice.event === 'ui.before_close') void this.beforeCloseNotice(message.notice.data)
      }
    }
    frame.addEventListener('message', this.receive)
  }

  async request(request: C.UiRequest, options: RequestOptions = {}): Promise<C.UiValue> {
    if (this.closed) throw new SdkError('界面通道已关闭')
    options.signal?.throwIfAborted()
    validateUiRequest(request)
    if (this.pending.size >= LIMITS.MAX_UI_REQUESTS) throw new SdkError('待应答界面请求已达上限')
    const dialog = ['ui.pick_directory', 'ui.request_scope'].includes(request.method)
    if (dialog && this.dialog) throw new SdkError('同一时间只能打开一个目录或授权窗口')
    if (dialog) this.dialog = true
    const id = `ui-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (dialog) this.dialog = false }
      const cancel = (error: unknown) => { this.pending.delete(id); cleanup(); reject(error) }
      const abort = () => cancel(options.signal?.reason)
      const timer = setTimeout(() => cancel(new SdkError('界面请求超时')), LIMITS.UI_TIMEOUT_SECONDS * 1000)
      this.pending.set(id, { resolve, reject, cleanup })
      options.signal?.addEventListener('abort', abort, { once: true })
      const message: C.UiMessage = { type: 'request', channel: UI_CHANNEL, nonce: this.context.ui_nonce, id, request }
      try { this.frame.parent.postMessage(message, this.context.host_origin) } catch { cancel(new SdkError('界面消息发送失败')) }
    })
  }
  async setImmersive(params: C.ImmersiveRequest, options?: RequestOptions): Promise<void> { await this.ack({ method: 'ui.set_immersive', params }, options) }
  async setTitle(params: C.TitleRequest, options?: RequestOptions): Promise<void> { await this.ack({ method: 'ui.set_title', params }, options) }
  async pickDirectory(params: C.PickDirectoryRequest, options?: RequestOptions): Promise<C.FileNode | null> {
    const value = await this.request({ method: 'ui.pick_directory', params }, options)
    if (value.type !== 'directory') throw new SdkError('目录选择响应无效')
    return value.directory
  }
  async requestScope(params: C.ScopeAuthorizationRequest, options?: RequestOptions): Promise<C.ScopeInfo | null> {
    const value = await this.request({ method: 'ui.request_scope', params }, options)
    if (value.type !== 'authorization') throw new SdkError('目录授权响应无效')
    return value.scope
  }
  async task(params: C.TaskProgress, options?: RequestOptions): Promise<void> { await this.ack({ method: 'ui.task', params }, options) }
  async close(options?: RequestOptions): Promise<void> { await this.ack({ method: 'ui.close' }, options) }
  async closedAck(closeId: string, options?: RequestOptions): Promise<void> { await this.ack({ method: 'ui.closed', params: { close_id: closeId } }, options) }
  onNotice(listener: NoticeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  beforeClose(handler: BeforeCloseHandler): () => void { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler) }
  dispose(): void {
    this.closed = true; this.frame.removeEventListener('message', this.receive)
    for (const request of this.pending.values()) { request.cleanup(); request.reject(new SdkError('界面通道已关闭')) }
    this.pending.clear(); this.listeners.clear(); this.closeHandlers.clear()
  }
  private async ack(request: C.UiRequest, options?: RequestOptions): Promise<void> {
    const value = await this.request(request, options)
    if (value.type !== 'acknowledged') throw new SdkError('界面应答类型无效')
  }
  private async beforeCloseNotice(notice: { close_id: string; deadline_ms: number }): Promise<void> {
    if (typeof notice.close_id !== 'string' || !Number.isSafeInteger(notice.deadline_ms) || notice.deadline_ms < 0) return
    const signal = AbortSignal.timeout(Math.min(notice.deadline_ms, LIMITS.UI_CLOSE_GRACE_MILLIS))
    const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    await Promise.race([Promise.allSettled([...this.closeHandlers].map(handler => Promise.resolve().then(() => handler(signal)))), aborted])
    if (!signal.aborted && !this.closed) await this.closedAck(notice.close_id).catch(() => {})
  }
}
