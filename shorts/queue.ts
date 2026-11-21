import type { FileNode, HostClient, NodeId } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { isVideo, VIDEO_EXTENSIONS } from './state'

export const SAMPLE_SIZE = Math.min(32, LIMITS.MAX_RANDOM_LIMIT)
export const BACKTRACK_LIMIT = 100
/** 只维护浏览队列，不实现 HTTP 排队、重试或续签，也不枚举文件树。 */
export class RandomQueue {
  items: FileNode[] = []
  index = 0
  more = true
  private recent = new Set<NodeId>()
  get current() { return this.items[this.index] }
  get remaining() { return this.items.length - this.index - 1 }
  reset(first?: FileNode) { this.items = first ? [first] : []; this.index = 0; this.more = true }
  markViewed(id: NodeId) {
    this.recent.delete(id); this.recent.add(id)
    while (this.recent.size > LIMITS.MAX_RANDOM_EXCLUSIONS) this.recent.delete(this.recent.values().next().value!)
  }
  async sample(host: HostClient, roots: NodeId[], signal: AbortSignal) {
    // 在排除预算内优先保留已排队项，再加入近期记录，不让二者的并集超过宿主上限。
    const exclude_ids = [...new Set([...this.items.map(file => file.id), ...[...this.recent].reverse()])].slice(0, LIMITS.MAX_RANDOM_EXCLUSIONS)
    let response = await host.random({ roots, filter: { kind: 'file', extensions: VIDEO_EXTENSIONS, include_hidden: false }, limit: SAMPLE_SIZE, exclude_ids }, { signal })
    // 小库可能全部落入近期排除；改用另一份业务筛选允许回看，不重试同一 HTTP 请求，也不遍历全盘。
    let excluded = exclude_ids
    if (!response.items.length && this.items.length < 2 && this.recent.size) {
      this.recent.clear(); excluded = this.items.map(file => file.id)
      response = await host.random({ roots, filter: { kind: 'file', extensions: VIDEO_EXTENSIONS, include_hidden: false }, limit: SAMPLE_SIZE, exclude_ids: excluded }, { signal })
    }
    signal.throwIfAborted()
    if (response.items.length > SAMPLE_SIZE || new Set(response.items.map(file => file.id)).size !== response.items.length || response.items.some(file => !isVideo(file) || excluded.includes(file.id))) throw new Error('随机接口返回了无效或重复的视频')
    return response
  }
  append(items: FileNode[]) {
    const known = new Set(this.items.map(file => file.id))
    this.items.push(...items.filter(file => !known.has(file.id)))
    this.more = items.length === SAMPLE_SIZE
    if (this.index > BACKTRACK_LIMIT) { this.items.splice(0, this.index - BACKTRACK_LIMIT); this.index = BACKTRACK_LIMIT }
  }
  move(delta: number) { if (this.items.length > 1) this.index = (this.index + delta + this.items.length) % this.items.length }
}
