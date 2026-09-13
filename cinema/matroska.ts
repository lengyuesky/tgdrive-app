import { RangeFile, MiB } from './io'
import { cleanText, type Cue, type SubtitleTrack } from './subtitles'

interface Element { id: number; data: number; end: number; unknown: boolean }
interface SeekPoint { time: number; position: number }
export function vint(bytes: Uint8Array, offset: number, keepMarker = false): { value: number; length: number; unknown: boolean } {
  const first = bytes[offset]
  if (!first) throw new Error('无效的 Matroska 元素长度')
  let length = 1, marker = 0x80
  while (!(first & marker)) { length++; marker >>= 1 }
  if (length > 8 || offset + length > bytes.length) throw new Error('Matroska 元素被截断')
  let value = BigInt(keepMarker ? first : first & (marker - 1))
  let unknown = !keepMarker && (first & (marker - 1)) === marker - 1
  for (let i = 1; i < length; i++) { value = value * 256n + BigInt(bytes[offset + i]); unknown &&= bytes[offset + i] === 255 }
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Matroska 偏移超出安全范围')
  return { value: unknown ? 0 : Number(value), length, unknown }
}
function element(bytes: Uint8Array, start: number, bound: number): Element {
  const id = vint(bytes, start, true), size = vint(bytes, start + id.length)
  const data = start + id.length + size.length, end = size.unknown ? bound : data + size.value
  if (id.length > 4 || end > bound || end < data) throw new Error('Matroska 元素越界或损坏')
  return { id: id.value, data, end, unknown: size.unknown }
}
function children(bytes: Uint8Array, start = 0, end = bytes.length) {
  const result: Element[] = []
  for (let position = start; position < end;) {
    const item = element(bytes, position, end)
    if (item.unknown || result.length >= 100000) throw new Error('Matroska 索引过大或长度未知')
    result.push(item); position = item.end
  }
  return result
}
function integer(bytes: Uint8Array, item: Element) {
  if (item.end - item.data > 8) throw new Error('Matroska 整数无效')
  let value = 0
  for (let i = item.data; i < item.end; i++) value = value * 256 + bytes[i]
  if (!Number.isSafeInteger(value)) throw new Error('Matroska 整数溢出')
  return value
}
const text = (bytes: Uint8Array, item: Element) => new TextDecoder().decode(bytes.subarray(item.data, item.end))

/** 仅解析字幕所需的 EBML 元素；音视频块按长度跳过，不执行附件或字幕样式。 */
export class MatroskaSubtitles {
  tracks: SubtitleTrack[] = []
  points: SeekPoint[] = []
  private scale = .001
  private segment = 0
  private firstCluster = 0
  constructor(private file: RangeFile) {}
  private async header(position: number, bound = this.file.file.size): Promise<Element> {
    const bytes = await this.file.read(position, Math.min(bound, position + 16))
    const h = element(bytes, 0, bound - position)
    return { ...h, data: h.data + position, end: h.end + position }
  }
  private async body(item: Element, max = 8 * MiB) {
    if (item.unknown || item.end - item.data > max) throw new Error('Matroska 字幕索引超过安全限制')
    return this.file.read(item.data, item.end)
  }
  async open() {
    let segment: Element | undefined
    for (let at = 0, count = 0; at < this.file.file.size && count++ < 32;) {
      const h = await this.header(at)
      if (h.id === 0x18538067) { segment = h; break }
      at = h.end
    }
    if (!segment) throw new Error('未找到 Matroska 内容段')
    this.segment = segment.data
    const positions = new Map<number, number>()
    for (let at = segment.data, count = 0; at < segment.end && count++ < 256;) {
      const h = await this.header(at, segment.end)
      positions.set(h.id, at)
      if (h.id === 0x114d9b74) {
        const bytes = await this.body(h, MiB)
        for (const seek of children(bytes).filter(e => e.id === 0x4dbb)) {
          let id = 0, offset = -1
          for (const field of children(bytes, seek.data, seek.end)) {
            if (field.id === 0x53ab) id = integer(bytes, field)
            if (field.id === 0x53ac) offset = integer(bytes, field)
          }
          if (id && offset >= 0 && offset < segment.end - segment.data) positions.set(id, segment.data + offset)
        }
      }
      if (h.id === 0x1f43b675) { this.firstCluster = at; break }
      if (h.unknown) break
      at = h.end
    }
    const load = async (id: number) => {
      const at = positions.get(id)
      if (at === undefined) return null
      const h = await this.header(at, segment!.end)
      if (h.id !== id) throw new Error('Matroska 索引指向错误元素')
      return this.body(h)
    }
    const info = await load(0x1549a966)
    if (info) for (const e of children(info)) if (e.id === 0x2ad7b1) this.scale = integer(info, e) / 1e9
    const tracks = await load(0x1654ae6b)
    if (tracks) for (const entry of children(tracks).filter(e => e.id === 0xae)) {
      let id = 0, type = 0, codec = '', name = '', language = ''
      for (const f of children(tracks, entry.data, entry.end)) {
        if (f.id === 0xd7) id = integer(tracks, f)
        if (f.id === 0x83) type = integer(tracks, f)
        if (f.id === 0x86) codec = text(tracks, f)
        if (f.id === 0x536e) name = text(tracks, f)
        if (f.id === 0x22b59c) language = text(tracks, f)
      }
      if (type === 17) this.tracks.push({ key: `embedded:${id}`, embeddedId: id, codec, label: `${name || language || `字幕 ${id}`} · ${['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA'].includes(codec) ? '内嵌文本' : '不支持的字幕格式'}` })
    }
    const cues = await load(0x1c53bb6b)
    if (cues) for (const point of children(cues).filter(e => e.id === 0xbb)) {
      let time = 0, position = -1
      for (const field of children(cues, point.data, point.end)) {
        if (field.id === 0xb3) time = integer(cues, field) * this.scale
        if (field.id === 0xb7) for (const f of children(cues, field.data, field.end)) if (f.id === 0xf1) position = this.segment + integer(cues, f)
      }
      if (position >= this.segment && position < segment.end) this.points.push({ time, position })
    }
    this.points.sort((a, b) => a.time - b.time)
  }
  async window(track: SubtitleTrack, seconds: number): Promise<Cue[]> {
    if (!['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA'].includes(track.codec ?? '')) throw new Error('此内嵌字幕为图片或不支持的格式，请选择外挂文本字幕')
    let start = this.firstCluster
    for (const point of this.points) { if (point.time > Math.max(0, seconds - 15)) break; start = point.position }
    if (!start) return []
    if (!this.points.length && seconds > 60) throw new Error('缺少字幕定位索引，请使用外挂字幕')
    const result: Cue[] = []
    let textBytes = 0
    const block = async (h: Element, time: number, duration?: number) => {
      const prefix = await this.file.read(h.data, Math.min(h.end, h.data + 12)), number = vint(prefix, 0)
      if (number.value !== track.embeddedId || prefix.length < number.length + 3) return
      if (prefix[number.length + 2] & 6) return
      const relative = new DataView(prefix.buffer, prefix.byteOffset).getInt16(number.length)
      const from = h.data + number.length + 3
      if ((textBytes += h.end - from) > 8 * MiB || result.length >= 50000) throw new Error('内嵌字幕超过安全限制')
      let body = new TextDecoder().decode(await this.file.read(from, h.end))
      if (track.codec !== 'S_TEXT/UTF8') body = body.split(',').slice(8).join(',')
      const begin = time + relative * this.scale, end = begin + (duration ?? 4)
      if (end >= seconds - 15 && begin <= seconds + 45) result.push({ start: Math.max(0, begin), end, text: cleanText(body) })
    }
    for (let at = start, clusters = 0, elements = 0; at < this.file.file.size && clusters < 64;) {
      const cluster = await this.header(at)
      if (cluster.id !== 0x1f43b675) { if (cluster.unknown) break; at = cluster.end; continue }
      clusters++
      let time = 0, next = cluster.end
      for (let p = cluster.data; p < cluster.end;) {
        if (++elements > 100000) throw new Error('字幕窗口解析元素过多')
        const h = await this.header(p, cluster.end)
        if (h.id === 0x1f43b675) { next = p; break }
        if (h.id === 0xe7) {
          const bytes = await this.body(h, 8)
          time = integer(bytes, { id: 0, data: 0, end: bytes.length, unknown: false }) * this.scale
          if (time > seconds + 45) return result
        }
        if (h.id === 0xa3) await block(h, time)
        if (h.id === 0xa0) {
          let packet: Element | undefined, duration: number | undefined
          for (let q = h.data; q < h.end;) {
            const field = await this.header(q, h.end)
            if (field.id === 0xa1) packet = field
            if (field.id === 0x9b) { const b = await this.body(field, 8); duration = integer(b, { id: 0, data: 0, end: b.length, unknown: false }) * this.scale }
            q = field.end
          }
          if (packet) await block(packet, time, duration)
        }
        if (h.unknown) break
        p = h.end
      }
      if (next <= at) break
      at = next
    }
    return result
  }
}
