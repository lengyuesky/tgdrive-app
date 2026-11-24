// 此文件由 Rust 契约生成，请勿手工修改。
// 更新：npm run contract:generate；检查：npm run contract:check。

export type NodeId = string;
export type ContentVersion = string;
export type Revision = string;
export type Cursor = string;
export type LeaseId = string;

export type AccessLevel = "read_only" | "read_write";

export type ApiError = {
/**
 * 错误码是开放字符串；页面必须为未来的新错误保留通用处理分支。
 */
code: string, message: string, request_id: string, details?: JsonValue | null, retry_after_ms?: number | null, };

export type AppChangedEvent = { generation: string, enabled: boolean, };

export type AppIdentity = { id: string, name: string, version: string, generation: string, };

/**
 * 宿主设置里唯一一组应用资源限制：全部应用后端合计共用，不按应用分配。
 */

export type AppResourceLimits = {
/**
 * 全部应用后端合计的内存上限；0 表示不限制。
 */
memory_bytes: ByteCount,
/**
 * 全部应用后端合计每秒最多占用的 CPU 毫秒；1000 等于一个逻辑 CPU，0 表示不限制。
 */
cpu_millis: number,
/**
 * 该项上限当前是否已实际写入 cgroup；不限制或没有可写 cgroup 时为 false。
 */
memory_enforced: boolean, cpu_enforced: boolean, };

export type AppResourceLimitsUpdateRequest = { memory_bytes: ByteCount, cpu_millis: number, };

export type AppStatePatch = { expected_state_revision: string, enabled?: boolean | null, pinned?: boolean | null, };

export type AuthorizedRoot = { directory_id: string, access: AccessLevel,
/**
 * 根目录被回收或不再可见时为空；应用不能凭旧路径访问替代目录。
 */
node: FileNode | null, };

export type BackendChangedEvent = { state: BackendState, run_id: string | null, };

export type BackendKeepaliveRequest = { ttl_seconds: number, };

/**
 * 标明各项配置限额是否已在本轮启动中实际强制；不能把尽力而为的目标当成硬隔离。
 */

export type BackendLimitEnforcement = { memory: boolean, cpu: boolean, };

export type BackendManifest = { entry: string, run_mode: RunMode, external_service: boolean, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type BackendReadyResponse = { contract: ContractVersion, app_id: string, version: string, generation: string, run_id: string, };

export type BackendResourceLimits = {
/**
 * 宿主设置里全部应用后端合计的内存上限，不是本应用独占的份额；0 表示不限制。
 */
memory_bytes: ByteCount,
/**
 * 全部应用后端合计每秒最多占用的 CPU 毫秒；1000 等于一个逻辑 CPU，0 表示不限制。
 */
cpu_millis: number, enforced: BackendLimitEnforcement, };

/**
 * 应用后端的唯一启动参数为 --tgdrive-context <此对象的 JSON 文件绝对路径>。
 */

export type BackendStartContext = { contract: ContractVersion, app: AppIdentity, run_id: string, host_socket: string, listen_socket: string, data_dir: string, database_path: string, cache_dir: string, temp_dir: string, ffmpeg_path: string, ffprobe_path: string, limits: BackendResourceLimits, };

export type BackendState = "stopped" | "starting" | "ready" | "failed";

export type BackendStatus = { state: BackendState, run_mode: RunMode, run_id: string | null, error_code: string | null, };

/**
 * 字节数量在线上总是十进制字符串；不使用 JSON 大整数或隐式浮点转换。
 */

export type ByteCount = string;

export type ByteWindow = { offset: ByteCount, length: ByteCount, };

/**
 * 缓存元信息的唯一响应表示：PUT 的 200 正文、lookup.entry，以及缓存 GET/HEAD 响应头。
 * X-Tgdrive-Cache-Meta 响应头是无 padding base64url(UTF-8 JSON CacheEntry)。
 * metadata 最多 4096 字节；完整 JSON 最多 5120 字节，编码后的头值最多 6827 字节。
 */

export type CacheEntry = { key: string, content_type: string, size: ByteCount, revision: string, metadata: JsonValue, updated_at: Timestamp, };

/**
 * 单个缓存票据；公网与宿主套接字都只支持 GET/HEAD、If-None-Match 和 200/304。
 * 不支持 Range/If-Range，不提供 206 或 416 响应。
 */

export type CacheHit = { entry: CacheEntry,
/**
 * 所有调用方统一得到以 / 开头的同源相对缓存票据路径，不包含 scheme/authority。
 * 页面可直接使用或加 host_origin；后端仅在转交外部客户端时加 ForwardContext.public_origin。
 * 后端自身把相对路径原样经 host.sock 请求，只接受本应用当前启动轮次签发的票据。
 */
url: string, expires_at: Timestamp, };

export type CacheLookupRequest = { keys: Array<string>, };

export type CacheLookupResponse = { hits: Array<CacheHit>, };

/**
 * 仅用于 PUT 请求头：无 padding base64url(UTF-8 JSON CachePutMetadata)。
 * GET/HEAD 响应的同名 X-Tgdrive-Cache-Meta 头使用 CacheEntry，不使用本类型。
 */

export type CachePutMetadata = { metadata: JsonValue,
/**
 * 若有依赖，每次读取都重新核对授权与内容版本；失效时作为缓存未命中处理。
 */
sources: Array<ContentRef>, };

export type Catalog = { format: ContractVersion, repository: string, entries: Array<CatalogEntry>, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type CatalogCompatibility = { id: string, version: string, contract: ContractVersion, required_capabilities: Array<string>, };

export type CatalogEntry = { manifest: Manifest,
/**
 * 字符串键允许未来增加架构；v1 宿主只选择自己认识的目标。
 */
packages: { [key in string]?: PackageArtifact }, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type CatalogReadResult = { catalog: Catalog, incompatible: Array<IncompatibleEntry>, };

export type CatalogRefreshRequest = { force: boolean, };

export type CatalogResponse = { status: CatalogStatus, result: CatalogReadResult, };

export type CatalogState = "ready" | "stale" | "unavailable" | "disabled";

export type CatalogStatus = { state: CatalogState, repository: string, last_success_at: Timestamp | null, error: string | null, };

export type ContentRef = { id: string, content_version: string, };

export type ContractVersion = { major: number, minor: number, };

export type CreateReadLeaseRequest = { ttl_seconds: number, };

export type CreateUploadRequest = { target: UploadTarget, size: ByteCount, sha256?: string | null, scope_revision: string, };

export type DataUsage = { kv_entries: number, kv_bytes: ByteCount, kv_entry_limit: number, kv_byte_limit: ByteCount,
/**
 * 宿主代管的本应用可再生对象缓存占用，不含后端私有缓存与临时目录。
 */
cache_bytes: ByteCount, cache_byte_limit: ByteCount,
/**
 * 带后端应用的数据库用量；页面应用为 null，不提供数据库上限。
 */
database_bytes: ByteCount | null, };

/**
 * kv.device 可选能力的设备授权，由主人配对/设置保存；不授予目录或主人管理接口的权限。
 */

export type DeviceAppDataGrant = { app_id: string, access: AccessLevel, };

export type DirectoriesWithFilesQuery = { roots: Array<string>,
/**
 * 对直属文件应用筛选；kind 必须为 file，extensions 必须非空。
 */
file_filter: FileFilter, directory_name_contains?: string | null, sort: DirectorySort, order: SortOrder, limit: number, cursor?: string | null, };

export type DirectoryGrant = { directory_id: string, access: AccessLevel, };

/**
 * 直属条目数组按累计字节截页，directory 与游标另计入响应总预算。
 */

export type DirectoryPage = { directory: FileNode, items: Array<FileNode>, next_cursor: string | null, scan_cursor: string, scope_revision: string, };

export type DirectoryScope = { "mode": "none" } | { "mode": "selected", directories: Array<DirectoryGrant>, } | { "mode": "all", access: AccessLevel, };

export type DirectorySort = "name" | "created_at" | "modified_at" | "id";

export type DirectoryTarget = { "type": "existing", id: string, } | { "type": "created", operation_id: string, };

export type Disposition = "inline" | "attachment";

export type EmptyResponse = Record<string, never>;

export type EndpointAccess = "public" | "app" | "file_read" | "file_write" | "backend_only" | "page_only" | "owner_only" | "device_kv" | "ticket" | "external";

export type EndpointSpec = { name: string, methods: Array<string>, path: string, access: EndpointAccess, capability: string | null,
/**
 * 是否在本应用的宿主套接字注册；不替代 access、能力及目录授权检查。
 * 票据端点为 true 时，还只允许本应用当前后端启动轮次签发的票据。
 */
backend_socket: boolean, };

export type ErrorResponse = { error: ApiError, };

/**
 * 内容无关的本应用对外入口状态；平台可转发不等于应用业务服务已经启用。
 */

export type ExternalServiceInfo = {
/**
 * 清单是否声明 backend.external_service。
 */
declared: boolean,
/**
 * 平台当前可安全转发或按需唤醒；不是应用自己的业务开关或就绪状态。
 */
available: boolean,
/**
 * 当前根地址选择是否指向本应用，独立于平台可用性与业务状态。
 */
root_assigned: boolean,
/**
 * /admin/api/apps/v1/services/<app_id>，无尾斜杠；未声明服务时也给出该固定路径。
 */
prefix_path: string,
/**
 * 页面请求能可信确定公开源、且根地址属于本应用时给出，否则为 null。
 * 后端套接字调用始终为 null，不从固定 Host=tgdrive 猜测公开源。
 */
root_url: string | null,
/**
 * 页面请求能可信确定公开源、且已声明对外服务时给出，否则为 null。
 * 后端套接字调用始终为 null；不因 available=false 隐藏已声明入口。
 */
prefix_url: string | null, };

export type FileAssertion = { "type": "node", id: string, revision: string, } | { "type": "children", directory_id: string, children_revision: string, };

export type FileBytesQuery = { content_version: string, };

export type FileChange = { "type": "upsert", node: FileNode, } | { "type": "removed", id: string, } | { "type": "subtree_invalidated", id: string, previous_path: string | null, current: FileNode | null, };

/**
 * changes 数组也按累计字节截页；未装入的下一项不能被 checkpoint 消费。
 */

export type FileChangesPage = { changes: Array<FileChange>, next_cursor: string, has_more: boolean, reset_required: boolean, scope_revision: string, };

export type FileChangesRequest = { cursor?: string | null, limit: number, };

export type FileFilter = { kind: QueryKind, name_contains?: string | null, extensions: Array<string>, size?: SizeBounds | null, created_at?: TimeBounds | null, modified_at?: TimeBounds | null, include_hidden: boolean, };

export type FileMutationRequest = { scope_revision: string, assertions: Array<FileAssertion>, operations: Array<FileOperation>, };

export type FileNode = { id: string, parent_id: string | null, name: string, path: string, kind: NodeKind, size: ByteCount, created_at: Timestamp, modified_at: Timestamp, revision: string, content_version: string | null, children_revision: string | null,
/**
 * 只说明 Telegram 原文件是否附带缩略图；宿主不探测媒体、不生成内容封面。
 */
has_thumbnail: boolean, };

export type FileOperation = { "type": "mkdir", operation_id: string, parent: DirectoryTarget, name: string, } | { "type": "rename", operation_id: string, node: NodeCondition, name: string, } | { "type": "move", operation_id: string, node: NodeCondition, parent: DirectoryTarget, name?: string | null, } | { "type": "trash", operation_id: string, node: NodeCondition, } | { "type": "commit_upload", operation_id: string, upload_id: string, };

/**
 * items 数组同时受条数和累计 JSON 字节预算约束；不足 limit 时仍以 next_cursor 判定续页。
 */

export type FilePage = { items: Array<FileNode>, next_cursor: string | null, scan_cursor: string, scope_revision: string, };

export type FilePermissions = { read: boolean, write: boolean, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type FileQuery = {
/**
 * 空数组表示全部最新授权范围；查询根是筛选条件，不是额外授权。
 */
roots: Array<string>, recursive: boolean, filter: FileFilter, sort: NodeSort, order: SortOrder, limit: number, cursor?: string | null, };

export type FileRepresentation = "original" | "thumbnail";

export type FilesChangedEvent = { change_cursor: string, };

export type ForwardCaller = "owner" | "external";

export type ForwardContext = { contract: ContractVersion, app_id: string, caller: ForwardCaller, entry: ForwardEntry, request_id: string,
/**
 * 原始、尚未去除转发前缀的路径和查询；不含 scheme 或 authority。
 */
original_uri: string,
/**
 * scheme://authority，无路径/查询/尾斜杠；与 public_base_url 使用同一可信来源。
 */
public_origin: string,
/**
 * 本入口的完整公开基址，无尾斜杠；页面/固定前缀入口带路径，不能用于拼接宿主票据。
 */
public_base_url: string, client_ip: string | null, };

export type ForwardEntry = "page" | "root" | "prefix";

export type HostEvent = { cursor: string, occurred_at: Timestamp,
/**
 * 开放字符串；识别 data 时可以调用 known()，不认识的事件仍应推进游标。
 */
event: string, data: JsonValue, };

export type ImmersiveRequest = { active: boolean, background?: string | null, };

export type IncompatibleEntry = { id: string, version: string, reason: string, };

export type InstallPreview = { preview_id: string, expires_at: Timestamp, manifest: Manifest, package: InstalledPackage, previous_state_revision: string | null, added_file_read: boolean, added_file_write: boolean, starts_backend: boolean, external_network: boolean, };

export type InstallPreviewRequest = { source: InstallSource, };

export type InstallRequest = { preview_id: string, };

export type InstallSource = { "type": "catalog", app_id: string, version: string, target: PackageTarget, sha256: string, } | { "type": "uploaded", package_id: string, };

export type InstalledApp = { manifest: Manifest, generation: string, state_revision: string, enabled: boolean, pinned: boolean, scope: ScopeInfo, package: InstalledPackage, backend: BackendStatus | null, installed_at: Timestamp, updated_at: Timestamp, };

export type InstalledAppsResponse = { apps: Array<InstalledApp>, root_app: RootAppSelection, };

export type InstalledPackage = { target: PackageTarget, sha256: string, size: ByteCount, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

export type KnownHostEvent = { "event": "files.changed", "data": FilesChangedEvent } | { "event": "scope.changed", "data": ScopeChangedEvent } | { "event": "kv.changed", "data": KvChangedEvent } | { "event": "storage.changed", "data": StorageChangedEvent } | { "event": "backend.changed", "data": BackendChangedEvent } | { "event": "external_service.changed", "data": EmptyResponse } | { "event": "app.changed", "data": AppChangedEvent } | { "event": "stream.started", "data": StreamStartedEvent } | { "event": "stream.finished", "data": StreamFinishedEvent } | { "event": "sync.required", "data": SyncRequiredEvent };

export type KvChangedEvent = { key: string, revision: string | null, };

export type KvCondition = { "type": "absent" } | { "type": "revision", revision: string, };

export type KvDeleteRequest = { revision: string, };

export type KvGetResponse = {
/**
 * 不存在时是 null；记录中的 value 本身仍可以合法地为 JSON null。
 */
record: KvRecord | null, };

export type KvListRequest = { prefix: string, limit: number, cursor?: string | null, };

/**
 * records 累计 JSON 至多 512 KiB，同时受最多 200 条限制；提前截页必须返回续页游标。
 */

export type KvPage = { records: Array<KvRecord>, next_cursor: string | null, };

export type KvPutRequest = { value: JsonValue, condition: KvCondition, };

export type KvRecord = { key: string, value: JsonValue, revision: string, updated_at: Timestamp, };

export type LaunchAction = { "action": "browse" } | { "action": "open", file: FileNode, };

export type LaunchPageRequest = { open_node_id?: string | null, };

export type LaunchPageResponse = { frame_url: string, bootstrap: PageBootstrap, };

export type ListDirectoryRequest = { directory: NodeReference, sort: NodeSort, order: SortOrder, limit: number, cursor?: string | null, };

/**
 * 本机限时输入；撤销本地址须中止其全部在途读取，不论是否关联读取租约。
 */

export type LocalFileUrl = { id: string,
/**
 * 本机输入仍为 http://127.0.0.1:<port>/... 的绝对地址，仅绑定 loopback。
 */
url: string, expires_at: Timestamp,
/**
 * 签发时授予的累计上游预算，含对齐/预取字节；并发请求按块共享扣减，不预留整段。
 */
byte_budget: ByteCount,
/**
 * 签发时授予的请求次数预算；HEAD 也计次，取消或失败不归还。
 */
request_budget: number, };

export type LocalFileUrlRequest = { file: ContentRef, ttl_seconds?: number | null,
/**
 * 地址内全部并发读取共享的累计上游预算，按实际拉取的有界块扣减，不预留整段窗口。
 */
byte_budget?: ByteCount | null,
/**
 * GET/HEAD 按请求扣减，取消或失败不归还。
 */
request_budget?: number | null, lease_id?: string | null, };

export type Manifest = { id: string, name: string, version: string,
/**
 * 应用要求的最低契约版本；不是宿主产品版本。
 */
contract: ContractVersion, description: string, author: string, files: FilePermissions, page?: PageManifest | null, backend?: BackendManifest | null, icon?: string | null, required_capabilities: Array<string>, open_with: OpenWith, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type MediaUrl = {
/**
 * 所有调用方统一得到以 / 开头的同源相对票据路径，不包含 scheme/authority。
 * 页面可直接使用或加 host_origin；后端仅在转交外部客户端时加 ForwardContext.public_origin。
 * 后端自身把相对路径原样经 host.sock 请求，只接受本应用当前启动轮次签发的票据。
 */
url: string, expires_at: Timestamp, file: ContentRef, representation: FileRepresentation, };

export type MediaUrlRequest = { file: ContentRef, representation: FileRepresentation, disposition: Disposition, filename?: string | null, content_type?: string | null, ttl_seconds?: number | null, lease_id?: string | null, };

export type MutationReceipt = { idempotency_key: string, committed_at: Timestamp, results: Array<MutationResult>, expires_at: Timestamp, };

export type MutationResult = { operation_id: string, node_id: string, content_version: string | null, };

export type NodeCondition = { id: string, revision: string, };

export type NodeKind = "file" | "directory";

export type NodeReference = { "by": "id", id: string, content_version?: string | null, } | { "by": "path", path: string, content_version?: string | null, };

export type NodeSort = "name" | "size" | "created_at" | "modified_at" | "id";

export type OpenWith = { extensions: Array<string>, directories: boolean, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type PackageArtifact = { url: string, sha256: string, size: ByteCount, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type PackageMetadata = { format: ContractVersion, target: PackageTarget, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type PackageTarget = "web" | "linux-amd64" | "linux-arm64";

export type PackageUploadReceipt = { package_id: string, manifest: Manifest, package: InstalledPackage, expires_at: Timestamp, };

/**
 * 放在 iframe 的 URL 片段中，而不是 Cookie、查询参数、页面脚本或消息数据桥中。
 */

export type PageBootstrap = { contract: ContractVersion, app: AppIdentity, session_token: string, expires_at: Timestamp, host_origin: string, api_base: string, backend_base: string | null, ui_nonce: string, theme: Theme, launch: LaunchAction, };

export type PageManifest = { entry: string, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type PickDirectoryRequest = { initial_id?: string | null, };

export type QueryKind = "file" | "directory" | "all";

export type RandomFilesRequest = { roots: Array<string>, filter: FileFilter, limit: number, exclude_ids: Array<string>, };

export type RandomFilesResponse = { items: Array<FileNode>, scope_revision: string, };

export type RangePolicy = "client" | "ignore";

export type RawCatalog = { format: ContractVersion, repository: string, entries: Array<RawCatalogEntry>, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

/**
 * 在解析未来契约的清单前，先读取身份与最低版本；不能先按当前完整清单反序列化。
 */

export type RawCatalogEntry = { manifest: JsonValue, packages: { [key in string]?: PackageArtifact }, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type ReadLease = { id: string, expires_at: Timestamp, };

export type RootAppSelection = { app_id: string | null, revision: string, };

export type RootAppUpdateRequest = { expected_revision: string, app_id: string | null, };

export type RunMode = "resident" | "on_demand";

export type RuntimeCaller = "page" | "backend";

export type RuntimeInfo = { contract: ContractVersion, app: AppIdentity, caller: RuntimeCaller, capabilities: Array<string>, files: FilePermissions, scope: ScopeInfo, limits: RuntimeLimits, backend: BackendStatus | null,
/**
 * 有后端时必须给出入口状态；没有后端的页面应用可省略或为 null。
 */
external_service?: ExternalServiceInfo | null, };

export type RuntimeLimits = { json_request_bytes: ByteCount, json_response_bytes: ByteCount, json_page_bytes: ByteCount, file_page_limit: number, query_root_limit: number, extension_limit: number, mutation_operation_limit: number, mutation_assertion_limit: number, random_limit: number, random_exclusion_limit: number, kv_key_bytes: number, kv_value_bytes: ByteCount, kv_entry_limit: number, kv_byte_limit: ByteCount, cache_object_bytes: ByteCount, cache_metadata_bytes: ByteCount, cache_lookup_limit: number,
/**
 * 本应用可再生对象缓存的淘汰线，不含后端私有缓存与临时目录。
 */
cache_byte_limit: ByteCount, control_concurrency: number, byte_stream_concurrency: number, control_requests_per_second: number, control_burst: number, read_lease_limit: number, media_ticket_limit: number, upload_limit: number, backend: BackendResourceLimits | null, };

/**
 * 仅由页面界面消息请求主人授权；不是应用后端的 HTTP 能力。
 */

export type ScopeAuthorizationRequest = { reason: string, preferred_access: AccessLevel, };

export type ScopeChangedEvent = { revision: string, };

export type ScopeInfo = { revision: string, scope: DirectoryScope, roots: Array<AuthorizedRoot>, };

export type ScopeUpdateRequest = { expected_revision: string, scope: DirectoryScope, };

export type SessionRefreshResponse = { session_token: string, expires_at: Timestamp, };

export type SizeBounds = { min?: ByteCount | null, max?: ByteCount | null, };

export type SortOrder = "asc" | "desc";

export type StorageChangedEvent = { readable: boolean, writable: boolean, };

export type StreamCachePolicy = "no_store" | "private_revalidate";

/**
 * 仅在应用后端响应的 X-Tgdrive-Stream 控制头中使用；客户端不能直接提交此指令。
 */

export type StreamDirective = { file: ContentRef, window?: ByteWindow | null, range: RangePolicy, disposition: Disposition, filename?: string | null, content_type?: string | null, cache: StreamCachePolicy, lease_id?: string | null,
/**
 * 应用自行选择的关联标识；宿主不解读其业务含义。
 */
correlation_id?: string | null, };

export type StreamFinishedEvent = { request_id: string, correlation_id: string, file: ContentRef, bytes_sent: ByteCount, outcome: StreamOutcome, error_code: string | null, };

export type StreamOutcome = "completed" | "cancelled" | "failed";

export type StreamStartedEvent = { request_id: string, correlation_id: string, file: ContentRef, range: ByteWindow, lease_id: string | null, };

export type SyncRequiredEvent = {
/**
 * initial、cursor_expired、overflow、restored；未来可以增加其他原因。
 */
reason: string, };

export type TaskProgress = { id: string, title: string, completed: number, total?: number | null, state: TaskState, cancellable: boolean, };

export type TaskState = "running" | "completed" | "cancelled" | "failed";

export type Theme = "light" | "dark";

export type TimeBounds = { from?: Timestamp | null, to?: Timestamp | null, };

/**
 * Unix 毫秒；有效值限制为 0..=2^53-1，因此页面可以无损使用 number。
 */

export type Timestamp = number;

export type TitleRequest = { title: string, };

export type UiMessage = { "type": "request", channel: string, nonce: string, id: string, request: UiRequest, } | { "type": "response", channel: string, nonce: string, id: string, result: UiResult, } | { "type": "notice", channel: string, nonce: string, notice: UiNotice, };

export type UiNotice = { "event": "ui.theme_changed", "data": { theme: Theme, } } | { "event": "ui.task_cancel", "data": { task_id: string, } } | { "event": "ui.before_close", "data": { close_id: string, deadline_ms: number, } };

export type UiRequest = { "method": "ui.set_immersive", "params": ImmersiveRequest } | { "method": "ui.set_title", "params": TitleRequest } | { "method": "ui.pick_directory", "params": PickDirectoryRequest } | { "method": "ui.request_scope", "params": ScopeAuthorizationRequest } | { "method": "ui.task", "params": TaskProgress } | { "method": "ui.close" } | { "method": "ui.closed", "params": { close_id: string, } };

export type UiResult = { "status": "ok", value: UiValue, } | { "status": "error", error: ApiError, };

export type UiValue = { "type": "acknowledged" } | { "type": "directory", directory: FileNode | null, } | { "type": "authorization", scope: ScopeInfo | null, };

export type UploadInfo = { id: string, state: UploadState, size: ByteCount, received_bytes: ByteCount, expires_at: Timestamp, result: ContentRef | null, error_code: string | null, };

export type UploadState = "awaiting_body" | "receiving" | "ready" | "committed" | "failed" | "cancelled";

export type UploadTarget = { "type": "create", parent_id: string, name: string, } | { "type": "replace", node: NodeCondition, };

export type ValidationError = { code: string, field: string, message: string, };

export const CONTRACT_VERSION = {
  "major": 1,
  "minor": 0
} as const;
export const PACKAGE_FORMAT = {
  "major": 1,
  "minor": 0
} as const;
export const CATALOG_FORMAT = {
  "major": 1,
  "minor": 0
} as const;
export const UI_CHANNEL = "tgdrive.ui.v1" as const;
export const BOOTSTRAP_FRAGMENT_KEY = "tgdrive" as const;
export const ADMIN_PREFIX = "/admin" as const;
export const APP_API_PREFIX = "/admin/api/apps/v1" as const;
export const SELF_API_BASE = "/admin/api/apps/v1/self" as const;
export const APP_CENTER_BASE = "/admin/api/app-center/v1" as const;
export const NATIVE_KV_BASE = "/admin/api/native/apps/v1" as const;
export const ASSET_BASE = "/admin/apps/assets" as const;
export const SERVICE_BASE = "/admin/api/apps/v1/services" as const;
export const MEDIA_TICKET_BASE = "/admin/api/apps/v1/media" as const;
export const CACHE_TICKET_BASE = "/admin/api/apps/v1/cache-media" as const;
export const LOCAL_MEDIA_BASE = "/admin/apps-local/v1" as const;
export const BACKEND_READY_PATH = "/_tgdrive/ready" as const;
export const BACKEND_INTERNAL_PREFIX = "/_tgdrive" as const;
export const CONTEXT_ARGUMENT = "--tgdrive-context" as const;
export const FORWARD_CONTEXT_HEADER = "X-Tgdrive-Context" as const;
export const STREAM_DIRECTIVE_HEADER = "X-Tgdrive-Stream" as const;
export const STREAM_DIRECTIVE_PREFIX = "v1;" as const;
export const CACHE_METADATA_HEADER = "X-Tgdrive-Cache-Meta" as const;
export const IDEMPOTENCY_HEADER = "Idempotency-Key" as const;
export const RESERVED_COOKIE_PREFIX = "tgdrive_" as const;
export const EXTERNAL_CSP = "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" as const;
export const PAGE_CSP = "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" as const;
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, Range, If-None-Match, If-Range, Last-Event-ID, Idempotency-Key, X-Tgdrive-Cache-Meta" as const;
export const CORS_EXPOSED_HEADERS = "Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After, X-Tgdrive-Request-Id, X-Tgdrive-Cache-Meta" as const;
export const MANIFEST_PATH = "app.json" as const;
export const PACKAGE_METADATA_PATH = "package.json" as const;
export const BACKEND_ENTRY = "backend/app" as const;
export const DATABASE_RELATIVE_PATH = "state/app.sqlite3" as const;
export const CACHE_RELATIVE_PATH = "cache" as const;
export const HOST_SOCKET_RELATIVE_PATH = "run/host.sock" as const;
export const BACKEND_SOCKET_RELATIVE_PATH = "run/backend/backend.sock" as const;
export const PACKAGE_TARGETS = [
  "web",
  "linux-amd64",
  "linux-arm64"
] as const;
export const CAPABILITIES = [
  "runtime.info",
  "session.refresh",
  "scope.read",
  "files.stat",
  "files.list",
  "files.query",
  "files.directories_with_files",
  "files.random",
  "files.changes",
  "files.bytes",
  "files.media_url",
  "files.local_url",
  "files.mutate",
  "files.upload",
  "read_leases",
  "kv.cas",
  "kv.device",
  "events.sse",
  "backend.proxy",
  "backend.keepalive",
  "backend.external",
  "cache.objects",
  "ui.set_immersive",
  "ui.set_title",
  "ui.pick_directory",
  "ui.request_scope",
  "ui.task",
  "ui.close",
  "ui.theme_changed"
] as const;
export const EVENT_NAMES = [
  "files.changed",
  "scope.changed",
  "kv.changed",
  "storage.changed",
  "backend.changed",
  "external_service.changed",
  "app.changed",
  "stream.started",
  "stream.finished",
  "sync.required"
] as const;
export const ERROR_CODES = {
  "app_changed": 409,
  "app_disabled": 409,
  "backend_unavailable": 503,
  "caller_not_allowed": 403,
  "capability_unavailable": 409,
  "children_changed": 409,
  "content_changed": 409,
  "cursor_expired": 410,
  "device_revoked": 401,
  "host_maintenance": 503,
  "idempotency_conflict": 409,
  "incompatible_contract": 409,
  "internal_error": 500,
  "invalid_backend_response": 502,
  "invalid_catalog": 422,
  "invalid_cursor": 400,
  "invalid_manifest": 422,
  "invalid_operation": 422,
  "invalid_package": 422,
  "invalid_path": 400,
  "invalid_request": 400,
  "is_directory": 422,
  "lease_expired": 410,
  "length_required": 411,
  "method_not_allowed": 405,
  "name_conflict": 409,
  "node_changed": 409,
  "not_directory": 422,
  "not_found": 404,
  "package_changed": 409,
  "payload_too_large": 413,
  "quota_exceeded": 429,
  "range_not_satisfiable": 416,
  "rate_limited": 429,
  "request_timeout": 504,
  "scope_changed": 409,
  "scope_denied": 403,
  "session_expired": 401,
  "storage_conflict": 409,
  "storage_unavailable": 503,
  "ticket_expired": 410,
  "unauthorized": 401,
  "upload_expired": 410,
  "upload_state": 409,
  "upstream_unavailable": 502,
  "write_not_declared": 403
} as const;
export const CAPABILITY_REQUIREMENTS = {
  "backend.external": true,
  "backend.keepalive": true,
  "backend.proxy": true,
  "cache.objects": true,
  "events.sse": true,
  "files.bytes": true,
  "files.changes": true,
  "files.directories_with_files": true,
  "files.list": true,
  "files.local_url": true,
  "files.media_url": true,
  "files.mutate": true,
  "files.query": true,
  "files.random": true,
  "files.stat": true,
  "files.upload": true,
  "kv.cas": true,
  "kv.device": false,
  "read_leases": true,
  "runtime.info": true,
  "scope.read": true,
  "session.refresh": true,
  "ui.close": true,
  "ui.pick_directory": true,
  "ui.request_scope": true,
  "ui.set_immersive": true,
  "ui.set_title": true,
  "ui.task": true,
  "ui.theme_changed": true
} as const;
export const LIMITS = {
  "BACKEND_BYTE_CONCURRENCY": 32,
  "BACKEND_CONTROL_BURST": 600,
  "BACKEND_CONTROL_CONCURRENCY": 32,
  "BACKEND_CONTROL_RATE": 300,
  "BACKEND_IDLE_SECONDS": 300,
  "BACKEND_KEEPALIVE_SECONDS": 300,
  "BACKEND_READY_SECONDS": 30,
  "BACKEND_RESTART_WINDOW_SECONDS": 600,
  "BACKEND_STOP_SECONDS": 10,
  "CACHE_EVICTION_TARGET_PERCENT": 90,
  "CACHE_TICKET_SECONDS": 300,
  "CATALOG_CACHE_SECONDS": 300,
  "CATALOG_MIN_CHECK_SECONDS": 30,
  "CATALOG_TIMEOUT_SECONDS": 10,
  "CONTROL_TIMEOUT_SECONDS": 30,
  "DEFAULT_CACHE_BYTES": 1073741824,
  "DEFAULT_FILE_PAGE_LIMIT": 200,
  "DEFAULT_KV_BYTES": 67108864,
  "DEFAULT_KV_ENTRIES": 100000,
  "DEFAULT_KV_PAGE_LIMIT": 100,
  "DEFAULT_LOCAL_BYTE_BUDGET": 16777216,
  "DEFAULT_LOCAL_REQUEST_BUDGET": 32,
  "DEFAULT_LOCAL_TICKET_SECONDS": 60,
  "DEFAULT_MEDIA_TICKET_SECONDS": 900,
  "DEFAULT_RANDOM_LIMIT": 20,
  "DEFAULT_SHARED_BACKEND_CPU_MILLIS": 0,
  "DEFAULT_SHARED_BACKEND_MEMORY_BYTES": 2147483648,
  "FILE_CHANGE_RETENTION_SECONDS": 604800,
  "FILE_EVENT_DEBOUNCE_MILLIS": 250,
  "IMMERSIVE_COLOR_BYTES": 7,
  "IMMERSIVE_COLOR_HEX_DIGITS": 6,
  "INSTALL_PREVIEW_SECONDS": 600,
  "MAX_APP_ID_BYTES": 64,
  "MAX_AUTHORIZATION_REASON_BYTES": 800,
  "MAX_BACKEND_RESTARTS": 5,
  "MAX_BYTE_COUNT": "18446744073709551615",
  "MAX_BYTE_COUNT_DIGITS": 20,
  "MAX_CACHE_ENTRY_HEADER_BYTES": 6827,
  "MAX_CACHE_ENTRY_HEADER_JSON_BYTES": 5120,
  "MAX_CACHE_LOOKUP_KEYS": 64,
  "MAX_CACHE_METADATA_BYTES": 4096,
  "MAX_CACHE_OBJECT_BYTES": 2097152,
  "MAX_CACHE_SOURCES": 16,
  "MAX_CAPABILITY_BYTES": 80,
  "MAX_CATALOG_BYTES": 4194304,
  "MAX_CATALOG_ENTRIES": 512,
  "MAX_CONTENT_TYPE_BYTES": 256,
  "MAX_CONTRACT_VERSION_COMPONENT": 65535,
  "MAX_CURSOR_BYTES": 4096,
  "MAX_DOWNLOAD_REDIRECTS": 5,
  "MAX_DRIVE_PATH_BYTES": 4096,
  "MAX_EVENT_CONNECTIONS_PER_CALLER": 2,
  "MAX_EVENT_JOURNAL_ENTRIES": 4096,
  "MAX_EXTENSION_BYTES": 40,
  "MAX_FILE_CHANGE_JOURNAL_ENTRIES": 1000000,
  "MAX_FILE_EVENT_DELAY_MILLIS": 1000,
  "MAX_FILE_NODE_JSON_BYTES": 10240,
  "MAX_HEADER_BYTES": 32768,
  "MAX_ICON_BYTES": 262144,
  "MAX_IDEMPOTENCY_KEY_BYTES": 128,
  "MAX_JSON_PAGE_BYTES": 524288,
  "MAX_JSON_REQUEST_BYTES": 65536,
  "MAX_JSON_RESPONSE_BYTES": 2097152,
  "MAX_JSON_SAFE_INTEGER": 9007199254740991,
  "MAX_KV_KEY_BYTES": 128,
  "MAX_KV_PAGE_LIMIT": 200,
  "MAX_KV_VALUE_BYTES": 32768,
  "MAX_LOCAL_BYTE_BUDGET": 1073741824,
  "MAX_LOCAL_REQUEST_BUDGET": 256,
  "MAX_LOCAL_TICKET_SECONDS": 600,
  "MAX_MANIFEST_AUTHOR_BYTES": 160,
  "MAX_MANIFEST_BYTES": 65536,
  "MAX_MANIFEST_DESCRIPTION_BYTES": 1600,
  "MAX_MANIFEST_NAME_BYTES": 120,
  "MAX_MEDIA_TICKETS": 8192,
  "MAX_MEDIA_TICKET_SECONDS": 21600,
  "MAX_MUTATION_ASSERTIONS": 256,
  "MAX_MUTATION_OPERATIONS": 64,
  "MAX_NAME_BYTES": 255,
  "MAX_NODE_ID": "9223372036854775807",
  "MAX_NODE_ID_DIGITS": 19,
  "MAX_OPAQUE_ID_BYTES": 128,
  "MAX_OPERATION_ID_BYTES": 64,
  "MAX_PACKAGE_BYTES": 134217728,
  "MAX_PACKAGE_ENTRIES": 4096,
  "MAX_PACKAGE_EXPANDED_BYTES": 268435456,
  "MAX_PACKAGE_FILE_BYTES": 134217728,
  "MAX_PACKAGE_TARGETS": 16,
  "MAX_PACKAGE_TARGET_BYTES": 48,
  "MAX_PAGE_LIMIT": 500,
  "MAX_PROXY_BODY_BYTES": 8388608,
  "MAX_QUERY_EXTENSIONS": 64,
  "MAX_QUERY_ROOTS": 128,
  "MAX_RANDOM_CANDIDATE_STEPS": 4096,
  "MAX_RANDOM_EXCLUSIONS": 512,
  "MAX_RANDOM_LIMIT": 64,
  "MAX_READ_LEASES": 256,
  "MAX_READ_LEASE_SECONDS": 86400,
  "MAX_REPOSITORY_NAME_BYTES": 100,
  "MAX_REPOSITORY_OWNER_BYTES": 39,
  "MAX_REQUIRED_CAPABILITIES": 64,
  "MAX_RESOURCE_PATH_BYTES": 240,
  "MAX_SHARED_BACKEND_CPU_MILLIS": 256000,
  "MAX_SHARED_BACKEND_MEMORY_BYTES": 1099511627776,
  "MAX_STREAM_DIRECTIVE_BYTES": 4096,
  "MAX_TASK_ID_BYTES": 64,
  "MAX_TASK_PROGRESS": 4294967295,
  "MAX_TASK_TITLE_BYTES": 160,
  "MAX_TIMESTAMP_MILLIS": 9007199254740991,
  "MAX_UI_REQUESTS": 32,
  "MAX_UI_TITLE_BYTES": 120,
  "MAX_UNIX_SOCKET_PATH_BYTES": 107,
  "MAX_UPLOADS": 4,
  "MAX_URI_BYTES": 8192,
  "MAX_VERSION_BYTES": 80,
  "MIN_IDEMPOTENCY_KEY_BYTES": 16,
  "MIN_JSON_PAGE_BYTES": 65536,
  "MIN_POSITIVE_LIMIT": 1,
  "MIN_SHARED_BACKEND_CPU_MILLIS": 100,
  "MIN_SHARED_BACKEND_MEMORY_BYTES": 67108864,
  "MUTATION_RECEIPT_SECONDS": 604800,
  "PACKAGE_DOWNLOAD_SECONDS": 120,
  "PACKAGE_STAGING_SECONDS": 3600,
  "PAGE_BYTE_CONCURRENCY": 8,
  "PAGE_CONTROL_BURST": 240,
  "PAGE_CONTROL_CONCURRENCY": 16,
  "PAGE_CONTROL_RATE": 120,
  "PAGE_CURSOR_SECONDS": 3600,
  "PAGE_SESSION_SECONDS": 21600,
  "PROXY_FIRST_RESPONSE_SECONDS": 60,
  "SHA256_HEX_BYTES": 64,
  "SSE_HEARTBEAT_SECONDS": 15,
  "STREAM_IDLE_TIMEOUT_SECONDS": 60,
  "UI_CLOSE_GRACE_MILLIS": 2000,
  "UI_TIMEOUT_SECONDS": 300,
  "UPLOAD_RETENTION_SECONDS": 86400
} as const;
export const ENDPOINTS = [
  {
    "name": "runtime.info",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/info",
    "access": "app",
    "capability": "runtime.info",
    "backend_socket": true
  },
  {
    "name": "session.refresh",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/session/refresh",
    "access": "page_only",
    "capability": "session.refresh",
    "backend_socket": false
  },
  {
    "name": "session.close",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/session",
    "access": "page_only",
    "capability": "session.refresh",
    "backend_socket": false
  },
  {
    "name": "scope.read",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/scope",
    "access": "app",
    "capability": "scope.read",
    "backend_socket": true
  },
  {
    "name": "files.stat",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/stat",
    "access": "file_read",
    "capability": "files.stat",
    "backend_socket": true
  },
  {
    "name": "files.list",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/list",
    "access": "file_read",
    "capability": "files.list",
    "backend_socket": true
  },
  {
    "name": "files.query",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/query",
    "access": "file_read",
    "capability": "files.query",
    "backend_socket": true
  },
  {
    "name": "files.directories_with_files",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/directories-with-files",
    "access": "file_read",
    "capability": "files.directories_with_files",
    "backend_socket": true
  },
  {
    "name": "files.random",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/random",
    "access": "file_read",
    "capability": "files.random",
    "backend_socket": true
  },
  {
    "name": "files.changes",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/changes",
    "access": "file_read",
    "capability": "files.changes",
    "backend_socket": true
  },
  {
    "name": "files.bytes",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/api/apps/v1/self/files/{id}/bytes",
    "access": "file_read",
    "capability": "files.bytes",
    "backend_socket": true
  },
  {
    "name": "files.media_url",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/media-url",
    "access": "file_read",
    "capability": "files.media_url",
    "backend_socket": true
  },
  {
    "name": "files.local_url",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/local-url",
    "access": "backend_only",
    "capability": "files.local_url",
    "backend_socket": true
  },
  {
    "name": "files.local_url.revoke",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/files/local-url/{id}",
    "access": "backend_only",
    "capability": "files.local_url",
    "backend_socket": true
  },
  {
    "name": "files.mutate",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/files/mutations",
    "access": "file_write",
    "capability": "files.mutate",
    "backend_socket": true
  },
  {
    "name": "files.mutate.receipt",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/files/mutations/{key}",
    "access": "app",
    "capability": "files.mutate",
    "backend_socket": true
  },
  {
    "name": "files.upload.create",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/uploads",
    "access": "file_write",
    "capability": "files.upload",
    "backend_socket": true
  },
  {
    "name": "files.upload.body",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/apps/v1/self/uploads/{id}/body",
    "access": "file_write",
    "capability": "files.upload",
    "backend_socket": true
  },
  {
    "name": "files.upload.status",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/uploads/{id}",
    "access": "app",
    "capability": "files.upload",
    "backend_socket": true
  },
  {
    "name": "files.upload.cancel",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/uploads/{id}",
    "access": "app",
    "capability": "files.upload",
    "backend_socket": true
  },
  {
    "name": "read_leases.create",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/read-leases",
    "access": "file_read",
    "capability": "read_leases",
    "backend_socket": true
  },
  {
    "name": "read_leases.renew",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/apps/v1/self/read-leases/{id}",
    "access": "file_read",
    "capability": "read_leases",
    "backend_socket": true
  },
  {
    "name": "read_leases.revoke",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/read-leases/{id}",
    "access": "app",
    "capability": "read_leases",
    "backend_socket": true
  },
  {
    "name": "kv.get",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/kv/{key}",
    "access": "app",
    "capability": "kv.cas",
    "backend_socket": true
  },
  {
    "name": "kv.put",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/apps/v1/self/kv/{key}",
    "access": "app",
    "capability": "kv.cas",
    "backend_socket": true
  },
  {
    "name": "kv.delete",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/kv/{key}",
    "access": "app",
    "capability": "kv.cas",
    "backend_socket": true
  },
  {
    "name": "kv.list",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/kv/list",
    "access": "app",
    "capability": "kv.cas",
    "backend_socket": true
  },
  {
    "name": "data.usage",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/data/usage",
    "access": "app",
    "capability": "kv.cas",
    "backend_socket": true
  },
  {
    "name": "events",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/apps/v1/self/events",
    "access": "app",
    "capability": "events.sse",
    "backend_socket": true
  },
  {
    "name": "backend.keepalive",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/process/keepalive",
    "access": "backend_only",
    "capability": "backend.keepalive",
    "backend_socket": true
  },
  {
    "name": "backend.proxy",
    "methods": [
      "*"
    ],
    "path": "/admin/api/apps/v1/self/backend/{path}",
    "access": "page_only",
    "capability": "backend.proxy",
    "backend_socket": false
  },
  {
    "name": "cache.put",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/apps/v1/self/cache/{key}",
    "access": "app",
    "capability": "cache.objects",
    "backend_socket": true
  },
  {
    "name": "cache.get",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/api/apps/v1/self/cache/{key}",
    "access": "app",
    "capability": "cache.objects",
    "backend_socket": true
  },
  {
    "name": "cache.delete",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/apps/v1/self/cache/{key}",
    "access": "app",
    "capability": "cache.objects",
    "backend_socket": true
  },
  {
    "name": "cache.lookup",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/apps/v1/self/cache/lookup",
    "access": "app",
    "capability": "cache.objects",
    "backend_socket": true
  },
  {
    "name": "native.kv.get",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/native/apps/v1/{app_id}/kv/{key}",
    "access": "device_kv",
    "capability": "kv.device",
    "backend_socket": false
  },
  {
    "name": "native.kv.put",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/native/apps/v1/{app_id}/kv/{key}",
    "access": "device_kv",
    "capability": "kv.device",
    "backend_socket": false
  },
  {
    "name": "native.kv.delete",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/native/apps/v1/{app_id}/kv/{key}",
    "access": "device_kv",
    "capability": "kv.device",
    "backend_socket": false
  },
  {
    "name": "native.kv.list",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/native/apps/v1/{app_id}/kv/list",
    "access": "device_kv",
    "capability": "kv.device",
    "backend_socket": false
  },
  {
    "name": "media.ticket",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/api/apps/v1/media/{ticket}",
    "access": "ticket",
    "capability": null,
    "backend_socket": true
  },
  {
    "name": "cache.ticket",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/api/apps/v1/cache-media/{ticket}",
    "access": "ticket",
    "capability": null,
    "backend_socket": true
  },
  {
    "name": "local.ticket",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/apps-local/v1/{ticket}",
    "access": "ticket",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "assets",
    "methods": [
      "GET",
      "HEAD"
    ],
    "path": "/admin/apps/assets/{app_id}/{sha256}/{path}",
    "access": "public",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "external.prefix",
    "methods": [
      "*"
    ],
    "path": "/admin/api/apps/v1/services/{app_id}/{path}",
    "access": "external",
    "capability": "backend.external",
    "backend_socket": false
  },
  {
    "name": "center.apps",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/app-center/v1/apps",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.catalog",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/app-center/v1/catalog",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.catalog.refresh",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/catalog/refresh",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.package.upload",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/packages",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.install.preview",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/install/preview",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.install",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/install",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.state",
    "methods": [
      "PATCH"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}/state",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.scope",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}/scope",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.uninstall",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.cache.clear",
    "methods": [
      "DELETE"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}/cache",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.restart",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}/backend/restart",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.app.launch",
    "methods": [
      "POST"
    ],
    "path": "/admin/api/app-center/v1/apps/{app_id}/launch",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.root.read",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/app-center/v1/root-app",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.root.update",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/app-center/v1/root-app",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.limits.read",
    "methods": [
      "GET"
    ],
    "path": "/admin/api/app-center/v1/resource-limits",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  },
  {
    "name": "center.limits.update",
    "methods": [
      "PUT"
    ],
    "path": "/admin/api/app-center/v1/resource-limits",
    "access": "owner_only",
    "capability": null,
    "backend_socket": false
  }
] as const;
