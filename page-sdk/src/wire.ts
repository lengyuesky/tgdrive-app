import { WIRE_SCHEMAS } from './wire-schema.js'
import type { WireValues } from './wire-schema.js'
import { parseJson } from './json.js'
import { SdkError } from './error.js'

type Schema = { any?: boolean; kind?: string; ref?: string; literal?: unknown; object?: Record<string, { optional: boolean; schema: Schema }>; array?: Schema; union?: Schema[]; intersection?: Schema[] }
function matches(schema: Schema, value: unknown): boolean {
  if (schema.any) return true
  if (schema.ref) return matches(WIRE_SCHEMAS[schema.ref] as Schema, value)
  if (Object.hasOwn(schema, 'literal')) return value === schema.literal
  if (schema.kind) return typeof value === schema.kind
  if (schema.union) return schema.union.some(schema => matches(schema, value))
  if (schema.intersection) return schema.intersection.every(schema => matches(schema, value))
  if (schema.array) return Array.isArray(value) && value.every(item => matches(schema.array!, item))
  if (schema.object) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return Object.entries(schema.object).every(([key, field]) => {
      if (!Object.hasOwn(value, key)) return field.optional
      return matches(field.schema, (value as Record<string, unknown>)[key])
    })
  }
  return false
}
export function wireValue<K extends keyof WireValues>(type: K, value: unknown): WireValues[K] {
  if (!WIRE_SCHEMAS[type] || !matches(WIRE_SCHEMAS[type] as Schema, value)) throw new SdkError('宿主响应不符合生成契约的类型形状')
  return value as WireValues[K]
}
export function wireObject<K extends keyof WireValues>(type: K, text: string): WireValues[K] { return wireValue(type, parseJson(text)) }

/** 这里只建立 SDK 方法与契约公开响应类型的对应关系，不重新定义任何线上字段。 */
export const JSON_RESULTS: Record<string, keyof WireValues> = {
  'runtime.info': 'RuntimeInfo', 'scope.read': 'ScopeInfo',
  'files.stat': 'FileNode', 'files.list': 'DirectoryPage', 'files.query': 'FilePage',
  'files.directories_with_files': 'FilePage', 'files.random': 'RandomFilesResponse', 'files.changes': 'FileChangesPage',
  'files.media_url': 'MediaUrl', 'read_leases.create': 'ReadLease', 'read_leases.renew': 'ReadLease',
  'files.mutate': 'MutationReceipt', 'files.mutate.receipt': 'MutationReceipt',
  'files.upload.create': 'UploadInfo', 'files.upload.status': 'UploadInfo',
  'kv.get': 'KvGetResponse', 'kv.put': 'KvRecord', 'kv.list': 'KvPage', 'data.usage': 'DataUsage',
  'cache.lookup': 'CacheLookupResponse',
}
