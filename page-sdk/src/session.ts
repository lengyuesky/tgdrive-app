import { BOOTSTRAP_FRAGMENT_KEY, CONTRACT_VERSION, LIMITS, SELF_API_BASE } from '../../contract/types/contract.js'
import type { PageBootstrap } from '../../contract/types/contract.js'
import { SdkError, localHostError } from './error.js'
import { decodeJson } from './json.js'
import { wireObject } from './wire.js'
import { endpointPath, readText } from './transport.js'
import type { Transport } from './transport.js'

/** 不在返回上下文中保留令牌；解析失败也先清理片段，防止错误日志/复制地址带出凭据。 */
export function readBootstrap(frame: Window): PageBootstrap {
  const fragment = frame.location.hash.slice(1)
  try { frame.history.replaceState(frame.history.state, '', frame.location.href.split('#')[0]) }
  catch { frame.location.hash = '' }
  const entries = new URLSearchParams(fragment)
  const values = entries.getAll(BOOTSTRAP_FRAGMENT_KEY)
  if (values.length !== 1 || new TextEncoder().encode(fragment).length > LIMITS.MAX_JSON_RESPONSE_BYTES * 2) throw new SdkError('请从应用中心打开此应用')
  const bootstrap = wireObject('PageBootstrap', decodeJson(values[0]))
  if (bootstrap.contract?.major !== CONTRACT_VERSION.major || !Number.isSafeInteger(bootstrap.contract.minor) || bootstrap.contract.minor < 0 || bootstrap.contract.minor > LIMITS.MAX_CONTRACT_VERSION_COMPONENT || !bootstrap.app || typeof bootstrap.app.id !== 'string'
    || typeof bootstrap.session_token !== 'string' || !bootstrap.session_token || !Number.isSafeInteger(bootstrap.expires_at) || bootstrap.expires_at < 0
    || typeof bootstrap.ui_nonce !== 'string' || !bootstrap.ui_nonce || !['light', 'dark'].includes(bootstrap.theme) || !bootstrap.launch || !['browse', 'open'].includes(bootstrap.launch.action)) throw new SdkError('启动上下文无效')
  let origin: URL, api: URL
  try { origin = new URL(bootstrap.host_origin); api = new URL(bootstrap.api_base, origin) } catch { throw new SdkError('启动宿主地址无效') }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== bootstrap.host_origin || origin.username || origin.password
    || api.origin !== origin.origin || api.pathname.replace(/\/$/, '') !== SELF_API_BASE || api.search || api.hash) throw new SdkError('启动宿主地址或能力入口无效')
  if (bootstrap.backend_base) {
    const backend = new URL(bootstrap.backend_base, origin)
    if (backend.origin !== origin.origin || backend.pathname.replace(/\/$/, '') !== endpointPath('backend.proxy', { path: '' }).replace(/\/$/, '') || backend.search || backend.hash) throw new SdkError('应用后端入口无效')
  }
  return bootstrap
}

function abortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    promise.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
  })
}

export class Session {
  #token: string
  #expiresAt: number
  #refreshing?: Promise<void>
  #failure?: unknown
  #timer?: ReturnType<typeof setTimeout>
  #transport?: Transport
  constructor(token: string, expiresAt: number) { this.#token = token; this.#expiresAt = expiresAt }
  attach(transport: Transport): void { this.#transport = transport; this.schedule() }
  async token(signal: AbortSignal, refreshRequest: boolean): Promise<string> {
    signal.throwIfAborted()
    if (this.#failure && !refreshRequest) throw this.#failure
    if (Date.now() >= this.#expiresAt) throw localHostError('session_expired', '应用页面会话已过期，请重新打开')
    if (!refreshRequest && this.#expiresAt - Date.now() <= 60_000) await abortable(this.refresh(), signal)
    signal.throwIfAborted()
    return this.#token
  }
  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    if (!this.#transport) throw new SdkError('会话尚未连接传输器')
    this.#refreshing = (async () => {
      const response = await this.#transport!.request('session.refresh')
      const value = wireObject('SessionRefreshResponse', await readText(response, LIMITS.MAX_JSON_RESPONSE_BYTES))
      if (typeof value.session_token !== 'string' || !value.session_token || !Number.isSafeInteger(value.expires_at) || value.expires_at <= Date.now()) throw new SdkError('宿主续签响应无效')
      this.#transport!.lifetime.signal.throwIfAborted()
      if (value.session_token !== this.#token) throw new SdkError('同一页面续签不得替换会话令牌')
      this.#expiresAt = value.expires_at
      this.#failure = undefined
      this.schedule()
    })().finally(() => { this.#refreshing = undefined })
    return this.#refreshing
  }
  close(): void { clearTimeout(this.#timer); this.#token = ''; this.#failure = new SdkError('应用页面已关闭') }
  private schedule(): void {
    clearTimeout(this.#timer)
    const remaining = this.#expiresAt - Date.now()
    this.#timer = setTimeout(() => { void this.refresh().catch(error => { this.#failure = error }) }, Math.max(0, remaining - Math.min(60_000, remaining / 10)))
  }
}
