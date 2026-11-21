/** 应用值的类型投影与显式写条件；不重试、不合并、不提供无条件写入。 */
import type { KvCondition, KvRecord } from '@tgdrive/page-sdk'
export type ValueRecord<T = unknown> = Omit<KvRecord, 'value'> & { value: T }
/** 宿主可以改变 JSON 对象键顺序，业务值相同不能因此重复写入。 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).filter(key => a[key] !== undefined), other = Object.keys(b).filter(key => b[key] !== undefined)
  return keys.length === other.length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]))
}
export const kvCondition = (revision?: string | null): KvCondition => revision == null
  ? { type: 'absent' }
  : { type: 'revision', revision }
