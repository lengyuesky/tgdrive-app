/** 一条宿主事件流在应用内部扇出；重连、续签和游标去重由页面 SDK 负责。 */
import type { FileNode, HostClient, HostEvent, NodeId, NodeReference, PageContext, PageUi } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'

/** 文件名可以比宿主标题长；只缩短显示标题，不改变文件身份或完整名称。 */
export function uiTitle(value: string): string {
  let title = '', bytes = 0
  const encoder = new TextEncoder()
  for (const character of value || '阅读馆') {
    const size = encoder.encode(character).length
    if (bytes + size > LIMITS.MAX_UI_TITLE_BYTES) break
    title += character; bytes += size
  }
  return title
}

export type ReaderUi = Pick<PageUi, 'setImmersive' | 'setTitle' | 'pickDirectory' | 'requestScope' | 'task' | 'close' | 'onNotice' | 'beforeClose'>
export interface PageRuntime { host: HostClient; ui: ReaderUi; context: PageContext; dispose(): void }
export type EventListener = (data: unknown) => void | Promise<void>
/** 选择目录不等于授权，只在明确被拒绝时请求主人确认，然后重读相同 ID。 */
export async function readableDirectory(host: HostClient, ui: ReaderUi, reference: NodeReference, signal: AbortSignal): Promise<FileNode | null> {
  const stat = () => host.stat(reference, { signal })
  let file: FileNode
  try { file = await stat() }
  catch (error) {
    if ((error as { code?: string }).code !== 'scope_denied') throw error
    const scope = await ui.requestScope({ reason: '请为阅读馆选择允许读取的目录。', preferred_access: 'read_only' }, { signal })
    if (!scope) return null
    file = await stat()
  }
  if (file.kind !== 'directory') throw new Error('所选节点不是目录')
  return file
}
export async function pickReadableDirectory(host: HostClient, ui: ReaderUi, signal: AbortSignal, initialId?: NodeId): Promise<FileNode | null> {
  const selected = await ui.pickDirectory(initialId ? { initial_id: initialId } : {}, { signal })
  return selected ? readableDirectory(host, ui, { by: 'id', id: selected.id }, signal) : null
}
export class ReaderEvents {
  private listeners = new Map<string, Set<EventListener>>()
  constructor(private host: HostClient, private signal: AbortSignal, private error: (error: unknown) => void) {}
  on(name: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>()
    listeners.add(listener); this.listeners.set(name, listeners)
    return () => listeners.delete(listener)
  }
  async run(): Promise<void> {
    try {
      for await (const event of this.host.events({ signal: this.signal })) await this.dispatch(event)
    } catch (error) { if (!this.signal.aborted) this.error(error) }
  }
  private async dispatch(event: HostEvent) {
    await Promise.allSettled([...(this.listeners.get(event.event) ?? [])].map(listener => Promise.resolve().then(() => listener(event.data))))
  }
}
