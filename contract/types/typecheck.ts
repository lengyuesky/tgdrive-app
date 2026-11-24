// 这些示例只验证生成类型，不实现 SDK 或任何应用。
import type {
  ByteCount, NodeId, Timestamp, Manifest, Catalog, DirectoryScope, FileQuery,
  DirectoriesWithFilesQuery, RandomFilesRequest, FileMutationRequest, CreateUploadRequest,
  StreamDirective, KvPutRequest, UiMessage, HostEvent, KnownHostEvent, CachePutMetadata, CacheEntry,
  ForwardContext, PageBootstrap, BackendResourceLimits, ScopeAuthorizationRequest, RuntimeLimits,
  ExternalServiceInfo, RuntimeInfo, MediaUrl, CacheLookupResponse, LocalFileUrl,
  BackendLimitEnforcement, DataUsage,
} from './contract'
import {
  CONTRACT_VERSION, UI_CHANNEL, ENDPOINTS, ERROR_CODES, LIMITS, CAPABILITY_REQUIREMENTS,
  EVENT_NAMES, MEDIA_TICKET_BASE, CACHE_TICKET_BASE, SERVICE_BASE,
} from './contract'

export const manifest: Manifest = {
  id: 'example-app', name: '示例应用', version: '1.0.0', contract: CONTRACT_VERSION,
  description: '类型符合性示例', author: '开发者',
  files: { read: true, write: true }, page: { entry: 'page/index.html' },
  backend: { entry: 'backend/app', run_mode: 'resident', external_service: true },
  required_capabilities: ['files.query'], open_with: { extensions: [], directories: false },
  future_optional_badge: { enabled: true },
}
export const catalog: Catalog = {
  format: CONTRACT_VERSION, repository: 'example/apps', entries: [{ manifest, packages: {
    'linux-amd64': { url: 'https://github.com/example/apps/releases/download/example-app-v1.0.0/example-app-1.0.0-linux-amd64.tgapp', sha256: 'a'.repeat(64), size: '100' },
    'linux-arm64': { url: 'https://github.com/example/apps/releases/download/example-app-v1.0.0/example-app-1.0.0-linux-arm64.tgapp', sha256: 'b'.repeat(64), size: '101' },
  } }],
}
export const scope: DirectoryScope = { mode: 'selected', directories: [{ directory_id: '9223372036854775807', access: 'read_write' }] }
export const query: FileQuery = {
  roots: [], recursive: true, filter: { kind: 'file', extensions: ['epub', 'pdf'], include_hidden: false },
  sort: 'name', order: 'asc', limit: 200,
}
export const directoriesQuery: DirectoriesWithFilesQuery = {
  roots: [], file_filter: { kind: 'file', extensions: ['png', 'jpg'], include_hidden: false },
  sort: 'name', order: 'asc', limit: 200,
}
export const random: RandomFilesRequest = { roots: [], filter: query.filter, limit: 20, exclude_ids: [] }
export const mutations: FileMutationRequest = {
  scope_revision: 's1', assertions: [{ type: 'children', directory_id: '12', children_revision: 'c1' }],
  operations: [
    { type: 'mkdir', operation_id: 'folder', parent: { type: 'existing', id: '12' }, name: '示例目录' },
    { type: 'move', operation_id: 'move', node: { id: '13', revision: 'n1' }, parent: { type: 'created', operation_id: 'folder' } },
  ],
}
export const upload: CreateUploadRequest = { target: { type: 'create', parent_id: '12', name: '描述.txt' }, size: '100', scope_revision: 's1' }
export const directive: StreamDirective = {
  file: { id: '13', content_version: 'v1' }, range: 'client', disposition: 'inline', cache: 'no_store',
  window: { offset: '9007199254740993', length: '100' }, correlation_id: 'read-1',
}
export const kvPut: KvPutRequest = { value: { position: 12 }, condition: { type: 'revision', revision: 'r1' } }
export const cacheMetadata: CachePutMetadata = { metadata: { generated: true }, sources: [{ id: '13', content_version: 'v1' }] }
export const ui: UiMessage = {
  type: 'request', channel: UI_CHANNEL, nonce: 'nonce-1', id: 'ui-1',
  request: { method: 'ui.set_immersive', params: { active: true, background: '#ffffff' } },
}
export const external: ForwardContext = {
  contract: CONTRACT_VERSION, app_id: 'example-app', caller: 'external', entry: 'root',
  request_id: 'request-1', original_uri: '/endpoint?q=1', public_origin: 'https://drive.invalid', public_base_url: 'https://drive.invalid', client_ip: null,
}
export const bootstrap: PageBootstrap = {
  contract: CONTRACT_VERSION, app: { id: 'example-app', name: '示例', version: '1.0.0', generation: 'g1' },
  session_token: 'example-token', expires_at: 1, host_origin: 'https://drive.invalid',
  api_base: 'https://drive.invalid/admin/api/apps/v1/self', backend_base: null,
  ui_nonce: 'nonce-1', theme: 'dark', launch: { action: 'browse' },
}
export const unknownEvent: HostEvent = { cursor: 'e1', occurred_at: 1, event: 'future.changed', data: { future: true } }
export const knownEvent: KnownHostEvent = { event: 'files.changed', data: { change_cursor: 'f1' } }
export const knownCursor: string = knownEvent.data.change_cursor
export const largeBytes: ByteCount = '18446744073709551615'
export const timestamp: Timestamp = 1
export const endpointCount = ENDPOINTS.length
export const sessionCloseEndpoint = ENDPOINTS.find(endpoint => endpoint.name === 'session.close')
export const sessionCloseMethod: 'DELETE' | undefined = sessionCloseEndpoint?.methods[0]
export const sessionCloseCapability: 'session.refresh' | undefined = sessionCloseEndpoint?.capability
export const sessionCloseAccess: 'page_only' | undefined = sessionCloseEndpoint?.access
export const sessionCloseSocket: false | undefined = sessionCloseEndpoint?.backend_socket
export const mediaTicketSocket: true | undefined = ENDPOINTS.find(endpoint => endpoint.name === 'media.ticket')?.backend_socket
export const cacheTicketSocket: true | undefined = ENDPOINTS.find(endpoint => endpoint.name === 'cache.ticket')?.backend_socket
export const localTicketSocket: false | undefined = ENDPOINTS.find(endpoint => endpoint.name === 'local.ticket')?.backend_socket
export const centerAppsSocket: false | undefined = ENDPOINTS.find(endpoint => endpoint.name === 'center.apps')?.backend_socket
export const errorStatus: 409 = ERROR_CODES.storage_conflict
export const maxPageSize: 500 = LIMITS.MAX_PAGE_LIMIT
export const jsonRequestMax: 65536 = LIMITS.MAX_JSON_REQUEST_BYTES
export const jsonResponseMax: 2097152 = LIMITS.MAX_JSON_RESPONSE_BYTES
export const jsonPageMax: 524288 = LIMITS.MAX_JSON_PAGE_BYTES
export const jsonPageMin: 65536 = LIMITS.MIN_JSON_PAGE_BYTES
export const uiTitleMax: 120 = LIMITS.MAX_UI_TITLE_BYTES
export const authorizationReasonMax: 800 = LIMITS.MAX_AUTHORIZATION_REASON_BYTES
export const taskTitleMax: 160 = LIMITS.MAX_TASK_TITLE_BYTES
export const taskIdMax: 64 = LIMITS.MAX_TASK_ID_BYTES
export const taskProgressMax: 4294967295 = LIMITS.MAX_TASK_PROGRESS
export const opaqueIdMax: 128 = LIMITS.MAX_OPAQUE_ID_BYTES
export const nodeIdMax: '9223372036854775807' = LIMITS.MAX_NODE_ID
export const byteCountMax: '18446744073709551615' = LIMITS.MAX_BYTE_COUNT
export const nodeIdMaxBigInt: bigint = BigInt(LIMITS.MAX_NODE_ID)
export const directionalJsonLimits: Pick<RuntimeLimits, 'json_request_bytes' | 'json_response_bytes' | 'json_page_bytes'> = { json_request_bytes: '65536', json_response_bytes: '2097152', json_page_bytes: '524288' }
export const cacheEntryHeaderJsonMax: 5120 = LIMITS.MAX_CACHE_ENTRY_HEADER_JSON_BYTES
export const cacheEntryHeaderValueMax: 6827 = LIMITS.MAX_CACHE_ENTRY_HEADER_BYTES
export const cacheEntryResponse: CacheEntry = { key: 'entry-1', content_type: 'image/png', size: '10', revision: 'r1', metadata: null, updated_at: 1 }
// @ts-expect-error 缓存响应头必须是完整 CacheEntry，不能把 PUT 请求的 CachePutMetadata 当成响应。
export const invalidCacheEntryHeader: CacheEntry = cacheMetadata
export const cacheRequired: true = CAPABILITY_REQUIREMENTS['cache.objects']
export const deviceOptional: false = CAPABILITY_REQUIREMENTS['kv.device']
export const scopeAuthorization: ScopeAuthorizationRequest = { reason: '选择取材目录', preferred_access: 'read_only' }
export const backendLimits: BackendResourceLimits = {
  memory_bytes: '536870912', cpu_millis: 1000,
  enforced: { memory: false, cpu: false },
}

// @ts-expect-error 必须如实提供限额是否强制的标志，不能只发送配置目标。
export const invalidBackendLimits: BackendResourceLimits = { memory_bytes: '536870912', cpu_millis: 1000 }

export const cacheByteLimit: 1073741824 = LIMITS.DEFAULT_CACHE_BYTES
export const pageDataUsage: DataUsage = {
  kv_entries: 0, kv_bytes: '0', kv_entry_limit: 100000, kv_byte_limit: '67108864',
  cache_bytes: '0', cache_byte_limit: '1073741824', database_bytes: null,
}
export const backendDataUsage: DataUsage = { ...pageDataUsage, database_bytes: '536870912' }

// @ts-expect-error 必须分别提供内存和 CPU 是否实际强制的标志。
export const invalidBackendEnforcement: BackendLimitEnforcement = { memory: false }

// @ts-expect-error 字节数量必须是字符串，不能因 JSON 大整数损失精度。
export const invalidBytes: ByteCount = 9007199254740993
// @ts-expect-error 节点 ID 不能使用 number。
export const invalidNodeId: NodeId = 42
// @ts-expect-error 持久写入必须显式提供条件，不能无条件覆盖。
export const invalidKvPut: KvPutRequest = { value: null }
// @ts-expect-error 界面通道不能退回文件 RPC。
export const invalidUiRequest: UiMessage = { type: 'request', channel: UI_CHANNEL, nonce: 'n', id: 'i', request: { method: 'files.read', params: {} } }
export const ticketGrant: MediaUrl = { url: `${MEDIA_TICKET_BASE}/t1`, expires_at: 1, file: { id: '1', content_version: 'v1' }, representation: 'original' }
export const cacheTicket: CacheLookupResponse = { hits: [{ entry: cacheEntryResponse, url: `${CACHE_TICKET_BASE}/t1`, expires_at: 1 }] }
export const socketExternalEntry: ExternalServiceInfo = { declared: true, available: true, root_assigned: false, prefix_path: `${SERVICE_BASE}/example`, root_url: null, prefix_url: null }
export const pageExternalEntry: ExternalServiceInfo = { ...socketExternalEntry, root_assigned: true, root_url: 'https://drive.invalid', prefix_url: `https://drive.invalid${socketExternalEntry.prefix_path}` }
export const runtimeExternalEntry: Pick<RuntimeInfo, 'external_service'> = { external_service: pageExternalEntry }
export const runtimeWithoutBackend: Pick<RuntimeInfo, 'external_service'> = {}
export const runtimeWithoutExternalEntry: Pick<RuntimeInfo, 'external_service'> = { external_service: null }
export const externalEntryChanged: KnownHostEvent = { event: 'external_service.changed', data: {} }
export const hasExternalEntryEvent: boolean = EVENT_NAMES.includes('external_service.changed')
export const prefixForward: ForwardContext = { ...external, entry: 'prefix', public_base_url: `https://drive.invalid${socketExternalEntry.prefix_path}` }
export const publicTicketUrl: string = prefixForward.public_origin + ticketGrant.url
export const mediaTicketBase: '/admin/api/apps/v1/media' = MEDIA_TICKET_BASE
export const cacheTicketBase: '/admin/api/apps/v1/cache-media' = CACHE_TICKET_BASE
export const localInputGrant: LocalFileUrl = { id: 'l1', url: 'http://127.0.0.1:12345/admin/apps-local/v1/l1', expires_at: 1, byte_budget: '1', request_budget: 1 }
export const localByteBudgetDefault: 16777216 = LIMITS.DEFAULT_LOCAL_BYTE_BUDGET
export const localByteBudgetMax: 1073741824 = LIMITS.MAX_LOCAL_BYTE_BUDGET
export const localRequestBudgetDefault: 32 = LIMITS.DEFAULT_LOCAL_REQUEST_BUDGET
export const localRequestBudgetMax: 256 = LIMITS.MAX_LOCAL_REQUEST_BUDGET

// @ts-expect-error 可信公开源是必需字段，不能用含服务前缀的 public_base_url 冒充。
export const invalidForwardOrigin: ForwardContext = { contract: CONTRACT_VERSION, app_id: 'example', caller: 'external', entry: 'prefix', request_id: 'r1', original_uri: '/play', public_base_url: 'https://drive.invalid/admin/api/apps/v1/services/example', client_ip: null }
// @ts-expect-error 对外入口状态必须给出声明和平台可用性，不能只有一个业务布尔开关。
export const invalidExternalEntry: ExternalServiceInfo = { enabled: true }
// @ts-expect-error 本机字节预算仍用十进制字符串，不因块计费改成 JSON number。
export const invalidLocalByteBudget: LocalFileUrl = { ...localInputGrant, byte_budget: 16777216 }

// @ts-expect-error 应用后端必须区分主人页面与未认证的外部请求。
export const invalidCaller: ForwardContext = { ...external, caller: 'admin' }
