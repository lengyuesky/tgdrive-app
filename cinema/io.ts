import type { Drive, FileEntry } from '../sdk/types'
import { createTransport } from '../reader/io'

export const MiB = 1024 * 1024
export function abortError() { return new DOMException('读取已取消', 'AbortError') }
export function isAbort(error: unknown) { return (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'InputDisposedError' }
export function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', stop); resolve() }
    const timer = setTimeout(done, ms)
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(abortError()) }
    signal.addEventListener('abort', stop, { once: true })
  })
}
/** 全应用共享读取节奏，确保四并发及每秒八次上限，不挤占宿主控制消息。 */
export class ReadScheduler {
  private active = 0
  private starts: number[] = []
  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (true) {
      signal.throwIfAborted()
      const now = Date.now()
      this.starts = this.starts.filter(t => now - t < 1000)
      if (this.active < 4 && this.starts.length < 8) break
      await delay(30, signal)
    }
    this.active++; this.starts.push(Date.now())
    try { return await work() } finally { this.active-- }
  }
}
/** 对齐块缓存由所有容器和字幕读取共享；跨文件实例按退出生命周期释放。 */
export class RangeFile {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private readBytes = 0
  private allowance = 16 * MiB
  private readonly transport
  constructor(readonly drive: Drive, readonly file: FileEntry, readonly signal: AbortSignal, readonly scheduler: ReadScheduler) {
    this.transport = createTransport(drive)
  }
  setBudget(bytes: number = Infinity) { this.readBytes = 0; this.allowance = bytes }
  clear() { this.cache.clear(); this.pending.clear() }
  private async block(index: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); return cached }
    const pending = this.pending.get(index)
    if (pending) return pending
    const offset = index * MiB, length = Math.min(MiB, this.file.size - offset)
    if (length <= 0 || this.readBytes + length > this.allowance) throw new Error('容器头或索引读取超过 16 MiB，已停止扫描；请下载原文件播放')
    this.readBytes += length
    const task = this.scheduler.run(() => this.transport.read({ id: this.file.id, content_version: this.file.content_version }, offset, length, this.signal), this.signal).then(bytes => {
      this.signal.throwIfAborted()
      if (bytes.length !== length) throw new Error('视频范围响应不完整，请重试')
      if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(index, bytes)
      return bytes
    }).finally(() => this.pending.delete(index))
    this.pending.set(index, task)
    return task
  }
  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.file.size || end - start > 16 * MiB) throw new Error('读取范围无效或超过 16 MiB')
    const result = new Uint8Array(end - start)
    for (let offset = start; offset < end;) {
      const bytes = await this.block(Math.floor(offset / MiB)), within = offset % MiB, size = Math.min(end - offset, bytes.length - within)
      result.set(bytes.subarray(within, within + size), offset - start); offset += size
    }
    return result
  }
  stream(start: number, end: number) {
    let offset = start
    return new ReadableStream<Uint8Array>({ pull: async controller => {
      try {
        if (offset >= end) { controller.close(); return }
        const next = Math.min(end, offset + MiB)
        controller.enqueue(await this.read(offset, next)); offset = next
      } catch (error) { controller.error(error) }
    } }, { highWaterMark: 0 })
  }
}
