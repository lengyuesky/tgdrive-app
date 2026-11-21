import { ENDPOINTS, LIMITS } from '../../contract/types/contract.js'
import { HostError, SdkError } from './error.js'
import { wireObject } from './wire.js'

export const JSON_RESPONSE_BUDGET = LIMITS.MAX_JSON_RESPONSE_BYTES

export type Release = () => void
export class Gate {
  private active = 0
  private queue: { start: () => void; fail: (error: unknown) => void }[] = []
  constructor(private limit: number, private readonly maxQueue: number) {}
  setLimit(limit: number): void { this.limit = Math.max(1, Math.floor(limit)); this.drain() }
  acquire(signal: AbortSignal): Promise<Release> {
    signal.throwIfAborted()
    if (this.queue.length >= this.maxQueue) return Promise.reject(new SdkError('SDK 请求队列已满'))
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(task)
        if (index >= 0) this.queue.splice(index, 1)
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      const task = {
        fail: reject,
        start: () => {
          signal.removeEventListener('abort', abort)
          this.active++
          let released = false
          resolve(() => { if (!released) { released = true; this.active--; this.drain() } })
        },
      }
      this.queue.push(task)
      signal.addEventListener('abort', abort, { once: true })
      this.drain()
    })
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!.start()
  }
}

export function endpointPath(name: string, parameters: Record<string, string> = {}): string {
  const spec = ENDPOINTS.find(endpoint => endpoint.name === name)
  if (!spec) throw new SdkError('接口不在契约注册表中')
  let path: string = spec.path
  for (const [key, value] of Object.entries(parameters)) path = path.replace(`{${key}}`, encodeURIComponent(value))
  if (/\{[^}]+\}/.test(path)) throw new SdkError('接口路径参数缺失')
  return path
}

export type SendOptions = { parameters?: Record<string, string>; query?: URLSearchParams; method?: string; headers?: HeadersInit; body?: BodyInit; signal?: AbortSignal; kind?: 'control' | 'bytes' | 'events'; readOnly?: boolean; rawErrors?: boolean; url?: string }

export class Transport {
  readonly lifetime = new AbortController()
  private readonly control = new Gate(LIMITS.PAGE_CONTROL_CONCURRENCY, LIMITS.PAGE_CONTROL_BURST)
  private readonly bytes = new Gate(LIMITS.PAGE_BYTE_CONCURRENCY, LIMITS.PAGE_CONTROL_BURST)
  private readonly events = new Gate(LIMITS.MAX_EVENT_CONNECTIONS_PER_CALLER, LIMITS.MAX_EVENT_CONNECTIONS_PER_CALLER)
  constructor(private readonly origin: string, private readonly fetcher: typeof fetch, private readonly token: (signal: AbortSignal, refreshRequest: boolean) => Promise<string>) {}
  configure(control: number, bytes: number): void {
    this.control.setLimit(Math.min(control, LIMITS.PAGE_CONTROL_CONCURRENCY))
    this.bytes.setLimit(Math.min(bytes, LIMITS.PAGE_BYTE_CONCURRENCY))
  }
  close(): void { this.lifetime.abort(new SdkError('应用页面已关闭')) }

  async request(name: string, options: SendOptions = {}): Promise<Response> {
    const controller = new AbortController()
    const links = [options.signal, this.lifetime.signal].filter((signal): signal is AbortSignal => Boolean(signal))
    const abort = () => controller.abort(links.find(signal => signal.aborted)?.reason)
    for (const signal of links) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }) }
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(new SdkError('宿主请求超时')), LIMITS.CONTROL_TIMEOUT_SECONDS * 1000)
    const cleanup = () => { clearTimeout(timer); for (const signal of links) signal.removeEventListener('abort', abort) }
    const gate = options.kind === 'bytes' ? this.bytes : options.kind === 'events' ? this.events : this.control
    let release: Release | undefined
    try {
      const sessionToken = await this.token(controller.signal, name === 'session.refresh' || name === 'session.close')
      release = await gate.acquire(controller.signal)
      const path = endpointPath(name, options.parameters)
      const url = options.url ?? new URL(path + (options.query?.size ? `?${options.query}` : ''), this.origin).href
      if (new URL(url).origin !== this.origin) throw new SdkError('宿主请求不能跨源')
      const method = options.method ?? ENDPOINTS.find(endpoint => endpoint.name === name)!.methods[0]
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted()
        const headers = new Headers(options.headers)
        try { headers.set('Authorization', `Bearer ${sessionToken}`) } catch { throw new SdkError('应用会话认证头无效') }
        const init: RequestInit & { duplex?: 'half' } = { method, headers, body: options.body, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }
        if (options.body instanceof ReadableStream) init.duplex = 'half'
        let response: Response
        try { response = await this.fetcher(url, init) }
        catch {
          controller.signal.throwIfAborted()
          if (!options.readOnly || attempt >= 2) throw new SdkError('宿主网络请求未能完成')
          await delay(backoff(attempt), controller.signal); continue
        }
        if (!options.rawErrors && !response.ok && response.status !== 304) {
          let error: HostError
          try {
            const object = wireObject('ErrorResponse', await readText(response, LIMITS.MAX_JSON_RESPONSE_BYTES))
            if (!object.error || typeof object.error.code !== 'string' || typeof object.error.message !== 'string' || typeof object.error.request_id !== 'string') throw new SdkError('宿主错误格式无效')
            const retryAfter = retryAfterMillis(response.headers.get('Retry-After'))
            error = new HostError(response.status, { ...object.error, retry_after_ms: object.error.retry_after_ms ?? retryAfter })
          } catch (failure) { throw failure instanceof HostError ? failure : new SdkError('宿主错误响应不是合法协议对象') }
          if (!options.readOnly || attempt >= 2 || !retryable(error) || (error.retryAfterMs ?? 0) >= LIMITS.CONTROL_TIMEOUT_SECONDS * 1000) throw error
          await delay(Math.max(error.retryAfterMs ?? 0, backoff(attempt)), controller.signal)
          continue
        }
        clearTimeout(timer); timer = undefined
        const finish = () => { if (cancelBody) controller.signal.removeEventListener('abort', cancelBody); release?.(); release = undefined; cleanup() }
        let cancelBody: (() => void) | undefined
        if (!response.body) { finish(); return response }
        const reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          start: output => {
            cancelBody = () => { finish(); try { output.error(controller.signal.reason) } catch {} void reader.cancel().catch(() => {}) }
            controller.signal.addEventListener('abort', cancelBody, { once: true })
            if (controller.signal.aborted) cancelBody()
          },
          pull: async output => {
            let idle: ReturnType<typeof setTimeout> | undefined
            try {
              controller.signal.throwIfAborted()
              const result = await Promise.race([
                reader.read(),
                new Promise<never>((_resolve, reject) => { idle = setTimeout(() => { controller.abort(); reject(new SdkError('字节流空闲超时')) }, LIMITS.STREAM_IDLE_TIMEOUT_SECONDS * 1000) }),
              ])
              clearTimeout(idle)
              if (result.done) { output.close(); finish() }
              else output.enqueue(result.value)
            } catch (error) { clearTimeout(idle); output.error(error); finish(); await reader.cancel().catch(() => {}) }
          },
          cancel: async reason => { controller.abort(reason); finish(); await reader.cancel(reason).catch(() => {}) },
        }, { highWaterMark: 0 })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
    } catch (error) { release?.(); cleanup(); throw error }
  }
}

export function backoff(attempt: number): number { return 250 * 2 ** Math.min(attempt, 6) * (1 + Math.random() * 0.25) }
export function retryable(error: HostError): boolean { return [429, 500, 502, 503, 504].includes(error.status) }
function retryAfterMillis(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^[0-9]+$/.test(value)) return Number(value) * 1000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}
export async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export async function readText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > maximum) throw new SdkError('宿主响应超过协议上限')
      text += decoder.decode(value, { stream: true })
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}
