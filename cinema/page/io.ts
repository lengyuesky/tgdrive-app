import type { HostClient } from '@tgdrive/page-sdk'
import type { FileNode } from '@tgdrive/page-sdk/contract'
import { contentRef, fileSize } from './model'

export const MiB = 1024 * 1024
export function abortError() { return new DOMException('读取已取消', 'AbortError') }
export function isAbort(error: unknown) { return (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'InputDisposedError' }
export function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(abortError()) }
    signal.addEventListener('abort', stop, { once: true })
  })
}
/** 这里只缓存容器解析需要的块；宿主请求调度、Range 校验和取消全部使用页面 SDK。 */
export class RangeFile {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private readBytes = 0
  private allowance = 16 * MiB
  private generation = 0
  readonly size: number
  constructor(readonly host: HostClient, readonly file: FileNode, readonly signal: AbortSignal) { this.size = fileSize(file) }
  setBudget(bytes: number = Infinity) { this.readBytes = 0; this.allowance = bytes }
  clear() { this.generation++; this.cache.clear(); this.pending.clear() }
  private async block(index: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); return cached }
    const pending = this.pending.get(index)
    if (pending) return pending
    const offset = index * MiB, length = Math.min(MiB, this.size - offset), generation = this.generation
    if (length <= 0 || this.readBytes + length > this.allowance) throw new Error('容器头或索引读取超过 16 MiB，已停止扫描；请下载原文件播放')
    this.readBytes += length
    const task = this.host.readRange(contentRef(this.file), { offset: String(offset), length: String(length) }, { signal: this.signal }).then(raw => {
      this.signal.throwIfAborted()
      if (raw.length !== length) throw new Error('视频范围响应不完整，请重试')
      const bytes = new Uint8Array(raw)
      if (generation === this.generation) {
        if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(index, bytes)
      }
      return bytes
    }).finally(() => { if (this.pending.get(index) === task) this.pending.delete(index) })
    this.pending.set(index, task)
    return task
  }
  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.size || end - start > 16 * MiB) throw new Error('读取范围无效或超过 16 MiB')
    const result = new Uint8Array(end - start)
    for (let offset = start; offset < end;) {
      const bytes = await this.block(Math.floor(offset / MiB)), within = offset % MiB, size = Math.min(end - offset, bytes.length - within)
      result.set(bytes.subarray(within, within + size), offset - start); offset += size
    }
    return result
  }
  stream(start: number, end: number) {
    let offset = start, stopped = false
    return new ReadableStream<Uint8Array>({ pull: async controller => {
      try {
        if (stopped || offset >= end) { controller.close(); return }
        const next = Math.min(end, offset + MiB), bytes = await this.read(offset, next)
        if (!stopped) { controller.enqueue(bytes); offset = next }
      } catch (error) { if (!stopped) controller.error(error) }
    }, cancel: () => { stopped = true } }, { highWaterMark: 0 })
  }
}
