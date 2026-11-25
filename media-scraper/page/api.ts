import { parseJson, stringifyJson } from '@tgdrive/page-sdk'
import type { HostClient } from '@tgdrive/page-sdk'
import type { Detail, DetailCursors, HistoryCursor, HistoryPage, ItemsPage, Run, Settings, SettingsDraft, Status } from './model'

export class ScraperError extends Error {
  constructor(message: string, readonly code = 'backend_error', readonly status = 500) { super(message); this.name = 'ScraperError' }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
const natural = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const cursor = (value: unknown) => value === null || natural(value)
const node = (value: unknown) => record(value) && strings(value, ['id', 'name', 'path']) && ['file', 'directory'].includes(String(value.kind))
const settings = (value: unknown) => record(value) && strings(value, ['revision', 'backend_url']) && ['token_configured', 'overwrite_nfo', 'overwrite_poster'].every(key => typeof value[key] === 'boolean') && (value.directory === null || node(value.directory))
const run = (value: unknown) => record(value) && strings(value, ['id', 'scope_revision', 'state', 'message']) && node(value.root) && natural(value.created_at) && natural(value.updated_at) && typeof value.scan_complete === 'boolean' && record(value.counts) && ['total', 'processed', 'done', 'skipped', 'failed'].every(key => natural((value.counts as Record<string, unknown>)[key])) && (value.retry_of === null || typeof value.retry_of === 'string')
const item = (value: unknown) => record(value) && strings(value, ['id', 'run_id', 'number', 'state', 'reason', 'actors_summary', 'variant']) && natural(value.position) && Array.isArray(value.files) && value.files.every(node) && Array.isArray(value.steps) && value.steps.every(step => record(step) && strings(step, ['role', 'state']))
const historyCursor = (value: unknown) => value === null || record(value) && typeof value.id === 'string' && natural(value.created_at)
const detail = (value: unknown) => record(value) && item(value.item) && ['next_step', 'next_actor', 'next_attempt'].every(key => cursor(value[key])) && Array.isArray(value.steps) && value.steps.every(step => record(step) && strings(step, ['id', 'role', 'state', 'name', 'message']) && (step.file === null || node(step.file))) && Array.isArray(value.actors) && value.actors.every(actor => record(actor) && strings(actor, ['state', 'message']) && record(actor.data) && strings(actor.data, ['name', 'role', 'thumb', 'biography', 'provider', 'id'])) && Array.isArray(value.attempts) && value.attempts.every(attempt => record(attempt) && natural(attempt.sequence) && strings(attempt, ['stage', 'provider', 'reason']))

/** 仅适配本应用协议。宿主传输、会话和排队由 SDK 负责，后端请求绝不自动重放。 */
export class ScraperApi {
  constructor(private readonly host: HostClient) {}
  private async request<T>(path: string, method: 'GET' | 'POST' | 'PUT', valid: (value: unknown) => boolean, value?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.host.backend(path, { method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: stringifyJson(value) }), signal })
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []
    let length = 0
    try {
      signal?.throwIfAborted()
      if (reader) for (;;) {
        const part = await reader.read()
        signal?.throwIfAborted()
        if (part.done) break
        length += part.value.byteLength
        if (length > 8 * 1024 * 1024) throw new ScraperError('刮削后端响应超过 8 MiB 读取预算', 'payload_too_large', 413)
        chunks.push(part.value)
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error }
    finally { reader?.releaseLock() }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let result: unknown
    try { result = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new ScraperError('刮削后端返回无效 JSON，请刷新状态', 'invalid_backend_response', response.status) }
    if (!response.ok) {
      const error = record(result) && record(result.error) ? result.error : null
      throw new ScraperError(typeof error?.message === 'string' ? error.message : `刮削请求失败（HTTP ${response.status}）`, typeof error?.code === 'string' ? error.code : 'backend_error', response.status)
    }
    if (!valid(result)) throw new ScraperError('刮削后端响应格式无效，请刷新状态', 'invalid_backend_response', response.status)
    return result as T
  }
  status(signal?: AbortSignal): Promise<Status> {
    return this.request('/owner/status', 'GET', value => record(value) && settings(value.settings) && (value.active === null || run(value.active)) && (value.latest === null || run(value.latest)), undefined, signal)
  }
  configure(revision: string, draft: SettingsDraft, token: string | null, signal?: AbortSignal): Promise<Settings> {
    return this.request('/owner/settings', 'PUT', settings, { revision, ...draft, token }, signal)
  }
  start(requestId: string, directoryId: string, retryOf: string | null, signal?: AbortSignal): Promise<Run> {
    return this.request('/owner/runs', 'POST', run, { request_id: requestId, directory_id: directoryId, retry_of: retryOf }, signal)
  }
  stop(id: string, signal?: AbortSignal): Promise<Run> { return this.request('/owner/stop', 'POST', run, { run_id: id }, signal) }
  history(after: HistoryCursor | null, signal?: AbortSignal): Promise<HistoryPage> {
    return this.request('/owner/history', 'POST', value => record(value) && Array.isArray(value.records) && value.records.every(run) && historyCursor(value.next_cursor), { cursor: after, limit: 30 }, signal)
  }
  items(id: string, after: number | null, signal?: AbortSignal): Promise<ItemsPage> {
    return this.request('/owner/items', 'POST', value => record(value) && run(value.run) && Array.isArray(value.items) && value.items.every(item) && cursor(value.next_after), { run_id: id, after, limit: 50 }, signal)
  }
  detail(id: string, cursors: DetailCursors, signal?: AbortSignal): Promise<Detail> {
    return this.request('/owner/detail', 'POST', detail, { item_id: id, after: cursors.step, actor_after: cursors.actor, attempt_after: cursors.attempt, limit: 30 }, signal)
  }
}
