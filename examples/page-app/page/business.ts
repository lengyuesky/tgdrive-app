import type { HostClient, ContentRef, Cursor, FileNode, FilePage } from '@tgdrive/page-sdk'

/** 示例业务：只分页、不扫描完整网盘；保存状态仍须显式 CAS。 */
export function files(host: HostClient, cursor?: Cursor): Promise<FilePage> {
  return host.query({ roots: [], recursive: true, filter: { kind: 'file', extensions: [], include_hidden: false }, sort: 'name', order: 'asc', limit: 20, cursor })
}
export async function choose(host: HostClient, node: FileNode): Promise<Uint8Array> {
  if (!node.content_version) throw new Error('只能选择文件')
  const file: ContentRef = { id: node.id, content_version: node.content_version }
  const length = BigInt(node.size) < 8n ? BigInt(node.size) : 8n
  const bytes = length ? await host.readRange(file, { offset: '0', length: length.toString() }) : new Uint8Array()
  const previous = (await host.kvGet('last-file')).record
  await host.kvPut('last-file', { value: file, condition: previous ? { type: 'revision', revision: previous.revision } : { type: 'absent' } })
  return bytes
}
