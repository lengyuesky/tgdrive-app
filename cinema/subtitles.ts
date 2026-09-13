import type { FileEntry } from '../sdk/types'
import { extension } from './model'
import { MiB, RangeFile } from './io'
export interface Cue { start: number; end: number; text: string }
export interface SubtitleTrack { key: string; label: string; file?: FileEntry; embeddedId?: number; codec?: string }
export function cleanText(text: string) {
  return text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}
export function timestamp(text: string) {
  const parts = text.trim().replace(',', '.').split(':').map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return NaN
  return parts.reduce((total, n) => total * 60 + n, 0)
}
export function parseSubtitles(text: string, format: string): Cue[] {
  if (new TextEncoder().encode(text).length > 8 * MiB) throw new Error('字幕超过 8 MiB')
  const cues: Cue[] = []
  const add = (start: number, end: number, body: string) => {
    const text = cleanText(body)
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && text) cues.push({ start, end, text })
    if (cues.length > 50000) throw new Error('字幕超过 50000 条')
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r/g, '')
  if (format === 'ass') {
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'], events = false
    for (const line of text.split('\n')) {
      if (/^\[/.test(line)) events = /^\[Events\]/i.test(line)
      if (!events) continue
      if (/^Format:/i.test(line)) fields = line.slice(7).split(',').map(f => f.trim().toLowerCase())
      if (!/^Dialogue:/i.test(line)) continue
      const data = line.slice(9).trim().split(','), bodyIndex = fields.indexOf('text')
      if (bodyIndex < 0 || bodyIndex !== fields.length - 1) continue
      add(timestamp(data[fields.indexOf('start')] ?? ''), timestamp(data[fields.indexOf('end')] ?? ''), data.slice(bodyIndex).join(','))
    }
  } else {
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n'), index = lines.findIndex(line => line.includes('-->'))
      if (index < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue
      const timing = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[index])
      if (timing) add(timestamp(timing[1]), timestamp(timing[2]), lines.slice(index + 1).join('\n'))
    }
  }
  return cues.sort((a, b) => a.start - b.start)
}
export async function readSubtitle(file: RangeFile, encoding: string): Promise<Cue[]> {
  if (file.file.size > 8 * MiB) throw new Error('字幕超过 8 MiB，请使用较小的外挂字幕')
  const bytes = await file.read(0, file.file.size)
  return parseSubtitles(new TextDecoder(encoding).decode(bytes), extension(file.file.name))
}
/** 文本轨使用浏览器原生提示，iOS 视频全屏时仍可显示；只设置纯文本。 */
export class Captions {
  private track: TextTrack
  private cues: Cue[] = []
  private offset = 0
  constructor(video: HTMLVideoElement) { this.track = video.addTextTrack('subtitles', '影视字幕', 'zh'); this.track.mode = 'disabled' }
  set(cues: Cue[], offset = this.offset) {
    this.cues = cues; this.offset = offset
    for (const cue of Array.from(this.track.cues ?? [])) this.track.removeCue(cue)
    for (const cue of cues) {
      const start = Math.max(0, cue.start + offset), end = Math.max(0, cue.end + offset)
      if (end > start) {
        const text = cue.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        this.track.addCue(new VTTCue(start, end, text))
      }
    }
    this.track.mode = cues.length ? 'showing' : 'disabled'
  }
  shift(offset: number) { this.set(this.cues, offset) }
  clear() { this.set([]) }
}
