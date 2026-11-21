/** 解析器专用有界分块缓存；请求调度、Range 校验、取消与续签直接交给页面 SDK。 */
import type { ContentRef, FileNode, HostClient } from '@tgdrive/page-sdk'
import { byteSize, contentRef } from './files'
export const MiB = 1024 * 1024
export const LIMITS = { txt: 64 * MiB, epub: 512 * MiB, pdf: 512 * MiB, archive: 2048 * MiB, entry: 32 * MiB, markup: 8 * MiB, entries: 10000, expanded: 2048 * MiB, pixels: 32_000_000 }
export const abortError = () => new DOMException('读取已取消', 'AbortError')
export const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

/** 同块读取共享解析缓存；单个读者取消等待不取消其他读者，销毁文件则取消底层请求。 */
function waitBlock(task: Promise<Uint8Array<ArrayBuffer>>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    task.then(bytes => { signal.removeEventListener('abort', abort); resolve(bytes) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
export class RangeFile {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private controller = new AbortController()
  private readonly ref: ContentRef
  readonly signal: AbortSignal
  readonly size: number
  constructor(readonly host: HostClient, readonly file: FileNode, signal: AbortSignal, maximum: number) {
    this.size = byteSize(file, maximum)
    this.ref = contentRef(file)
    this.signal = AbortSignal.any([signal, this.controller.signal])
  }
  private block(index: number, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted(); caller?.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); return Promise.resolve(cached) }
    const existing = this.pending.get(index)
    if (existing) return caller ? waitBlock(existing, caller) : existing
    const offset = index * MiB, length = Math.min(MiB, this.size - offset)
    const task = this.host.readRange(this.ref, { offset: String(offset), length: String(length) }, { signal: this.signal })
      .then(bytes => {
        this.signal.throwIfAborted()
        if (bytes.length !== length) throw new Error('文件分块长度不一致')
        while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
        const block = bytes as Uint8Array<ArrayBuffer>
        this.cache.set(index, block); return block
      }).finally(() => { if (this.pending.get(index) === task) this.pending.delete(index) })
    this.pending.set(index, task)
    return caller ? waitBlock(task, caller) : task
  }
  async read(offset: number, length: number, maximum = LIMITS.entry, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted(); caller?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > maximum || offset + length > this.size) throw new Error('文件读取范围越界或过大')
    const result = new Uint8Array(length)
    let written = 0
    while (written < length) {
      const position = offset + written, bytes = await this.block(Math.floor(position / MiB), caller)
      const part = bytes.subarray(position % MiB, Math.min(bytes.length, position % MiB + length - written))
      if (!part.length) throw new Error('文件读取没有推进')
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
