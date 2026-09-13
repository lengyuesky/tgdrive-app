/** 网盘 Range 适配、共享并发队列和有界块缓存。 */
import type { Drive, FileEntry } from '../sdk/types'
export const MiB = 1024 * 1024
export const LIMITS = { txt: 64 * MiB, epub: 128 * MiB, pdf: 512 * MiB, archive: 2048 * MiB, entry: 32 * MiB, markup: 8 * MiB, entries: 10000, expanded: 2048 * MiB, pixels: 32_000_000 }
export const abortError = () => new DOMException('读取已取消', 'AbortError')
export const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'
export class Gate {
  private active = 0
  private waiting: { run: () => void; signal: AbortSignal; cancel: () => void }[] = []
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
  private pump() { while (this.active < 3 && this.waiting.length) this.waiting.shift()!.run() }
}
export const gate = new Gate()
export class RangeFile {
  private cache = new Map<number, Uint8Array<ArrayBuffer>>()
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private controller = new AbortController()
  readonly signal: AbortSignal
  constructor(readonly drive: Drive, readonly file: FileEntry, signal: AbortSignal, maximum: number) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) throw new Error(`文件超过首版 ${maximum / MiB} MiB 上限`)
    this.signal = AbortSignal.any([signal, this.controller.signal])
  }
  private block(index: number, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const signal = caller ? AbortSignal.any([this.signal, caller]) : this.signal
    signal.throwIfAborted()
    const cached = this.cache.get(index)
    if (cached) { this.cache.delete(index); this.cache.set(index, cached); return Promise.resolve(cached) }
    const existing = !caller && this.pending.get(index)
    if (existing) return existing
    const offset = index * MiB
    const length = Math.min(MiB, this.file.size - offset)
    const task = gate.run(signal, () => this.drive.files.readRange({ id: this.file.id, content_version: this.file.content_version }, offset, length, { signal }))
      .then((bytes) => {
        signal.throwIfAborted()
        if (bytes.length !== length) throw new Error('文件分块长度不一致')
        while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(index, bytes); return bytes
      }).finally(() => { if (!caller) this.pending.delete(index) })
    if (!caller) this.pending.set(index, task)
    return task
  }
  async read(offset: number, length: number, maximum = LIMITS.entry, caller?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted(); caller?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > maximum || offset + length > this.file.size) throw new Error('文件读取范围越界或过大')
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
