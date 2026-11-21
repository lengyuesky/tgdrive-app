import type { ContentRef, FileNode, HostClient, JsonValue, KvRecord, NodeId } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'

export const SETTINGS_KEY = 'shorts:settings'
export const FAVORITES_PREFIX = 'shorts:favorite:'
export const DATA_VERSION_KEY = 'shorts:data-version'
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts', '3gp', 'ogv']
export type Source = { type: 'all' } | { type: 'directory'; id: NodeId; path: string }
export interface Settings { schemaVersion: 1; source: Source; muted: boolean }
export interface SettingsSnapshot { value: Settings; revision: string | null }
export interface Favorite { schemaVersion: 1; id: NodeId; contentVersion: string; name: string; path: string; addedAt: number }
export interface FavoriteSnapshot { value: Favorite | null; revision: string | null }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const validId = (value: unknown): value is NodeId => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt(LIMITS.MAX_NODE_ID)
const validPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && new TextEncoder().encode(value).length <= LIMITS.MAX_DRIVE_PATH_BYTES && !/[\\\x00-\x1f\x7f]/.test(value) && (value === '/' || value.split('/').slice(1).every(part => !!part && part !== '.' && part !== '..'))
export const within = (path: string, root: string) => root === '/' || path === root || path.startsWith(root + '/')
export const defaults = (): Settings => ({ schemaVersion: 1, source: { type: 'all' }, muted: true })
export const sourceIdentity = (source: Source) => source.type === 'all' ? 'all' : source.id
export const isVideo = (node: FileNode) => node.kind === 'file' && !!node.content_version && VIDEO_EXTENSIONS.includes(node.name.split('.').pop()?.toLowerCase() ?? '')
export function reference(node: FileNode): ContentRef { if (!isVideo(node)) throw new Error('所选节点不是支持的视频文件'); return { id: node.id, content_version: node.content_version! } }
export function contentType(node: FileNode) {
  const suffix = node.name.split('.').pop()?.toLowerCase()
  return ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', '3gp': 'video/3gpp', ogv: 'video/ogg' } as Record<string, string>)[suffix ?? ''] ?? 'application/octet-stream'
}
export function parseSettings(raw: unknown): Settings {
  if (!object(raw) || raw.schemaVersion !== 1 || typeof raw.muted !== 'boolean' || !object(raw.source)) throw new Error('取材设置版本未知或损坏，未覆盖原记录')
  const source = raw.source
  if (source.type === 'all') return { schemaVersion: 1, source: { type: 'all' }, muted: raw.muted }
  if (source.type !== 'directory' || !validId(source.id) || !validPath(source.path)) throw new Error('取材目录记录无效，未回退到授权全盘')
  return { schemaVersion: 1, source: { type: 'directory', id: source.id, path: source.path }, muted: raw.muted }
}
export function parseFavorite(raw: unknown): Favorite {
  if (!object(raw) || raw.schemaVersion !== 1 || !validId(raw.id) || typeof raw.contentVersion !== 'string' || raw.contentVersion.length > LIMITS.MAX_OPAQUE_ID_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw.contentVersion)
    || typeof raw.name !== 'string' || !raw.name || new TextEncoder().encode(raw.name).length > LIMITS.MAX_NAME_BYTES || /[\\/\x00-\x1f\x7f]/.test(raw.name) || !validPath(raw.path)
    || !Number.isSafeInteger(raw.addedAt) || (raw.addedAt as number) < 0) throw new Error('收藏记录版本未知或损坏，未覆盖原记录')
  return { schemaVersion: 1, id: raw.id, contentVersion: raw.contentVersion, name: raw.name, path: raw.path, addedAt: raw.addedAt as number }
}
const condition = (revision: string | null) => revision === null ? { type: 'absent' as const } : { type: 'revision' as const, revision }
/** 只管理本应用数据版本，不读取旧平台设置，不调用迁移回调。 */
export async function initializeData(host: HostClient, signal: AbortSignal) {
  const current = (await host.kvGet(DATA_VERSION_KEY, { signal })).record
  if (current) { if (current.value !== 1) throw new Error('短视频数据版本未知，请升级应用后重试'); return }
  try { await host.kvPut(DATA_VERSION_KEY, { value: 1, condition: { type: 'absent' } }, { signal }) }
  catch (error) { if ((error as { code?: string }).code !== 'storage_conflict' || (await host.kvGet(DATA_VERSION_KEY, { signal })).record?.value !== 1) throw error }
}
export class SettingsStore {
  constructor(private host: HostClient) {}
  async load(signal: AbortSignal): Promise<SettingsSnapshot> {
    const record = (await this.host.kvGet(SETTINGS_KEY, { signal })).record
    return { value: record ? parseSettings(record.value) : defaults(), revision: record?.revision ?? null }
  }
  async save(base: SettingsSnapshot, value: Settings, signal: AbortSignal): Promise<SettingsSnapshot> {
    const record = await this.host.kvPut(SETTINGS_KEY, { value: parseSettings(value) as unknown as JsonValue, condition: condition(base.revision) }, { signal })
    return { value: parseSettings(record.value), revision: record.revision }
  }
}
export class FavoritesStore {
  constructor(private host: HostClient) {}
  private key(id: NodeId) { if (!validId(id)) throw new Error('视频标识无效'); return FAVORITES_PREFIX + id }
  async load(id: NodeId, signal: AbortSignal): Promise<FavoriteSnapshot> {
    const record = (await this.host.kvGet(this.key(id), { signal })).record
    const value = record ? parseFavorite(record.value) : null
    if (value && value.id !== id) throw new Error('收藏键与视频身份不一致')
    return { value, revision: record?.revision ?? null }
  }
  async set(node: FileNode, base: FavoriteSnapshot, enabled: boolean, signal: AbortSignal): Promise<FavoriteSnapshot> {
    const ref = reference(node), key = this.key(ref.id)
    if (base.value && base.value.id !== ref.id) throw new Error('收藏基线不属于当前视频')
    if (!enabled) {
      if (base.revision !== null) await this.host.kvDelete(key, { revision: base.revision }, { signal })
      return { value: null, revision: null }
    }
    const value: Favorite = { schemaVersion: 1, id: ref.id, contentVersion: ref.content_version, name: node.name, path: node.path, addedAt: base.value?.addedAt ?? Date.now() }
    const record = await this.host.kvPut(key, { value: value as unknown as JsonValue, condition: condition(base.revision) }, { signal })
    return { value: parseFavorite(record.value), revision: record.revision }
  }
  async page(cursor: string | null, signal: AbortSignal): Promise<{ records: (Omit<KvRecord, 'value'> & { value: Favorite })[]; next_cursor: string | null }> {
    const page = await this.host.kvList({ prefix: FAVORITES_PREFIX, cursor, limit: 20 }, { signal })
    const records = page.records.map(record => { const value = parseFavorite(record.value); if (record.key !== this.key(value.id)) throw new Error('收藏键与视频身份不一致'); return { ...record, value } })
    return { records, next_cursor: page.next_cursor }
  }
}
