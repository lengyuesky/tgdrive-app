/** 有界渐进 TXT 解码，保留真实字符位置，不沿用文件预览的 256 KiB 截断。 */
import { FlowReader } from '../reader/flow'
import { LIMITS, MiB, RangeFile } from '../reader/io'
import type { NavigationItem, ViewContext } from '../reader/view'
import type { Location } from '../reader/state'
export function detectEncoding(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  let even = 0, odd = 0
  const length = Math.min(4096, bytes.length)
  for (let i = 0; i < length; i++) if (!bytes[i]) { if (i % 2) odd++; else even++ }
  if (odd > length / 4) return 'utf-16le'
  if (even > length / 4) return 'utf-16be'
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); return 'utf-8' } catch { return 'gb18030' }
}
export function textSections(text: string) {
  const starts: { start: number; label: string }[] = []
  const titles = /^(?:第[〇零一二三四五六七八九十百千万两\d]+[章节回卷部篇][^\n]{0,70}|chapter\s+\d+[^\n]{0,70})\s*$/gim
  for (const match of text.matchAll(titles)) {
    if (starts.length >= 10000) throw new Error('章节数量超过 10000，请拆分文本文件')
    starts.push({ start: match.index!, label: match[0].trim() })
  }
  if (!starts.length || starts[0]!.start > 0) starts.unshift({ start: 0, label: starts.length ? '前言' : '正文' })
  const sections: { start: number; end: number; label: string; entry: string; chapterStart: number; chapterLabel: string; part: number }[] = []
  for (let i = 0; i < starts.length; i++) {
    const end = starts[i + 1]?.start ?? text.length
    let start = starts[i]!.start, part = 0
    do {
      let stop = Math.min(end, start + 32768)
      if (stop < end) {
        const line = text.lastIndexOf('\n', stop)
        if (line > start + 16000) stop = line + 1
        if (text.charCodeAt(stop - 1) >= 0xd800 && text.charCodeAt(stop - 1) <= 0xdbff) stop--
      }
      sections.push({ start, end: stop, label: `${starts[i]!.label}${part ? `（续 ${part}）` : ''}`, entry: String(start), chapterStart: starts[i]!.start, chapterLabel: starts[i]!.label, part })
      start = stop; part++
    } while (start < end)
  }
  if (sections.length > 10000) throw new Error('文本窗口数量超过 10000')
  return sections
}
/** 技术窗口只作为章下的导航项，不插入正文，也不改变原文 UTF-16 偏移。 */
export function textNavigation(chunks: ReturnType<typeof textSections>): NavigationItem[] {
  const navigation: NavigationItem[] = []
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!
    const location: Location = { format: 'txt', index, offset: chunk.start, entry: chunk.entry }
    if (chunk.part === 0) navigation.push({ label: chunk.chapterLabel, depth: 0, location })
    if (chunk.part > 0 || chunks[index + 1]?.chapterStart === chunk.chapterStart) navigation.push({ label: `分段 ${chunk.part + 1}`, depth: 1, location: { ...location } })
  }
  return navigation
}
export class TextReader extends FlowReader {
  readonly format = 'txt'
  navigation: NavigationItem[] = []
  private source: RangeFile
  private text = ''
  private chunks: ReturnType<typeof textSections> = []
  encoding = 'utf-8'
  constructor(context: ViewContext) { super(context); this.source = new RangeFile(context.drive, context.file, context.signal, LIMITS.txt) }
  private decoding = 0
  private complete = false
  private opened = false
  private stoppedText = false
  private finish?: () => Promise<void>
  private background?: Promise<void>
  private loadingFailed = false
  protected async prepare(location?: Location) {
    const generation = ++this.decoding
    const sample = await this.source.read(0, Math.min(this.source.file.size, MiB))
    const encoding = location?.encoding ?? detectEncoding(sample)
    const decoder = new TextDecoder(encoding, { fatal: encoding === 'utf-8' })
    let raw = '', at = 0
    this.complete = false; this.loadingFailed = false; this.encoding = encoding
    const step = async () => {
      const bytes = at === 0 ? sample : await this.source.read(at, Math.min(MiB, this.source.file.size - at))
      this.context.signal.throwIfAborted()
      if (generation !== this.decoding || this.stoppedText) throw new DOMException('文本加载已取消', 'AbortError')
      at += bytes.length
      const complete = at >= this.source.file.size
      raw += decoder.decode(bytes, { stream: !complete })
      const text = raw.replace(/\r\n?/g, '\n')
      const chunks = textSections(text)
      // 未读完时隐藏最后一个尚可能增长的窗口，后台追加不会改变当前正文的几何。
      if (!complete) chunks.pop()
      if (complete && !text.trim()) throw new Error('文本文件为空')
      this.complete = complete; this.text = text; this.chunks = chunks; this.sections = chunks; this.navigation = textNavigation(chunks)
    }
    do { await step() } while (!this.complete && (!this.chunks.length || (location?.offset ?? 0) >= this.chunks.at(-1)!.end || (location?.offset === undefined && (location?.index ?? 0) >= this.chunks.length)))
    let pending: Promise<void> | undefined
    this.finish = () => pending ??= (async () => {
      while (!this.complete && generation === this.decoding && !this.stoppedText) {
        await step()
        if (this.opened) this.context.changed()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    })()
  }
  async open(location?: Location) {
    await super.open(location)
    this.opened = true
    this.background = this.finish?.()
    void this.background?.catch(error => {
      if (this.stoppedText || this.context.signal.aborted) return
      this.loadingFailed = true; this.context.changed(); this.report(error)
    })
  }
  async loadNavigation() {
    await super.loadNavigation()
    await this.finish?.()
    this.context.signal.throwIfAborted()
    if (this.stoppedText) throw new DOMException('阅读器已关闭', 'AbortError')
    return structuredClone(this.navigation)
  }
  navigationState() {
    const state = super.navigationState()
    return { ...state, atEnd: this.complete && state.atEnd, layoutNotice: this.complete ? undefined : this.loadingFailed ? '后续内容加载失败，请重试打开或选择正确编码' : '正文可读，正在加载后续章节…' }
  }
  protected async content(index: number) {
    const chunk = this.chunks[index]!
    const fragment = document.createDocumentFragment(), body = document.createElement('div')
    body.className = 'plain-text'; body.textContent = this.text.slice(chunk.start, chunk.end)
    fragment.append(body); return fragment
  }
  protected offsetFor(index: number) { return this.chunks[index]?.start ?? 0 }
  protected indexFor(location: Location) {
    if (location.offset !== undefined) {
      let low = 0, high = this.chunks.length - 1
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (this.chunks[middle]!.start <= location.offset) low = middle; else high = middle - 1 }
      return low
    }
    return super.indexFor(location)
  }
  current(): Location { return { ...super.current(), encoding: this.encoding } }
  async setEncoding(encoding: string) {
    if (!['utf-8','utf-16le','utf-16be','gb18030'].includes(encoding)) return
    await this.background?.catch(() => {})
    const old = this.current(), ratio = (old.offset ?? 0) / Math.max(1, this.text.length)
    await this.prepare({ format: 'txt', index: 0, encoding })
    await this.finish?.()
    await this.restore({ format: 'txt', index: 0, offset: Math.floor(ratio * this.text.length), encoding })
  }
  destroy() { this.stoppedText = true; this.decoding++; super.destroy(); this.source.destroy(); this.text = ''; this.chunks = []; this.navigation = [] }
}
