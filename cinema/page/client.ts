import { HostError, parseJson, stringifyJson } from '@tgdrive/page-sdk'
import type { HostClient } from '@tgdrive/page-sdk'
import type { FileNode, NodeReference, RuntimeInfo } from '@tgdrive/page-sdk/contract'
import type { CinemaProgress, MovieDescription } from './model'

/** 这些 DTO 只属于影视后端；宿主 DTO 一律从契约导入。 */
export interface CinemaLibrary { id: string; name: string; kind: 'movie' | 'tv'; root_id: string; path: string | null; authorized: boolean }
export interface IndexStatus { state: string; error: string; entries: number }
export interface Configuration { revision: string; username: string; account_configured: boolean; running: boolean; libraries: CinemaLibrary[]; index: IndexStatus }
export interface ServiceStatus {
  running: boolean
  index: IndexStatus
  covers: { ready: number; pending: number; failed: number; retrying: number; errors: Array<{ title: string; reason: string; retry_at: number }> }
  limits: Record<string, number>
}
export interface CinemaRecord<T> { key: string; value: T; revision: string; library_id?: string }
export interface CinemaVersion { media_guid: string; name: string; file: FileNode }
export interface CinemaVersions { item_guid: string; representative_media_guid: string; default_media_guid: string; versions: CinemaVersion[] }
export interface FilePage { items: FileNode[]; next_cursor: string | null; total: number }
export interface CatalogPage extends FilePage { descriptions: Record<string, MovieDescription> }
export interface RecordPage<T> { records: Array<CinemaRecord<T>>; next_cursor: string | null; total: number }
export interface CatalogQuery { ancestor?: string; q?: string; extensions?: string[]; limit: number; cursor?: string | null; raw_files: true; sort_column?: 'create_time' | 'title'; descending?: boolean }
export type LibraryDraft = Pick<CinemaLibrary, 'id' | 'name' | 'kind' | 'root_id'>

/** 不重试业务请求，不另建宿主队列或票据续签层；传输和取消交给页面 SDK。 */
export class CinemaClient {
  constructor(readonly host: HostClient) {}
  async request<T>(path: string, value?: unknown, signal?: AbortSignal, method: 'GET' | 'POST' | 'PUT' = value === undefined ? 'GET' : 'POST'): Promise<T> {
    const response = await this.host.backend(path, { method, signal, headers: value === undefined ? undefined : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : stringifyJson(value) })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (reader) for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 8 * 1024 * 1024) throw new Error('影视页面响应超过 8 MiB，请缩小每页数量')
        chunks.push(part.value)
      }
      signal?.throwIfAborted()
    } catch (error) { await reader?.cancel().catch(() => {}); throw error }
    finally { reader?.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const decoded = size ? parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null
    if (!response.ok) {
      const error = decoded as { error?: { code?: string; message?: string; request_id?: string } } | null
      throw new HostError(response.status, { code: error?.error?.code ?? 'cinema_error', message: error?.error?.message ?? `影视后端返回 ${response.status}`, request_id: error?.error?.request_id ?? '' })
    }
    return decoded as T
  }
  configuration(signal?: AbortSignal) { return this.request<Configuration>('/owner/config', undefined, signal) }
  status(signal?: AbortSignal) { return this.request<ServiceStatus>('/owner/status', undefined, signal) }
  account(revision: string, username: string, password: string, signal?: AbortSignal) { return this.request<Configuration>('/owner/account', { revision, username, password }, signal, 'PUT') }
  libraries(revision: string, libraries: LibraryDraft[], signal?: AbortSignal) { return this.request<Configuration>('/owner/libraries', { revision, libraries }, signal, 'PUT') }
  service(revision: string, running: boolean, signal?: AbortSignal) { return this.request<Configuration>(`/owner/service/${running ? 'start' : 'stop'}`, { revision }, signal) }
  refresh(signal?: AbortSignal) { return this.request<IndexStatus>('/owner/index/refresh', {}, signal) }
  catalog(query: CatalogQuery, signal?: AbortSignal) { return this.request<CatalogPage>('/owner/catalog', query, signal) }
  stat(reference: NodeReference, signal?: AbortSignal) { return this.request<FileNode>('/owner/files/stat', reference, signal) }
  directory(path: string, library_id: string, cursor: string | null, signal?: AbortSignal) { return this.request<FilePage>('/owner/files/list', { path, library_id, cursor, limit: 48 }, signal) }
  playlist(id: string, library_id: string, cursor: string | null, signal?: AbortSignal) { return this.request<FilePage>('/owner/playlist', { id, library_id, cursor, limit: 100 }, signal) }
  neighbor(id: string, library_id: string, delta: number, signal?: AbortSignal) { return this.request<{ file: FileNode | null }>('/owner/play/neighbor', { id, library_id, delta }, signal).then(value => value.file) }
  versions(id: string, library_id: string, signal?: AbortSignal) { return this.request<CinemaVersions>('/owner/versions', { id, library_id }, signal) }
  description(id: string, signal?: AbortSignal) { return this.request<MovieDescription>('/owner/description', { id }, signal) }
  cover(id: string, signal?: AbortSignal) { return this.request<{ key: string | null }>('/owner/cover', { id }, signal) }
  record<T>(key: string, signal?: AbortSignal) { return this.request<CinemaRecord<T> | null>('/owner/storage/get', { key }, signal) }
  records<T>(prefix: 'progress:' | 'favorite:', library_id: string, cursor: string | null, limit: number, signal?: AbortSignal) { return this.request<RecordPage<T>>('/owner/storage/list', { prefix, library_id, cursor, limit }, signal) }
  save<T>(key: string, value: T, revision: string | null, signal?: AbortSignal, play_id?: string) { return this.request<CinemaRecord<T>>('/owner/storage/set', { key, value, revision, ...(play_id ? { play_id } : {}) }, signal) }
  delete(key: string, revision: string, signal?: AbortSignal) { return this.request<{ ok: boolean }>('/owner/storage/delete', { key, revision }, signal) }
  beginPlayback(id: string, signal?: AbortSignal) { return this.request<{ play_id: string }>('/owner/play/start', { id }, signal) }
  endPlayback(play_id: string, signal?: AbortSignal) { return this.request<{ ok: boolean }>('/owner/play/quit', { play_id }, signal) }
  flags(id: string, signal?: AbortSignal) { return this.request<{ watched: boolean; revision: string | null }>('/owner/flags/get', { id }, signal) }
  watched(id: string, watched: boolean, revision: string | null, signal?: AbortSignal) { return this.request<{ ok: boolean }>('/owner/flags/watched', { id, watched, revision }, signal) }
  clearHistory(signal?: AbortSignal) { return this.request<{ ok: boolean }>('/owner/history/clear', {}, signal) }
  runtime(signal?: AbortSignal): Promise<RuntimeInfo> { return this.host.runtimeInfo({ signal }) }
  progress(id: string, signal?: AbortSignal) { return this.record<CinemaProgress>(`progress:${id}`, signal) }
}
