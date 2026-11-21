import type * as C from '../../contract/types/contract.js'

export type RequestOptions = { signal?: AbortSignal }
export type ReadOptions = RequestOptions & { range?: string; ifNoneMatch?: string; ifRange?: string; head?: boolean }
export type ByteResponse = { status: 200 | 206 | 304; headers: Headers; body: ReadableStream<Uint8Array> | null }
export type CacheResponse = ByteResponse & { entry: C.CacheEntry }
export type EventOptions = RequestOptions & { cursor?: C.Cursor; maxReconnects?: number }
export type BackendOptions = RequestOptions & { method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'; headers?: HeadersInit; body?: BodyInit }

/** 应用业务只依赖此接口；测试替身是独立开发依赖，不进入页面包。 */
export interface HostClient {
  runtimeInfo(options?: RequestOptions): Promise<C.RuntimeInfo>
  closeSession(options?: RequestOptions): Promise<void>
  scope(options?: RequestOptions): Promise<C.ScopeInfo>
  stat(request: C.NodeReference, options?: RequestOptions): Promise<C.FileNode>
  list(request: C.ListDirectoryRequest, options?: RequestOptions): Promise<C.DirectoryPage>
  query(request: C.FileQuery, options?: RequestOptions): Promise<C.FilePage>
  directoriesWithFiles(request: C.DirectoriesWithFilesQuery, options?: RequestOptions): Promise<C.FilePage>
  random(request: C.RandomFilesRequest, options?: RequestOptions): Promise<C.RandomFilesResponse>
  changes(request: C.FileChangesRequest, options?: RequestOptions): Promise<C.FileChangesPage>
  bytes(file: C.ContentRef, options?: ReadOptions): Promise<ByteResponse>
  readRange(file: C.ContentRef, window: C.ByteWindow, options?: RequestOptions): Promise<Uint8Array>
  mediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl>
  /** 每次显式重新签发，不缓存媒体地址，也不盲目重放已产生票据的请求。 */
  renewMediaUrl(request: C.MediaUrlRequest, options?: RequestOptions): Promise<C.MediaUrl>
  createReadLease(request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease>
  renewReadLease(id: C.LeaseId, request: C.CreateReadLeaseRequest, options?: RequestOptions): Promise<C.ReadLease>
  revokeReadLease(id: C.LeaseId, options?: RequestOptions): Promise<void>
  mutate(key: string, request: C.FileMutationRequest, options?: RequestOptions): Promise<C.MutationReceipt>
  mutationReceipt(key: string, options?: RequestOptions): Promise<C.MutationReceipt>
  createUpload(key: string, request: C.CreateUploadRequest, options?: RequestOptions): Promise<C.UploadInfo>
  uploadBody(id: string, body: BodyInit, options?: RequestOptions): Promise<C.UploadInfo>
  uploadStatus(id: string, options?: RequestOptions): Promise<C.UploadInfo>
  cancelUpload(id: string, options?: RequestOptions): Promise<void>
  kvGet(key: string, options?: RequestOptions): Promise<C.KvGetResponse>
  kvPut(key: string, request: C.KvPutRequest, options?: RequestOptions): Promise<C.KvRecord>
  kvDelete(key: string, request: C.KvDeleteRequest, options?: RequestOptions): Promise<void>
  kvList(request: C.KvListRequest, options?: RequestOptions): Promise<C.KvPage>
  dataUsage(options?: RequestOptions): Promise<C.DataUsage>
  cachePut(key: string, body: BodyInit, contentType: string, metadata?: C.CachePutMetadata, options?: RequestOptions): Promise<C.CacheEntry>
  cacheGet(key: string, options?: ReadOptions): Promise<CacheResponse>
  cacheDelete(key: string, options?: RequestOptions): Promise<void>
  cacheLookup(request: C.CacheLookupRequest, options?: RequestOptions): Promise<C.CacheLookupResponse>
  events(options?: EventOptions): AsyncIterable<C.HostEvent>
  /** 后端普通业务请求不会自动重试，即使调用方使用 GET。 */
  backend(path: string, options?: BackendOptions): Promise<Response>
}

export type PageContext = Readonly<Omit<C.PageBootstrap, 'session_token' | 'expires_at'>>
export type NoticeListener = (notice: C.UiNotice) => void | Promise<void>
export type BeforeCloseHandler = (signal: AbortSignal) => void | Promise<void>
