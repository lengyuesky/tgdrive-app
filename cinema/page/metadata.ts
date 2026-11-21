import type { FileNode } from '@tgdrive/page-sdk/contract'
import { CinemaClient } from './client'
import type { MovieDescription } from './model'

/** 列表只携带短描述；详情的完整简介由自己的后端读取，页面不再解析或扫描 NFO。 */
export class Descriptions {
  private cache = new Map<string, { info: MovieDescription; full: boolean }>()
  constructor(private cinema: CinemaClient) {}
  clear() { this.cache.clear() }
  private key(file: FileNode) { return JSON.stringify([file.id, file.content_version, file.revision]) }
  seed(files: FileNode[], descriptions: Record<string, MovieDescription>) {
    for (const file of files) {
      const info = descriptions[file.id]
      if (info) this.cache.set(this.key(file), { info, full: false })
    }
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
  }
  async load(file: FileNode, signal: AbortSignal, full = false): Promise<MovieDescription | undefined> {
    signal.throwIfAborted()
    const key = this.key(file), previous = this.cache.get(key)
    if (previous && (!full || previous.full)) return previous.info
    const info = await this.cinema.description(file.id, signal)
    signal.throwIfAborted()
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, { info, full: true })
    return info
  }
}
