/** 网盘 Range 适配、共享并发队列、数据面票据传输和有界块缓存。 */
import type { ByteGrant, Drive, FileEntry, Ref } from '../sdk/types'
export const MiB = 1024 * 1024
export const LIMITS = { txt: 64 * MiB, epub: 512 * MiB, pdf: 512 * MiB, archive: 2048 * MiB, entry: 32 * MiB, markup: 8 * MiB, entries: 10000, expanded: 2048 * MiB, pixels: 32_000_000 }
export const abortError = () => new DOMException('读取已取消', 'AbortError')
export const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'
export class Gate {
  private active = 0
  private waiting: { run: () => void; signal: AbortSignal; cancel: () => void }[] = []
  constructor(private readonly limit = 3) {}
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const job = { signal, run: () => {
        signal.removeEventListener('abort', job.cancel)
        if (signal.aborted) { reject(abortError()); this.pump(); return }
        this.active++
        Promise.resolve().then(work).then(resolve, reject).finally(() => { this.active--; this.pump() })
      }, cancel: () => { this.waiting = this.waiting.filter((item) => item !== job); reject(abortError()) } }
      if (signal.aborted) { reject(abortError()); return }
      this.waiting.push(job); signal.addEventListener('abort', job.cancel, { once: true }); this.pump()
    })
  }
  private pump() { while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.run() }
}
/** 消息通道读取共事 3 路并发；数据面票据直连更轻量，放宽到 4。 */
export const gate = new Gate(3)
export const byteGate = new Gate(4)

export interface RangeTransport {
  /** 读取一段字节；实现必须校验状态、Content-Range 与长度一致。 */
  read(ref: Ref, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
}

/** 严格校验 206 与 Content-Range，防止半截响应进入解码器。 */
async function exactRangeBytes(response: Response, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const fail = async (text: string): Promise<never> => { await response.body?.cancel().catch(() => {}); throw new Error(text) }
  if (response.status !== 206) return fail(`文件范围读取失败（${response.status}），请重试`)
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  const declared = Number(response.headers.get('Content-Length'))
  if (!match || Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1 || declared !== length) {
    return fail('服务未正确返回请求范围，已停止读取以避免下载整个文件')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('文件响应缺少内容')
  const result = new Uint8Array(length)
  let written = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (written + value.length > length) throw new Error('文件响应超过声明大小')
      result.set(value, written); written += value.length
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (written !== length) throw new Error('文件响应提前结束，请重试')
  return result
}

/** 字节数据面：凭票据直连 Range 读取；票据过期自动重签一次。 */
export class ByteTicketTransport implements RangeTransport {
  private tickets = new Map<string, { url: string; expiresAt: number }>()
  constructor(private readonly drive: Drive) {}
  private ticketUrl(ref: Ref, signal: AbortSignal): Promise<string> {
    const key = `${ref.id}:${ref.content_version}`
    const hit = this.tickets.get(key)
    if (hit && hit.expiresAt - 60 > Date.now() / 1000) return Promise.resolve(hit.url)
    return this.drive.media.bytes(ref, { signal }).then((grant: ByteGrant) => {
      if (typeof grant?.url !== 'string' || !/^\/api\/apps\/media\/[A-Za-z0-9_.-]+$/.test(grant.url)) throw new Error('文件票据地址无效')
      const entry = { url: grant.url, expiresAt: Number(grant.expires_at) || 0 }
      if (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!)
      this.tickets.set(key, entry)
      return entry.url
    })
  }
  async read(ref: Ref, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const attempt = async (refreshed: boolean): Promise<Uint8Array<ArrayBuffer>> => {
      const url = await this.ticketUrl(ref, signal)
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
      if (response.status === 403 && !refreshed) {
        await response.body?.cancel().catch(() => {})
        this.tickets.delete(`${ref.id}:${ref.content_version}`)
        return attempt(true)
      }
      return exactRangeBytes(response, offset, length, signal)
    }
    return attempt(false)
  }
}

/** 控制面降级：旧宿主未声明数据面能力时走消息通道逐段读取。 */
export class MessageChannelTransport implements RangeTransport {
  constructor(private readonly drive: Drive) {}
  read(ref: Ref, offset: number, length: number, signal: AbortSignal) {
    return this.drive.files.readRange(ref, offset, length, { signal })
  }
}

/** 等待共享分块任务；调用者中止只放弃本次等待，任务照常完成并进入缓存。 */
function waitBlock(task: Promise<Uint8Array<ArrayBuffer>>, caller: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const settle = (action: () => void) => { caller.removeEventListener('abort', onAbort); action() }
    const onAbort = () => settle(() => reject(caller.reason ?? new DOMException('已中止', 'AbortError')))
    caller.addEventListener('abort', onAbort, { once: true })
    task.then((bytes) => settle(() => resolve(bytes)), (error) => settle(() => reject(error)))
  })
}
export function createTransport(drive: Drive): RangeTransport {
  const can = (name: string) => typeof drive.can === 'function' && drive.can(name)
  return can('media.bytes') ? new ByteTicketTransport(drive) : new MessageChannelTransport(drive)
}
export class RangeFile {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private controller = new AbortController()
  private readonly transport: RangeTransport
  private readonly runner: Gate
  private readonly ref: Ref
  /** 只有消息通道降级路径才用批量段读缓解限流；数据面票据直连无需批量。 */
  private readonly batchable: boolean
  readonly signal: AbortSignal
  constructor(readonly drive: Drive, readonly file: FileEntry, signal: AbortSignal, maximum: number) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) throw new Error(`文件超过首版 ${maximum / MiB} MiB 上限`)
    this.signal = AbortSignal.any([signal, this.controller.signal])
    this.ref = { id: file.id, content_version: file.content_version }
    const can = (name: string) => typeof drive.can === 'function' && drive.can(name)
    this.transport = createTransport(drive)
    this.runner = can('media.bytes') ? byteGate : gate
    this.batchable = !can('media.bytes') && can('files.readRanges')
  }
  private block(index: number, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted(); caller?.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); return Promise.resolve(cached) }
    const existing = this.pending.get(index)
    if (existing) return caller ? waitBlock(existing, caller) : existing
    const offset = index * MiB
    const length = Math.min(MiB, this.file.size - offset)
    // 在途分块对所有读者共享，fetch 只绑定文件级信号：并发读同一分块（压缩包整图
    // 读取、头部探测、条漫多页预读）不再各自重复下载；调用者中止仅放弃本次等待。
    const task = this.runner.run(this.signal, () => this.transport.read(this.ref, offset, length, this.signal))
      .then((bytes) => {
        this.signal.throwIfAborted()
        if (bytes.length !== length) throw new Error('文件分块长度不一致')
        while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(index, bytes); return bytes
      }).finally(() => { if (this.pending.get(index) === task) this.pending.delete(index) })
    this.pending.set(index, task)
    return caller ? waitBlock(task, caller) : task
  }
  /** 一次 RPC 拉回多段，避免逐段往返触发限流；单批最多 8 段。 */
  private async loadBlocks(indices: number[], caller?: AbortSignal): Promise<void> {
    const signal = caller ? AbortSignal.any([this.signal, caller]) : this.signal
    signal.throwIfAborted()
    if (!this.batchable || indices.length < 2) return
    const missing = indices.filter((index) => !this.cache.has(index) && !this.pending.has(index)).slice(0, 8)
    if (missing.length < 2) return
    const ranges = missing.map((index) => {
      const offset = index * MiB
      return { offset, length: Math.min(MiB, this.file.size - offset) }
    })
    const blocks = await this.runner.run(signal, () => this.drive.files.readRanges(this.ref, ranges, { signal }))
    signal.throwIfAborted()
    if (!Array.isArray(blocks) || blocks.length !== missing.length) throw new Error('文件分块批量响应不完整')
    for (let i = 0; i < missing.length; i++) {
      const bytes = blocks[i]
      const length = ranges[i].length
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('文件分块长度不一致')
      while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(missing[i], bytes)
    }
  }
  async read(offset: number, length: number, maximum = LIMITS.entry, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted(); caller?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > maximum || offset + length > this.file.size) throw new Error('文件读取范围越界或过大')
    const touched: number[] = []
    for (let position = offset; position < offset + length; position += MiB) {
      const index = Math.floor(position / MiB)
      if (touched.at(-1) !== index) touched.push(index)
    }
    await this.loadBlocks(touched, caller)
    const result = new Uint8Array(length)
    let written = 0
    while (written < length) {
      const position = offset + written
      const bytes = await this.block(Math.floor(position / MiB), caller)
      const part = bytes.subarray(position % MiB, Math.min(bytes.length, position % MiB + length - written))
      result.set(part, written); written += part.length
    }
    return result
  }
  destroy() { this.controller.abort(); this.cache.clear(); this.pending.clear() }
}
export function extension(name: string) { return name.split('.').pop()?.toLowerCase() ?? '' }
export const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']
export const isImage = (name: string) => imageExtensions.includes(extension(name))
export function natural(a: string, b: string) {
  const aa = a.normalize('NFC').toLowerCase().match(/\d+|\D+/g) ?? []
  const bb = b.normalize('NFC').toLowerCase().match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    let x = aa[i]!, y = bb[i]!
    if (/^\d/.test(x) && /^\d/.test(y)) {
      x = x.replace(/^0+(?=\d)/, ''); y = y.replace(/^0+(?=\d)/, '')
      if (x.length !== y.length) return x.length - y.length
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return aa.length - bb.length || (a < b ? -1 : a > b ? 1 : 0)
}
