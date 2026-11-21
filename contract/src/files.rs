//! 目录授权、与内容类型无关的文件查询、受条件约束的写入以及原文件直传。

use crate::{ByteCount, ContentVersion, Cursor, LeaseId, NodeId, Revision, Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum AccessLevel {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct DirectoryGrant {
    pub directory_id: NodeId,
    pub access: AccessLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum DirectoryScope {
    None,
    Selected { directories: Vec<DirectoryGrant> },
    All { access: AccessLevel },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ScopeInfo {
    pub revision: Revision,
    pub scope: DirectoryScope,
    pub roots: Vec<AuthorizedRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct AuthorizedRoot {
    pub directory_id: NodeId,
    pub access: AccessLevel,
    /// 根目录被回收或不再可见时为空；应用不能凭旧路径访问替代目录。
    pub node: Option<FileNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum NodeKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ContentRef {
    pub id: NodeId,
    pub content_version: ContentVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileBytesQuery {
    pub content_version: ContentVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileNode {
    pub id: NodeId,
    pub parent_id: Option<NodeId>,
    pub name: String,
    pub path: String,
    pub kind: NodeKind,
    pub size: ByteCount,
    pub created_at: Timestamp,
    pub modified_at: Timestamp,
    pub revision: Revision,
    pub content_version: Option<ContentVersion>,
    pub children_revision: Option<Revision>,
    /// 只说明 Telegram 原文件是否附带缩略图；宿主不探测媒体、不生成内容封面。
    pub has_thumbnail: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum NodeReference {
    Id {
        id: NodeId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_version: Option<ContentVersion>,
    },
    Path {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_version: Option<ContentVersion>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum QueryKind {
    #[default]
    File,
    Directory,
    All,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum NodeSort {
    #[default]
    Name,
    Size,
    CreatedAt,
    ModifiedAt,
    Id,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum SortOrder {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct SizeBounds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<ByteCount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<ByteCount>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct TimeBounds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Timestamp>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileFilter {
    #[serde(default)]
    pub kind: QueryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<SizeBounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<TimeBounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<TimeBounds>,
    #[serde(default)]
    pub include_hidden: bool,
}

pub fn default_page_limit() -> u16 {
    crate::http::DEFAULT_FILE_PAGE_LIMIT as u16
}
pub fn default_recursive() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileQuery {
    /// 空数组表示全部最新授权范围；查询根是筛选条件，不是额外授权。
    #[serde(default)]
    pub roots: Vec<NodeId>,
    #[serde(default = "default_recursive")]
    pub recursive: bool,
    #[serde(default)]
    pub filter: FileFilter,
    #[serde(default)]
    pub sort: NodeSort,
    #[serde(default)]
    pub order: SortOrder,
    #[serde(default = "default_page_limit")]
    pub limit: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ListDirectoryRequest {
    pub directory: NodeReference,
    #[serde(default)]
    pub sort: NodeSort,
    #[serde(default)]
    pub order: SortOrder,
    #[serde(default = "default_page_limit")]
    pub limit: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
}

/// items 数组同时受条数和累计 JSON 字节预算约束；不足 limit 时仍以 next_cursor 判定续页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FilePage {
    pub items: Vec<FileNode>,
    pub next_cursor: Option<Cursor>,
    pub scan_cursor: Cursor,
    pub scope_revision: Revision,
}

/// 直属条目数组按累计字节截页，directory 与游标另计入响应总预算。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct DirectoryPage {
    pub directory: FileNode,
    pub items: Vec<FileNode>,
    pub next_cursor: Option<Cursor>,
    pub scan_cursor: Cursor,
    pub scope_revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct DirectoriesWithFilesQuery {
    #[serde(default)]
    pub roots: Vec<NodeId>,
    /// 对直属文件应用筛选；kind 必须为 file，extensions 必须非空。
    pub file_filter: FileFilter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_name_contains: Option<String>,
    #[serde(default)]
    pub sort: DirectorySort,
    #[serde(default)]
    pub order: SortOrder,
    #[serde(default = "default_page_limit")]
    pub limit: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum DirectorySort {
    #[default]
    Name,
    CreatedAt,
    ModifiedAt,
    Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RandomFilesRequest {
    #[serde(default)]
    pub roots: Vec<NodeId>,
    #[serde(default)]
    pub filter: FileFilter,
    #[serde(default = "default_random_limit")]
    pub limit: u16,
    #[serde(default)]
    pub exclude_ids: Vec<NodeId>,
}
fn default_random_limit() -> u16 {
    crate::http::DEFAULT_RANDOM_LIMIT as u16
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RandomFilesResponse {
    pub items: Vec<FileNode>,
    pub scope_revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileChangesRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
    #[serde(default = "default_page_limit")]
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum FileChange {
    Upsert {
        node: FileNode,
    },
    Removed {
        id: NodeId,
    },
    /// 目录移动、回收、恢复以一个子树失效通知表示，不能膨胀成几十万条子节点事件。
    SubtreeInvalidated {
        id: NodeId,
        previous_path: Option<String>,
        current: Option<FileNode>,
    },
}

/// changes 数组也按累计字节截页；未装入的下一项不能被 checkpoint 消费。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileChangesPage {
    pub changes: Vec<FileChange>,
    pub next_cursor: Cursor,
    pub has_more: bool,
    pub reset_required: bool,
    pub scope_revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct NodeCondition {
    pub id: NodeId,
    pub revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum FileAssertion {
    Node {
        id: NodeId,
        revision: Revision,
    },
    Children {
        directory_id: NodeId,
        children_revision: Revision,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum DirectoryTarget {
    Existing { id: NodeId },
    Created { operation_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum FileOperation {
    Mkdir {
        operation_id: String,
        parent: DirectoryTarget,
        name: String,
    },
    Rename {
        operation_id: String,
        node: NodeCondition,
        name: String,
    },
    Move {
        operation_id: String,
        node: NodeCondition,
        parent: DirectoryTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Trash {
        operation_id: String,
        node: NodeCondition,
    },
    CommitUpload {
        operation_id: String,
        upload_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FileMutationRequest {
    pub scope_revision: Revision,
    #[serde(default)]
    pub assertions: Vec<FileAssertion>,
    pub operations: Vec<FileOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct MutationResult {
    pub operation_id: String,
    pub node_id: NodeId,
    pub content_version: Option<ContentVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct MutationReceipt {
    pub idempotency_key: String,
    pub committed_at: Timestamp,
    pub results: Vec<MutationResult>,
    pub expires_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UploadTarget {
    Create { parent_id: NodeId, name: String },
    Replace { node: NodeCondition },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CreateUploadRequest {
    pub target: UploadTarget,
    pub size: ByteCount,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub scope_revision: Revision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UploadState {
    AwaitingBody,
    Receiving,
    Ready,
    Committed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct UploadInfo {
    pub id: String,
    pub state: UploadState,
    pub size: ByteCount,
    pub received_bytes: ByteCount,
    pub expires_at: Timestamp,
    pub result: Option<ContentRef>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum FileRepresentation {
    #[default]
    Original,
    Thumbnail,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum Disposition {
    #[default]
    Inline,
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct MediaUrlRequest {
    pub file: ContentRef,
    #[serde(default)]
    pub representation: FileRepresentation,
    #[serde(default)]
    pub disposition: Disposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<LeaseId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct MediaUrl {
    /// 所有调用方统一得到以 / 开头的同源相对票据路径，不包含 scheme/authority。
    /// 页面可直接使用或加 host_origin；后端仅在转交外部客户端时加 ForwardContext.public_origin。
    /// 后端自身把相对路径原样经 host.sock 请求，只接受本应用当前启动轮次签发的票据。
    pub url: String,
    pub expires_at: Timestamp,
    pub file: ContentRef,
    pub representation: FileRepresentation,
}

impl MediaUrl {
    pub const TICKET_BASE: &'static str = crate::http::MEDIA_TICKET_BASE;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct LocalFileUrlRequest {
    pub file: ContentRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u16>,
    /// 地址内全部并发读取共享的累计上游预算，按实际拉取的有界块扣减，不预留整段窗口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_budget: Option<ByteCount>,
    /// GET/HEAD 按请求扣减，取消或失败不归还。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_budget: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<LeaseId>,
}

/// 本机限时输入；撤销本地址须中止其全部在途读取，不论是否关联读取租约。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct LocalFileUrl {
    pub id: String,
    /// 本机输入仍为 http://127.0.0.1:<port>/... 的绝对地址，仅绑定 loopback。
    pub url: String,
    pub expires_at: Timestamp,
    /// 签发时授予的累计上游预算，含对齐/预取字节；并发请求按块共享扣减，不预留整段。
    pub byte_budget: ByteCount,
    /// 签发时授予的请求次数预算；HEAD 也计次，取消或失败不归还。
    pub request_budget: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CreateReadLeaseRequest {
    pub ttl_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ReadLease {
    pub id: LeaseId,
    pub expires_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ByteWindow {
    pub offset: ByteCount,
    pub length: ByteCount,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum RangePolicy {
    #[default]
    Client,
    Ignore,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum StreamCachePolicy {
    #[default]
    NoStore,
    PrivateRevalidate,
}

/// 仅在应用后端响应的 X-Tgdrive-Stream 控制头中使用；客户端不能直接提交此指令。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct StreamDirective {
    pub file: ContentRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<ByteWindow>,
    #[serde(default)]
    pub range: RangePolicy,
    #[serde(default)]
    pub disposition: Disposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default)]
    pub cache: StreamCachePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<LeaseId>,
    /// 应用自行选择的关联标识；宿主不解读其业务含义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

/// 单范围的确定性结果；在宿主和契约符合性测试中复用，防止两边自行解释边界。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedRange {
    pub start: u64,
    pub length: u64,
    pub partial: bool,
}
