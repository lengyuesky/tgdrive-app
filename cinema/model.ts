import type { FileEntry, Ref } from '../sdk/types'

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts', '3gp']
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
export const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
export const stem = (name: string) => name.replace(/\.[^.]+$/, '')
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const isVideo = (file: FileEntry) => !file.is_dir && VIDEO_EXTENSIONS.includes(extension(file.name))
export const title = (name: string) => stem(name).replace(/[._]/g, ' ').replace(/\b(?:1080p|720p|2160p|x264|x265|h264|h265|hevc|bluray|webrip)\b/gi, '').replace(/\s+/g, ' ').trim() || stem(name)
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function episode(name: string): [number, number] | null {
  const se = /S(\d{1,3})[ ._-]*E(\d{1,4})/i.exec(name)
  if (se) return [Number(se[1]), Number(se[2])]
  const ep = /(?:\bE|第\s*)(\d{1,4})(?:\s*[集话話]|\b)/i.exec(name)
  return ep ? [0, Number(ep[1])] : null
}
export function naturalOrder(a: FileEntry, b: FileEntry) {
  const x = episode(a.name), y = episode(b.name)
  return (x && y ? x[0] - y[0] || x[1] - y[1] : 0) || collator.compare(a.name, b.name) || a.id - b.id
}
export function sizeText(bytes: number) {
  const i = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)))
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`
}
export function timeText(seconds: number) {
  const n = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0))
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
export interface CinemaProgress { file: FileEntry; seconds: number; duration: number; completed: boolean; subtitle?: string; audio?: number }
export interface CinemaFavorite { file: FileEntry }
export interface CinemaPreferences { speed: number; fit: 'contain' | 'cover'; autoplay: boolean; subtitleSize: number; subtitleOffset: number; encoding: 'utf-8' | 'gb18030' }
export const defaults: CinemaPreferences = { speed: 1, fit: 'contain', autoplay: true, subtitleSize: 22, subtitleOffset: 0, encoding: 'utf-8' }
export function preferences(raw: Partial<CinemaPreferences> | null | undefined): CinemaPreferences {
  const p = raw ?? {}, number = (n: unknown, min: number, max: number, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  return { speed: number(p.speed, .5, 2, 1), fit: p.fit === 'cover' ? 'cover' : 'contain', autoplay: p.autoplay !== false, subtitleSize: number(p.subtitleSize, 14, 40, 22), subtitleOffset: number(p.subtitleOffset, -10, 10, 0), encoding: p.encoding === 'gb18030' ? 'gb18030' : 'utf-8' }
}
export function validFile(value: unknown): value is FileEntry {
  const f = value as FileEntry | undefined
  return !!f && Number.isSafeInteger(f.id) && f.id > 0 && typeof f.content_version === 'string' && typeof f.path === 'string' && typeof f.name === 'string' && !f.is_dir
}
export function validProgress(value: unknown): value is CinemaProgress {
  const p = value as CinemaProgress | undefined
  return !!p && validFile(p.file) && Number.isFinite(p.seconds) && p.seconds >= 0 && Number.isFinite(p.duration) && p.duration >= 0 && typeof p.completed === 'boolean'
}
export const sameContent = (a: Ref, b: Ref) => a.id === b.id && a.content_version === b.content_version
export function coverCandidates(video: FileEntry, files: FileEntry[], wide = false): FileEntry[] {
  const names = wide ? ['fanart', 'backdrop', stem(video.name), 'poster', 'cover'] : [stem(video.name), 'poster', 'cover']
  return names.flatMap(name => files.filter(f => !f.is_dir && IMAGE_EXTENSIONS.includes(extension(f.name)) && stem(f.name).toLowerCase() === name.toLowerCase()).sort((a, b) => IMAGE_EXTENSIONS.indexOf(extension(a.name)) - IMAGE_EXTENSIONS.indexOf(extension(b.name))))
}
export function subtitleFiles(video: FileEntry, files: FileEntry[]) {
  const base = stem(video.name).toLowerCase()
  return files.filter(f => !f.is_dir && ['srt', 'vtt', 'ass'].includes(extension(f.name)) && (stem(f.name).toLowerCase() === base || stem(f.name).toLowerCase().startsWith(`${base}.`))).sort(naturalOrder)
}
