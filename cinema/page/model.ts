import type { ContentRef, FileNode } from '@tgdrive/page-sdk/contract'

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts', '3gp']
export const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
export const stem = (name: string) => name.replace(/\.[^.]+$/, '')
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const isVideo = (file: FileNode) => file.kind === 'file' && VIDEO_EXTENSIONS.includes(extension(file.name))
export const title = (name: string) => stem(name).replace(/[._]/g, ' ').replace(/\b(?:1080p|720p|2160p|x264|x265|h264|h265|hevc|bluray|webrip)\b/gi, '').replace(/\s+/g, ' ').trim() || stem(name)
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
/** 仅用于已加载的一页的显示，不推断后端的剧集归属。 */
export function episode(name: string): [number, number] | null {
  const se = /S(\d{1,3})[ ._-]*E(\d{1,4})/i.exec(name)
  if (se) return [Number(se[1]), Number(se[2])]
  const ep = /(?:\bE|第\s*)(\d{1,4})(?:\s*[集话話]|\b)/i.exec(name)
  return ep ? [0, Number(ep[1])] : null
}
export function naturalOrder(a: FileNode, b: FileNode) {
  const x = episode(a.name), y = episode(b.name)
  return (x && y ? x[0] - y[0] || x[1] - y[1] : 0) || collator.compare(a.name, b.name) || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
}
/** 文件大小保留十进制字符串，显示时也不把节点 ID 或大文件偏移变成浮点数。 */
export function sizeText(bytes: string) {
  const count = BigInt(bytes)
  let unit = 0, scale = 1n
  while (unit < 4 && count >= scale * 1024n) { scale *= 1024n; unit++ }
  const value = unit ? `${count / scale}.${count % scale * 10n / scale}` : String(count)
  return `${value} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
export function fileSize(file: FileNode): number {
  const size = BigInt(file.size)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件超过浏览器容器解析的安全偏移范围，请下载原文件播放')
  return Number(size)
}
export function contentRef(file: FileNode): ContentRef {
  if (file.kind !== 'file' || !file.content_version) throw new Error('文件没有有效内容版本')
  return { id: file.id, content_version: file.content_version }
}
export const posterHue = (file: FileNode) => 230 + Number(BigInt(file.id) * 37n % 100n)
export function timeText(seconds: number) {
  const n = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0))
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
export interface SubtitleSource { id: string; version: string; name: string; path: string; size: number; parent_id: string | null }
export interface MovieDescription { title?: string; originalTitle?: string; overview?: string; year?: string; number?: string; kind: string; cover_key?: string | null; subtitles?: SubtitleSource[] }
export interface CinemaProgress { file: FileNode; seconds: number; duration: number; completed: boolean; subtitle?: string; audio?: number | null }
export interface CinemaFavorite { file: FileNode }
export interface CinemaPreferences { speed: number; fit: 'contain' | 'cover'; autoplay: boolean; subtitleSize: number; subtitleOffset: number; encoding: 'utf-8' | 'gb18030' }
export const defaults: CinemaPreferences = { speed: 1, fit: 'contain', autoplay: true, subtitleSize: 22, subtitleOffset: 0, encoding: 'utf-8' }
export function preferences(raw: Partial<CinemaPreferences> | null | undefined): CinemaPreferences {
  const p = raw ?? {}, number = (n: unknown, min: number, max: number, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  return { speed: number(p.speed, .5, 2, 1), fit: p.fit === 'cover' ? 'cover' : 'contain', autoplay: p.autoplay !== false, subtitleSize: number(p.subtitleSize, 14, 40, 22), subtitleOffset: number(p.subtitleOffset, -10, 10, 0), encoding: p.encoding === 'gb18030' ? 'gb18030' : 'utf-8' }
}
export function validFile(value: unknown): value is FileNode {
  const f = value as FileNode | undefined
  return !!f && typeof f.id === 'string' && /^[1-9][0-9]*$/.test(f.id) && BigInt(f.id) <= 9223372036854775807n && typeof f.content_version === 'string' && typeof f.path === 'string' && typeof f.name === 'string' && f.kind === 'file'
}
export function validProgress(value: unknown): value is CinemaProgress {
  const p = value as CinemaProgress | undefined
  return !!p && validFile(p.file) && Number.isFinite(p.seconds) && p.seconds >= 0 && Number.isFinite(p.duration) && p.duration >= 0 && typeof p.completed === 'boolean'
}
export const sameContent = (a: Pick<FileNode, 'id' | 'content_version'>, b: Pick<FileNode, 'id' | 'content_version'>) => a.id === b.id && a.content_version === b.content_version
export function isNumberedMovie(file: FileNode, description?: MovieDescription): boolean {
  if (description?.kind === 'movie' && description.number) return true
  // 这里只决定是否默认连播；资料识别和库中电影／剧集归属均由后端负责。
  return !['episodedetails', 'tvshow'].includes(description?.kind ?? '') && !episode(file.name) && /(?:^|[^A-Za-z0-9])[A-Za-z]{2,10}[-_][0-9]{2,7}(?:[^0-9]|$)/.test(file.name)
}
