/** 只解析有界 ZIP 索引和请求的条目；不写文件系统，不启用 worker/WASM。 */
import { Reader, ZipReader, configure, type Entry, type CreateReadableOptions } from '@zip.js/zip.js/lib/zip-core-native.js'
import { LIMITS, MiB, RangeFile } from './io'
configure({ useWebWorkers: false, chunkSize: 512 * 1024 })
export function archivePath(path: string): string {
  const name = path.normalize('NFC').replace(/\/$/, '')
  if (!name || name.length > 4096 || /^[\\/]|^[A-Za-z]:/.test(name) || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('归档包含不安全路径')
  return name
}
export function relativeResource(base: string, href: string): { path: string; hash: string } {
  if (!href || /^[a-z][a-z0-9+.-]*:|^\/|^\\/i.test(href) || /[\x00-\x1f\x7f\\]/.test(href)) throw new Error('不允许外部或非法资源引用')
  const [rawPath, rawHash = ''] = href.split('#', 2)
  const decoded = decodeURIComponent(rawPath!.split('?')[0]!)
  if (/^[a-z][a-z0-9+.-]*:|^\/|^\\/i.test(decoded) || /[\x00-\x1f\x7f\\]/.test(decoded)) throw new Error('不允许外部或非法资源引用')
  const parts = rawPath ? base.split('/').slice(0, -1) : base.split('/')
  if (rawPath) for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) throw new Error('资源路径越过归档根目录'); parts.pop() }
    else parts.push(part)
  }
  return { path: archivePath(parts.join('/')), hash: decodeURIComponent(rawHash) }
}
class SDKReader extends Reader<RangeFile> {
  constructor(private source: RangeFile) { super(source); this.size = source.file.size }
  readUint8Array(offset: number, length: number) { return this.source.read(offset, Math.min(length, this.size - offset), 8 * MiB) }
  createReadable({ offset = 0, size = this.size - offset, chunkSize = 512 * 1024 }: CreateReadableOptions = {}) {
    const controller = new AbortController()
    let position = 0
    return new ReadableStream<Uint8Array>({
      pull: async (stream) => {
        if (position >= size) { stream.close(); return }
        const data = await this.source.read(offset + position, Math.min(chunkSize, size - position), 8 * MiB, controller.signal)
        position += data.length; stream.enqueue(data)
        if (position >= size) stream.close()
      },
      cancel: () => controller.abort(),
    })
  }
}
export class Archive {
  readonly entries = new Map<string, Entry>()
  private zip: ZipReader<RangeFile>
  constructor(readonly source: RangeFile) { this.zip = new ZipReader(new SDKReader(source), { useWebWorkers: false, strictness: 'strict', filenameValidation: 'strict' }) }
  async open() {
    const size = this.source.file.size
    if (size < 22) throw new Error('不是有效的 ZIP 文件')
    const tail = await this.source.read(Math.max(0, size - 65557), Math.min(size, 65557))
    const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let at = tail.length - 22
    while (at >= 0 && (v.getUint32(at, true) !== 0x06054b50 || at + 22 + v.getUint16(at + 20, true) !== tail.length)) at--
    if (at < 0) throw new Error('归档目录损坏')
    if (v.getUint16(at + 4, true) || v.getUint16(at + 6, true)) throw new Error('不支持分卷归档')
    let count = v.getUint16(at + 10, true), directorySize = v.getUint32(at + 12, true)
    if (count === 65535 || directorySize === 0xffffffff || v.getUint32(at + 16, true) === 0xffffffff) {
      const footer = size - tail.length + at
      if (footer < 20) throw new Error('ZIP64 目录损坏')
      const locator = await this.source.read(footer - 20, 20)
      const l = new DataView(locator.buffer)
      if (l.getUint32(0, true) !== 0x07064b50 || l.getUint32(4, true) !== 0 || l.getUint32(16, true) !== 1) throw new Error('ZIP64 定位信息损坏')
      const offset = Number(l.getBigUint64(8, true))
      const header = await this.source.read(offset, 56)
      const h = new DataView(header.buffer)
      if (h.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 目录损坏')
      count = Number(h.getBigUint64(32, true)); directorySize = Number(h.getBigUint64(40, true))
    }
    if (!Number.isSafeInteger(count) || count > LIMITS.entries || directorySize > 8 * MiB) throw new Error('归档条目超过 10000 个或索引超过 8 MiB')
    let expanded = 0, seen = 0
    for await (const entry of this.zip.getEntriesGenerator()) {
      this.source.signal.throwIfAborted()
      const path = archivePath(entry.filename)
      if (++seen > LIMITS.entries || this.entries.has(path)) throw new Error('归档包含过多或重复条目')
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (entry.encrypted || (mode && ![0o100000, 0o040000].includes(mode))) throw new Error('不支持加密、符号链接或特殊归档条目')
      if (!entry.directory) {
        if (![0, 8].includes(entry.compressionMethod ?? -1) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > LIMITS.entry
          || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 200) throw new Error('归档条目过大、压缩比异常或压缩方式不受支持')
        expanded += entry.uncompressedSize
        if (expanded > LIMITS.expanded) throw new Error('归档解压总量超过 2 GiB')
      }
      this.entries.set(path, entry)
    }
    return this
  }
  async read(path: string, maximum = LIMITS.entry, signal = this.source.signal): Promise<Uint8Array<ArrayBuffer>> {
    this.source.signal.throwIfAborted(); signal.throwIfAborted()
    const entry = this.entries.get(archivePath(path))
    if (!entry || entry.directory || !entry.getData) throw new Error(`归档资源不存在：${path}`)
    if (entry.uncompressedSize > maximum) throw new Error('归档资源超过允许大小')
    const result = new Uint8Array(entry.uncompressedSize)
    let written = 0
    const writer = new WritableStream<Uint8Array>({ write: (chunk) => {
      signal.throwIfAborted()
      if (written + chunk.length > result.length) throw new Error('归档实际解压大小超过声明')
      result.set(chunk, written); written += chunk.length
    } })
    await entry.getData(writer, { checkSignature: true, signal, useWebWorkers: false })
    if (written !== result.length) throw new Error('归档条目提前结束')
    return result
  }
  async text(path: string, signal = this.source.signal) {
    const bytes = await this.read(path, LIMITS.markup, signal)
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 60 && bytes[1] === 0 ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 60 ? 'utf-16be' : 'utf-8'
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  }
  destroy() { this.source.destroy(); void this.zip.close().catch(() => {}); this.entries.clear() }
}
