/** 文件标识与内容读取边界；线上节点和字节数始终保留十进制字符串。 */
import type { ContentRef, FileNode, NodeId } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'

export function validNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    && value.length <= 19 && BigInt(value) <= BigInt(LIMITS.MAX_NODE_ID)
}
export const compareNodeIds = (left: NodeId, right: NodeId) => left === right ? 0 : BigInt(left) < BigInt(right) ? -1 : 1
/** 图片目录的位置绑定直属集合修订，不能把目录当作 ContentRef。 */
export function fileVersion(file: FileNode): string {
  const version = file.kind === 'file' ? file.content_version : file.children_revision
  if (!version) throw new Error('文件或目录缺少版本信息')
  return version
}
export function contentRef(file: FileNode): ContentRef {
  if (file.kind !== 'file' || !file.content_version) throw new Error('只能读取原文件的字节')
  return { id: file.id, content_version: file.content_version }
}
export function byteSize(file: FileNode, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^(0|[1-9][0-9]*)$/.test(file.size)) throw new Error('文件大小格式无效')
  if (BigInt(file.size) > BigInt(maximum)) throw new Error(`文件超过 ${maximum / 1048576} MiB 上限`)
  return Number(file.size)
}
