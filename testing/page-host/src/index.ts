import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolveWorkerPath } from './worker-path.js'
export { resolveWorkerPath } from './worker-path.js'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { HostError, SdkError, parseJson, decodeCacheEntry, readRange, stringifyJson } from '@tgdrive/page-sdk'
import type { BackendOptions, ByteResponse, CacheResponse, EventOptions, HostClient, ReadOptions, RequestOptions } from '@tgdrive/page-sdk'
import { CONTRACT_VERSION, ENDPOINTS, LIMITS } from '@tgdrive/page-sdk/contract'
import type * as C from '@tgdrive/page-sdk/contract'

export type SeedNode = { id: C.NodeId; parent_id: C.NodeId; name: string; kind: C.NodeKind; bytes?: number[]; thumbnail?: number[] | null }
export type MemoryConfig = Pick<C.RuntimeInfo, 'app' | 'files'> & { scope: C.DirectoryScope; nodes?: SeedNode[]; now?: C.Timestamp; has_backend?: boolean }
export type FakeBackend = (request: { path: string; options: BackendOptions; context: C.ForwardContext }) => Response | Promise<Response>
type Reply = { id: number; result?: unknown; error?: { status: number; response: C.ErrorResponse } }
type Binary = { status: ByteResponse['status']; headers: Record<string, string>; bytes: number[] }

/** 本地文件只由测试调用者明确读入，生产页面不依赖此包。 */
export async function seedFile(input: Omit<SeedNode, 'kind' | 'bytes'>, path: string): Promise<SeedNode> { return { ...input, kind: 'file', bytes: [...await readFile(path)] } }

export class MemoryHost implements HostClient {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; cleanup: () => void }>()
  private eventConnections = 0
  private disposed = false
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly config: MemoryConfig, private readonly backendHandler?: FakeBackend) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      const reply = parseJson(line) as Reply
      const task = this.pending.get(reply.id)
      if (!task) return
      this.pending.delete(reply.id); task.cleanup()
      if (reply.error) task.reject(new HostError(reply.error.status, reply.error.response.error))
      else task.resolve(reply.result)
    })
    child.stderr.resume()
    child.on('error', () => this.fail(new SdkError('测试工作进程未能启动，请先构建 tgdrive-test-worker')))
    child.on('exit', () => { lines.close(); this.fail(new SdkError('测试工作进程已退出')) })
  }
  static async create(config: MemoryConfig, options: { workerPath?: string; backend?: FakeBackend } = {}): Promise<MemoryHost> {
    const path = resolveWorkerPath(options.workerPath)
    try { await access(path, constants.X_OK) } catch { throw new SdkError('测试工作进程未构建或不可执行。请先运行 cargo build -p tgdrive-test-host --bin tgdrive-test-worker；若缺 cargo，请先安装 Rust 并把 $HOME/.cargo/bin 加入 PATH。') }
    const child = spawn(path, [], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    const host = new MemoryHost(child, config, options.backend)
    try { await host.call('$init', { args: { ...config, caller: 'page', has_backend: options.backend ? true : (config.has_backend ?? false) } }); return host }
    catch (error) { await host.dispose(); throw error }
  }
  private fail(error: unknown): void { for (const task of this.pending.values()) { task.cleanup(); task.reject(error) } this.pending.clear() }
  private call<T>(method: string, input: { args?: unknown; key?: string; bytes?: number[]; options?: ReadOptions } = {}, options: RequestOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new SdkError('测试客户端已关闭'))
    options.signal?.throwIfAborted()
    if (this.pending.size >= LIMITS.PAGE_CONTROL_BURST) return Promise.reject(new SdkError('测试请求队列已满'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: unknown) => { this.pending.delete(id); cleanup(); reject(error) }
      const abort = () => cancel(options.signal?.reason)
      const timer = setTimeout(() => cancel(new SdkError('测试工作进程请求超时')), LIMITS.CONTROL_TIMEOUT_SECONDS * 1000)
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup })
      options.signal?.addEventListener('abort', abort, { once: true })
      // 取消写请求只取消等待，不声称已经执行的内存事务被回滚，也不自动重放。
      const { signal: _signal, ...readOptions } = input.options ?? {}
      try { this.child.stdin.write(stringifyJson({ id, method, ...input, options: readOptions }) + '\n', error => { if (error) cancel(new SdkError('测试工作进程写入失败')) }) }
      catch { cancel(new SdkError('测试工作进程写入失败')) }
    })
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.fail(new SdkError('测试客户端已关闭'))
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { this.child.kill('SIGTERM'); resolve() }, 1000)
      this.child.once('exit', () => { clearTimeout(timeout); resolve() })
      this.child.stdin.end()
      if (this.child.exitCode !== null) { clearTimeout(timeout); resolve() }
    })
  }
  setScope(scope: C.DirectoryScope): Promise<C.ScopeInfo> { return this.call('$scope', { args: scope }) }
  addNode(node: SeedNode): Promise<C.FileNode> { return this.call('$add', { args: node }) }
  advance(milliseconds: number): Promise<void> { return this.call('$advance', { args: milliseconds }) }
  setEnabled(enabled: boolean): Promise<void> { return this.call('$enabled', { args: enabled }) }
  reinstall(): Promise<void> { return this.call('$reinstall') }
  restart(): Promise<void> { return this.call('$restart') }
  changeNode(change: { id: C.NodeId; parent?: C.NodeId; name?: string; bytes?: number[]; visible?: boolean }): Promise<C.FileNode> { return this.call('$change', { args: change }) }
  private binary(value: Binary, head = false): ByteResponse {
    const bytes = Uint8Array.from(value.bytes)
    return { status: value.status, headers: new Headers(value.headers), body: head || value.status === 304 ? null : new ReadableStream({ start(output) { if (bytes.length) output.enqueue(bytes); output.close() } }) }
  }
  async readTicket(url: string, options: ReadOptions = {}): Promise<ByteResponse> { return this.binary(await this.call('$ticket', { key: url, options }, options), options.head) }
  runtimeInfo(options?: RequestOptions): Promise<C.RuntimeInfo> { return this.call('runtime.info', {}, options) }
  closeSession(options?: RequestOptions): Promise<void> { return this.call('session.close', {}, options) }
  scope(options?: RequestOptions): Promise<C.ScopeInfo> { return this.call('scope.read', {}, options) }
  stat(request: C.NodeReference, options?: RequestOptions): Promise<C.FileNode> { return this.call('files.stat', { args: request }, options) }
  list(request: C.ListDirectoryRequest, options?: RequestOptions): Promise<C.DirectoryPage> { return this.call('files.list', { args: request }, options) }
  query(request: C.FileQuery, options?: RequestOptions): Promise<C.FilePage> { return this.call('files.query', { args: request }, options) }
  directoriesWithFiles(request: C.DirectoriesWithFilesQuery, options?: RequestOptions): Promise<C.FilePage> { return this.call('files.directories_with_files', { args: request }, options) }
  random(request: C.RandomFilesRequest, options?: RequestOptions): Promise<C.RandomFilesResponse> { return this.call('files.random', { args: request }, options) }
  changes(request: C.FileChangesRequest, options?: RequestOptions): Promise<C.FileChangesPage> { return this.call('files.changes', { args: request }, options) }
  async bytes(file: C.ContentRef, options: ReadOptions = {}): Promise<ByteResponse> { return this.binary(await this.call('files.bytes', { args: file, options }, options), options.head) }
  readRange(file: C.ContentRef, window: C.ByteWindow, options?: RequestOptions): Promise<Uint8Array> { return readRange(this, file, window, options) }
  mediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl> { return this.call('files.media_url', { args: request }, options) }
  renewMediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl> { return this.mediaUrl(request, options) }
  createReadLease(request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease> { return this.call('read_leases.create', { args: request }, options) }
  renewReadLease(id: C.LeaseId, request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease> { return this.call('read_leases.renew', { key: id, args: request }, options) }
  revokeReadLease(id: C.LeaseId, options?: RequestOptions): Promise<void> { return this.call('read_leases.revoke', { key: id }, options) }
  mutate(key: string, request: C.FileMutationRequest, options?: RequestOptions): Promise<C.MutationReceipt> { return this.call('files.mutate', { key, args: request }, options) }
  mutationReceipt(key: string, options?: RequestOptions): Promise<C.MutationReceipt> { return this.call('files.mutate.receipt', { key }, options) }
  createUpload(key: string, request: C.CreateUploadRequest, options?: RequestOptions): Promise<C.UploadInfo> { return this.call('files.upload.create', { key, args: request }, options) }
  async uploadBody(id: string, body: BodyInit, options?: RequestOptions): Promise<C.UploadInfo> { return this.call('files.upload.body', { key: id, bytes: [...new Uint8Array(await new Response(body).arrayBuffer())] }, options) }
  uploadStatus(id: string, options?: RequestOptions): Promise<C.UploadInfo> { return this.call('files.upload.status', { key: id }, options) }
  cancelUpload(id: string, options?: RequestOptions): Promise<void> { return this.call('files.upload.cancel', { key: id }, options) }
  kvGet(key: string, options?: RequestOptions): Promise<C.KvGetResponse> { return this.call('kv.get', { key }, options) }
  kvPut(key: string, request: C.KvPutRequest, options?: RequestOptions): Promise<C.KvRecord> { return this.call('kv.put', { key, args: request }, options) }
  kvDelete(key: string, request: C.KvDeleteRequest, options?: RequestOptions): Promise<void> { return this.call('kv.delete', { key, args: request }, options) }
  kvList(request: C.KvListRequest, options?: RequestOptions): Promise<C.KvPage> { return this.call('kv.list', { args: request }, options) }
  dataUsage(options?: RequestOptions): Promise<C.DataUsage> { return this.call('data.usage', {}, options) }
  async cachePut(key: string, body: BodyInit, contentType: string, metadata: C.CachePutMetadata = { metadata: null, sources: [] }, options?: RequestOptions): Promise<C.CacheEntry> { return this.call('cache.put', { key, bytes: [...new Uint8Array(await new Response(body).arrayBuffer())], args: { content_type: contentType, metadata } }, options) }
  async cacheGet(key: string, options: ReadOptions = {}): Promise<CacheResponse> { const response = this.binary(await this.call('cache.get', { key, options }, options), options.head); return { ...response, entry: decodeCacheEntry(response.headers) } }
  cacheDelete(key: string, options?: RequestOptions): Promise<void> { return this.call('cache.delete', { key }, options) }
  cacheLookup(request: C.CacheLookupRequest, options?: RequestOptions): Promise<C.CacheLookupResponse> { return this.call('cache.lookup', { args: request }, options) }
  async *events(options: EventOptions = {}): AsyncGenerator<C.HostEvent> {
    if (this.eventConnections >= LIMITS.MAX_EVENT_CONNECTIONS_PER_CALLER) throw new SdkError('事件连接已达上限')
    this.eventConnections++
    let cursor = options.cursor
    try {
      for (;;) {
        options.signal?.throwIfAborted()
        const events = await this.call<C.HostEvent[]>('$events', { args: cursor ?? null }, options)
        for (const event of events) { cursor = event.cursor; yield event }
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason) }
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve() }, 25)
          options.signal?.addEventListener('abort', abort, { once: true })
        })
      }
    } finally { this.eventConnections-- }
  }
  async backend(path: string, options: BackendOptions = {}): Promise<Response> {
    options.signal?.throwIfAborted()
    await this.runtimeInfo(options)
    if (!this.backendHandler) throw new SdkError('测试未提供应用后端替身')
    const base = ENDPOINTS.find(endpoint => endpoint.name === 'backend.proxy')!.path.replace('/{path}', '')
    const headers = new Headers(options.headers); headers.delete('Authorization'); headers.delete('Cookie')
    const context: C.ForwardContext = { contract: CONTRACT_VERSION, app_id: this.config.app.id, caller: 'owner', entry: 'page', request_id: `test-${++this.sequence}`, original_uri: base + path, public_origin: 'https://test.invalid', public_base_url: 'https://test.invalid' + base, client_ip: null }
    return this.backendHandler({ path, options: { ...options, headers }, context })
  }
}
