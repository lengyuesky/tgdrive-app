import type { Drive, FileEntry } from '../sdk/types'
import { parentPath, stem } from './model'
import { foldName } from '../media-scraper/model'

export const NFO_LIMIT = 1024 * 1024
export interface MovieDescription { title?: string; originalTitle?: string; overview?: string; year?: string; number?: string; kind: string }

/** 与宿主采用相同上限和直接文本语义；不执行 NFO 中的实体或标记。 */
export function parseNfo(bytes: Uint8Array): MovieDescription | undefined {
  if (bytes.length > NFO_LIMIT) return undefined
  let xml: string
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) return undefined
  const doc = new DOMParser().parseFromString(xml, 'application/xml'), root = doc.documentElement
  if (doc.querySelector('parsererror') || !['movie','episodedetails','tvshow'].includes(root.localName)) return undefined
  const direct = (name: string) => [...root.children].find(node => node.localName === name)
  const text = (node: Element | undefined) => node ? [...node.childNodes].filter(child => child.nodeType === 3 || child.nodeType === 4).map(child => child.nodeValue ?? '').join('').trim() || undefined : undefined
  const year = text(direct('year'))
  const number = text(direct('num')) ?? text([...root.children].find(node => node.localName === 'uniqueid' && node.getAttribute('type') === 'number'))
  return { kind: root.localName, title: text(direct('title')), originalTitle: text(direct('originaltitle')), overview: text(direct('plot')), year: year && /^\d{4}$/.test(year) ? year : undefined, number }
}

/** 以视频和 NFO 的身份、内容版本、路径为键；读取完成后再次核实位置。 */
export class Descriptions {
  private cache = new Map<string, MovieDescription | undefined>()
  private directories = new Map<string, Promise<FileEntry[]>>()
  constructor(private drive: Drive) {}
  clear() { this.cache.clear(); this.directories.clear() }
  private async sources(path: string, signal: AbortSignal): Promise<FileEntry[]> {
    const pending = this.directories.get(path)
    if (pending) {
      try { return await pending }
      catch (error) { signal.throwIfAborted(); if ((error as Error).name !== 'AbortError') throw error }
    }
    const task = (async () => {
      const sources: FileEntry[] = [], seen = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await this.drive.files.list({ path, limit: 200, cursor }, { signal })
        sources.push(...page.entries.filter(file => !file.is_dir && file.name.toLowerCase().endsWith('.nfo')))
        cursor = page.has_more ? page.next_cursor : null
        if (cursor) { if (seen.has(cursor)) throw new Error('目录分页游标重复，请刷新媒体库'); seen.add(cursor) }
      } while (cursor)
      signal.throwIfAborted()
      return sources
    })()
    this.directories.set(path, task)
    try { return await task }
    finally { if (this.directories.get(path) === task) this.directories.delete(path) }
  }
  async load(video: FileEntry, signal: AbortSignal): Promise<MovieDescription | undefined> {
    try {
      const current = await this.drive.files.stat({ id: video.id }, { signal })
      if (current.path !== video.path || current.content_version !== video.content_version || current.is_dir) return undefined
      const sources = await this.sources(parentPath(current.path), signal)
      const source = [`${stem(current.name)}.nfo`, 'movie.nfo']
        .map(name => sources.find(file => foldName(file.name) === foldName(name))).find(Boolean)
      if (!source || source.is_dir || source.size < 1 || source.size > NFO_LIMIT) return undefined
      const key = `${current.id}:${current.content_version}:${current.path}:${source.id}:${source.content_version}`
      if (this.cache.has(key)) return this.cache.get(key)
      const bytes = await this.drive.files.readRange(source, 0, source.size, { signal })
      const [finalVideo, finalNfo] = await Promise.all([
        this.drive.files.stat({ id: current.id }, { signal }), this.drive.files.stat({ id: source.id }, { signal }),
      ])
      signal.throwIfAborted()
      if (finalVideo.path !== current.path || finalVideo.content_version !== current.content_version || finalNfo.path !== source.path || finalNfo.content_version !== source.content_version) return undefined
      const result = parseNfo(bytes)
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, result)
      return result
    } catch (error) { signal.throwIfAborted(); return undefined }
  }
}
