import { CACHE_METADATA_HEADER, IDEMPOTENCY_HEADER, LIMITS } from '../../contract/types/contract.js'
import type * as C from '../../contract/types/contract.js'
import { byteCount } from './input.js'
import { SdkError } from './error.js'
import { hostEvents } from './events.js'
import { decodeJson, encodeJson, stringifyJson } from './json.js'
import { JSON_RESULTS, wireObject } from './wire.js'
import { JSON_RESPONSE_BUDGET, readText } from './transport.js'
import type { Transport } from './transport.js'
import type { BackendOptions, ByteResponse, CacheResponse, EventOptions, HostClient, ReadOptions, RequestOptions } from './types.js'

export class HttpHostClient implements HostClient {
  constructor(private readonly transport: Transport, private readonly backendBase: string | null, private readonly origin: string) {}
  private async json<T>(name: string, request: unknown, options: RequestOptions = {}, parameters?: Record<string, string>, method?: string, headers?: HeadersInit, readOnly = false): Promise<T> {
    const body = request === undefined ? undefined : stringifyJson(request)
    if (body && new TextEncoder().encode(body).length > LIMITS.MAX_JSON_REQUEST_BYTES) throw new SdkError('JSON 请求超过契约上限')
    const response = await this.transport.request(name, { ...options, parameters, method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...Object.fromEntries(new Headers(headers)) }, body, readOnly })
    return wireObject(JSON_RESULTS[name], await readText(response, JSON_RESPONSE_BUDGET)) as T
  }
  private async unit(name: string, request: unknown, options: RequestOptions = {}, parameters?: Record<string, string>, method?: string): Promise<void> {
    const body = request === undefined ? undefined : stringifyJson(request)
    const response = await this.transport.request(name, { ...options, parameters, method, body, headers: body ? { 'Content-Type': 'application/json' } : undefined })
    if (response.status !== 204 || response.body) { await response.body?.cancel(); throw new SdkError('空成功必须为 204') }
  }
  async runtimeInfo(options?: RequestOptions): Promise<C.RuntimeInfo> {
    const info = await this.json<C.RuntimeInfo>('runtime.info', undefined, options, undefined, undefined, undefined, true)
    this.transport.configure(info.limits.control_concurrency, info.limits.byte_stream_concurrency)
    return info
  }
  closeSession(options?: RequestOptions): Promise<void> { return this.unit('session.close', undefined, options) }
  scope(options?: RequestOptions): Promise<C.ScopeInfo> { return this.json('scope.read', undefined, options, undefined, undefined, undefined, true) }
  stat(request: C.NodeReference, options?: RequestOptions): Promise<C.FileNode> { return this.json('files.stat', request, options, undefined, undefined, undefined, true) }
  list(request: C.ListDirectoryRequest, options?: RequestOptions): Promise<C.DirectoryPage> { return this.json('files.list', request, options, undefined, undefined, undefined, true) }
  query(request: C.FileQuery, options?: RequestOptions): Promise<C.FilePage> { return this.json('files.query', request, options, undefined, undefined, undefined, true) }
  directoriesWithFiles(request: C.DirectoriesWithFilesQuery, options?: RequestOptions): Promise<C.FilePage> { return this.json('files.directories_with_files', request, options, undefined, undefined, undefined, true) }
  random(request: C.RandomFilesRequest, options?: RequestOptions): Promise<C.RandomFilesResponse> { return this.json('files.random', request, options, undefined, undefined, undefined, true) }
  changes(request: C.FileChangesRequest, options?: RequestOptions): Promise<C.FileChangesPage> { return this.json('files.changes', request, options, undefined, undefined, undefined, true) }
  async bytes(file: C.ContentRef, options: ReadOptions = {}): Promise<ByteResponse> {
    const headers = conditionalHeaders(options)
    const response = await this.transport.request('files.bytes', { ...options, kind: 'bytes', readOnly: true, parameters: { id: file.id }, query: new URLSearchParams({ content_version: file.content_version }), method: options.head ? 'HEAD' : 'GET', headers })
    return checkedBytes(response, options.range)
  }
  async readRange(file: C.ContentRef, window: C.ByteWindow, options?: RequestOptions): Promise<Uint8Array> {
    return readRange(this, file, window, options)
  }
  mediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl> { return this.json('files.media_url', request, options) }
  renewMediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl> { return this.mediaUrl(request, options) }
  createReadLease(request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease> { return this.json('read_leases.create', request, options) }
  renewReadLease(id: C.LeaseId, request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease> { return this.json('read_leases.renew', request, options, { id }, 'PUT') }
  revokeReadLease(id: C.LeaseId, options?: RequestOptions): Promise<void> { return this.unit('read_leases.revoke', undefined, options, { id }) }
  mutate(key: string, request: C.FileMutationRequest, options?: RequestOptions): Promise<C.MutationReceipt> { return this.json('files.mutate', request, options, undefined, undefined, { [IDEMPOTENCY_HEADER]: key }) }
  mutationReceipt(key: string, options?: RequestOptions): Promise<C.MutationReceipt> { return this.json('files.mutate.receipt', undefined, options, { key }, undefined, undefined, true) }
  createUpload(key: string, request: C.CreateUploadRequest, options?: RequestOptions): Promise<C.UploadInfo> { return this.json('files.upload.create', request, options, undefined, undefined, { [IDEMPOTENCY_HEADER]: key }) }
  async uploadBody(id: string, body: BodyInit, options: RequestOptions = {}): Promise<C.UploadInfo> {
    const response = await this.transport.request('files.upload.body', { ...options, kind: 'bytes', parameters: { id }, body, headers: { 'Content-Type': 'application/octet-stream' } })
    return wireObject('UploadInfo', await readText(response, JSON_RESPONSE_BUDGET))
  }
  uploadStatus(id: string, options?: RequestOptions): Promise<C.UploadInfo> { return this.json('files.upload.status', undefined, options, { id }, undefined, undefined, true) }
  cancelUpload(id: string, options?: RequestOptions): Promise<void> { return this.unit('files.upload.cancel', undefined, options, { id }) }
  kvGet(key: string, options?: RequestOptions): Promise<C.KvGetResponse> { return this.json('kv.get', undefined, options, { key }, undefined, undefined, true) }
  kvPut(key: string, request: C.KvPutRequest, options?: RequestOptions): Promise<C.KvRecord> { return this.json('kv.put', request, options, { key }) }
  kvDelete(key: string, request: C.KvDeleteRequest, options?: RequestOptions): Promise<void> { return this.unit('kv.delete', request, options, { key }) }
  kvList(request: C.KvListRequest, options?: RequestOptions): Promise<C.KvPage> { return this.json('kv.list', request, options, undefined, undefined, undefined, true) }
  dataUsage(options?: RequestOptions): Promise<C.DataUsage> { return this.json('data.usage', undefined, options, undefined, undefined, undefined, true) }
  async cachePut(key: string, body: BodyInit, contentType: string, metadata?: C.CachePutMetadata, options: RequestOptions = {}): Promise<C.CacheEntry> {
    const response = await this.transport.request('cache.put', { ...options, kind: 'bytes', parameters: { key }, body, headers: { 'Content-Type': contentType, ...(metadata ? { [CACHE_METADATA_HEADER]: encodeJson(metadata) } : {}) } })
    return wireObject('CacheEntry', await readText(response, JSON_RESPONSE_BUDGET))
  }
  async cacheGet(key: string, options: ReadOptions = {}): Promise<CacheResponse> {
    const response = await this.transport.request('cache.get', { ...options, kind: 'bytes', readOnly: true, parameters: { key }, method: options.head ? 'HEAD' : 'GET', headers: conditionalHeaders(options) })
    try { return { ...checkedBytes(response), entry: decodeCacheEntry(response.headers) } }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error }
  }
  cacheDelete(key: string, options?: RequestOptions): Promise<void> { return this.unit('cache.delete', undefined, options, { key }) }
  cacheLookup(request: C.CacheLookupRequest, options?: RequestOptions): Promise<C.CacheLookupResponse> { return this.json('cache.lookup', request, options) }
  events(options?: EventOptions): AsyncIterable<C.HostEvent> { return hostEvents(this.transport, options) }
  async backend(path: string, options: BackendOptions = {}): Promise<Response> {
    if (!this.backendBase) throw new SdkError('当前应用没有应用后端')
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u001f]/.test(path) || /%(?:2f|5c|00)/i.test(path)) throw new SdkError('应用后端路径无效')
    const base = new URL(this.backendBase, this.origin).href.replace(/\/$/, '')
    const url = new URL(base + path)
    if (!url.href.startsWith(base + '/')) throw new SdkError('应用后端路径越界')
    const headers = new Headers(options.headers)
    for (const name of [...headers.keys()]) if (/^(?:cookie|host|x-tgdrive-)/i.test(name)) headers.delete(name)
    return this.transport.request('backend.proxy', { ...options, parameters: { path: '' }, url: url.href, headers, method: options.method ?? 'GET', rawErrors: true })
  }
}

export function decodeCacheEntry(headers: Headers): C.CacheEntry {
  const encoded = headers.get(CACHE_METADATA_HEADER)
  if (!encoded || encoded.length > LIMITS.MAX_CACHE_ENTRY_HEADER_BYTES) throw new SdkError('缓存响应元信息头缺失或超限')
  const json = decodeJson(encoded)
  if (new TextEncoder().encode(json).length > LIMITS.MAX_CACHE_ENTRY_HEADER_JSON_BYTES) throw new SdkError('完整缓存条目超过契约上限')
  return wireObject('CacheEntry', json)
}

export function conditionalHeaders(options: ReadOptions): Headers {
  const headers = new Headers()
  if (options.range) headers.set('Range', options.range)
  if (options.ifNoneMatch) headers.set('If-None-Match', options.ifNoneMatch)
  if (options.ifRange) headers.set('If-Range', options.ifRange)
  return headers
}
export function checkedBytes(response: Response, requestedRange?: string): ByteResponse {
  if (![200, 206, 304].includes(response.status)) { void response.body?.cancel(); throw new SdkError('宿主字节响应状态无效') }
  if (response.status === 206) {
    const content = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers.get('Content-Range') ?? '')
    const length = response.headers.get('Content-Length')
    if (!content || !length || !/^[0-9]+$/.test(length)) { void response.body?.cancel(); throw new SdkError('206 缺少有效的区间或长度') }
    const [start, end, total] = content.slice(1).map(BigInt)
    const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(requestedRange?.trim() ?? '')
    let expectedStart: bigint, expectedEnd: bigint
    if (!match || !total || !match[1] && !match[2]) { void response.body?.cancel(); throw new SdkError('206 与请求不符') }
    if (!match[1]) { const suffix = BigInt(match[2]); expectedStart = suffix > total ? 0n : total - suffix; expectedEnd = total - 1n; if (!suffix) throw new SdkError('后缀 Range 无效') }
    else { expectedStart = BigInt(match[1]); expectedEnd = match[2] ? BigInt(match[2]) : total - 1n; if (expectedEnd >= total) expectedEnd = total - 1n }
    if (start !== expectedStart || end !== expectedEnd || end < start || end >= total || BigInt(length) !== end - start + 1n) { void response.body?.cancel(); throw new SdkError('206 的 Content-Range/Content-Length 与请求不符') }
  }
  return { status: response.status as ByteResponse['status'], headers: response.headers, body: response.body }
}

export async function readRange(host: Pick<HostClient, 'bytes'>, file: C.ContentRef, window: C.ByteWindow, options?: RequestOptions): Promise<Uint8Array> {
  const offset = byteCount(window.offset), length = byteCount(window.length)
  if (offset < 0n || length <= 0n || length > BigInt(LIMITS.MAX_JSON_SAFE_INTEGER)) throw new SdkError('读取区间或调用方内存预算无效')
  const response = await host.bytes(file, { ...options, range: `bytes=${offset}-${offset + length - 1n}` })
  if (response.status !== 206 || !response.body || BigInt(response.headers.get('Content-Length') ?? '-1') !== length) { await response.body?.cancel(); throw new SdkError('Range 未精确满足，拒绝整文件回退') }
  const output = new Uint8Array(Number(length))
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (received + chunk.value.length > output.length) throw new SdkError('Range 正文超出声明长度')
      output.set(chunk.value, received); received += chunk.value.length
    }
    if (received !== output.length) throw new SdkError('Range 正文被截断')
    return output
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}
