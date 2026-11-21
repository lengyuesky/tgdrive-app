//! 应用后端进程约定、页面启动上下文、转发调用方，以及仅主人可调用的应用中心类型。

use crate::files::{DirectoryScope, FileNode, ScopeInfo};
use crate::manifest::{
    CatalogReadResult, CatalogStatus, FilePermissions, Manifest, PackageTarget, RunMode,
};
use crate::{ByteCount, ContractVersion, Revision, Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct AppIdentity {
    pub id: String,
    pub name: String,
    pub version: String,
    pub generation: Revision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum BackendState {
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendStatus {
    pub state: BackendState,
    pub run_mode: RunMode,
    pub run_id: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum RuntimeCaller {
    Page,
    Backend,
}

/// 标明各项配置限额是否已在本轮启动中实际强制；不能把尽力而为的目标当成硬隔离。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendLimitEnforcement {
    pub memory: bool,
    pub cpu: bool,
    pub pids: bool,
    pub open_files: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendResourceLimits {
    pub memory_bytes: ByteCount,
    /// 每秒最多占用的 CPU 毫秒；1000 等于一个逻辑 CPU。
    pub cpu_millis: u32,
    pub pids: u16,
    pub open_files: u32,
    pub cache_bytes: ByteCount,
    pub database_bytes: ByteCount,
    pub enforced: BackendLimitEnforcement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RuntimeLimits {
    pub json_request_bytes: ByteCount,
    pub json_response_bytes: ByteCount,
    pub json_page_bytes: ByteCount,
    pub file_page_limit: u16,
    pub query_root_limit: u16,
    pub extension_limit: u16,
    pub mutation_operation_limit: u16,
    pub mutation_assertion_limit: u16,
    pub random_limit: u16,
    pub random_exclusion_limit: u16,
    pub kv_key_bytes: u16,
    pub kv_value_bytes: ByteCount,
    pub kv_entry_limit: u32,
    pub kv_byte_limit: ByteCount,
    pub cache_object_bytes: ByteCount,
    pub cache_metadata_bytes: ByteCount,
    pub cache_lookup_limit: u16,
    pub cache_byte_limit: ByteCount,
    pub control_concurrency: u16,
    pub byte_stream_concurrency: u16,
    pub control_requests_per_second: u16,
    pub control_burst: u16,
    pub read_lease_limit: u16,
    pub media_ticket_limit: u32,
    pub upload_limit: u16,
    pub backend: Option<BackendResourceLimits>,
}

/// 内容无关的本应用对外入口状态；平台可转发不等于应用业务服务已经启用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ExternalServiceInfo {
    /// 清单是否声明 backend.external_service。
    pub declared: bool,
    /// 平台当前可安全转发或按需唤醒；不是应用自己的业务开关或就绪状态。
    pub available: bool,
    /// 当前根地址选择是否指向本应用，独立于平台可用性与业务状态。
    pub root_assigned: bool,
    /// /admin/api/apps/v1/services/<app_id>，无尾斜杠；未声明服务时也给出该固定路径。
    pub prefix_path: String,
    /// 页面请求能可信确定公开源、且根地址属于本应用时给出，否则为 null。
    /// 后端套接字调用始终为 null，不从固定 Host=tgdrive 猜测公开源。
    pub root_url: Option<String>,
    /// 页面请求能可信确定公开源、且已声明对外服务时给出，否则为 null。
    /// 后端套接字调用始终为 null；不因 available=false 隐藏已声明入口。
    pub prefix_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RuntimeInfo {
    pub contract: ContractVersion,
    pub app: AppIdentity,
    pub caller: RuntimeCaller,
    pub capabilities: Vec<String>,
    pub files: FilePermissions,
    pub scope: ScopeInfo,
    pub limits: RuntimeLimits,
    pub backend: Option<BackendStatus>,
    /// 有后端时必须给出入口状态；没有后端的页面应用可省略或为 null。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_service: Option<ExternalServiceInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum LaunchAction {
    Browse,
    Open { file: FileNode },
}

/// 放在 iframe 的 URL 片段中，而不是 Cookie、查询参数、页面脚本或消息数据桥中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PageBootstrap {
    pub contract: ContractVersion,
    pub app: AppIdentity,
    pub session_token: String,
    pub expires_at: Timestamp,
    pub host_origin: String,
    pub api_base: String,
    pub backend_base: Option<String>,
    pub ui_nonce: String,
    pub theme: Theme,
    pub launch: LaunchAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct SessionRefreshResponse {
    pub session_token: String,
    pub expires_at: Timestamp,
}

/// 应用后端的唯一启动参数为 --tgdrive-context <此对象的 JSON 文件绝对路径>。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendStartContext {
    pub contract: ContractVersion,
    pub app: AppIdentity,
    pub run_id: String,
    pub host_socket: String,
    pub listen_socket: String,
    pub data_dir: String,
    pub database_path: String,
    pub cache_dir: String,
    pub temp_dir: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub limits: BackendResourceLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendReadyResponse {
    pub contract: ContractVersion,
    pub app_id: String,
    pub version: String,
    pub generation: Revision,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendKeepaliveRequest {
    pub ttl_seconds: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum ForwardCaller {
    Owner,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum ForwardEntry {
    Page,
    Root,
    Prefix,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ForwardContext {
    pub contract: ContractVersion,
    pub app_id: String,
    pub caller: ForwardCaller,
    pub entry: ForwardEntry,
    pub request_id: String,
    /// 原始、尚未去除转发前缀的路径和查询；不含 scheme 或 authority。
    pub original_uri: String,
    /// scheme://authority，无路径/查询/尾斜杠；与 public_base_url 使用同一可信来源。
    pub public_origin: String,
    /// 本入口的完整公开基址，无尾斜杠；页面/固定前缀入口带路径，不能用于拼接宿主票据。
    pub public_base_url: String,
    pub client_ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstalledPackage {
    pub target: PackageTarget,
    pub sha256: String,
    pub size: ByteCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstalledApp {
    pub manifest: Manifest,
    pub generation: Revision,
    pub state_revision: Revision,
    pub enabled: bool,
    pub pinned: bool,
    pub scope: ScopeInfo,
    pub package: InstalledPackage,
    pub backend: Option<BackendStatus>,
    pub installed_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RootAppSelection {
    pub app_id: Option<String>,
    pub revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstalledAppsResponse {
    pub apps: Vec<InstalledApp>,
    pub root_app: RootAppSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogResponse {
    pub status: CatalogStatus,
    pub result: CatalogReadResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogRefreshRequest {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PackageUploadReceipt {
    pub package_id: String,
    pub manifest: Manifest,
    pub package: InstalledPackage,
    pub expires_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum InstallSource {
    Catalog {
        app_id: String,
        version: String,
        target: PackageTarget,
        sha256: String,
    },
    Uploaded {
        package_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstallPreviewRequest {
    pub source: InstallSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstallPreview {
    pub preview_id: String,
    pub expires_at: Timestamp,
    pub manifest: Manifest,
    pub package: InstalledPackage,
    pub previous_state_revision: Option<Revision>,
    pub added_file_read: bool,
    pub added_file_write: bool,
    pub starts_backend: bool,
    pub external_network: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct InstallRequest {
    pub preview_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct AppStatePatch {
    pub expected_state_revision: Revision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ScopeUpdateRequest {
    pub expected_revision: Revision,
    pub scope: DirectoryScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RootAppUpdateRequest {
    pub expected_revision: Revision,
    pub app_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct LaunchPageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct LaunchPageResponse {
    pub frame_url: String,
    pub bootstrap: PageBootstrap,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_cgroup_is_reported_without_erasing_configured_targets() {
        let limits = BackendResourceLimits {
            memory_bytes: ByteCount(536_870_912),
            cpu_millis: 1000,
            pids: 64,
            open_files: 1024,
            cache_bytes: ByteCount(1_073_741_824),
            database_bytes: ByteCount(536_870_912),
            enforced: BackendLimitEnforcement {
                memory: false,
                cpu: false,
                pids: true,
                open_files: true,
            },
        };
        let value = serde_json::to_value(&limits).unwrap();
        assert_eq!(value["memory_bytes"], "536870912");
        assert_eq!(value["enforced"]["memory"], false);
        assert_eq!(value["enforced"]["cpu"], false);
        assert_eq!(value["enforced"]["pids"], true);
        assert_eq!(
            serde_json::from_value::<BackendResourceLimits>(value).unwrap(),
            limits
        );
    }

    #[test]
    fn external_entry_info_reports_state_without_inventing_socket_origin() {
        let prefix_path = format!("{}/example", crate::http::SERVICE_BASE);
        let socket = ExternalServiceInfo {
            declared: true,
            available: true,
            root_assigned: false,
            prefix_path: prefix_path.clone(),
            root_url: None,
            prefix_url: None,
        };
        let value = serde_json::to_value(&socket).unwrap();
        assert_eq!(value["prefix_path"], prefix_path);
        assert!(value["root_url"].is_null());
        assert!(value["prefix_url"].is_null());
        let page = ExternalServiceInfo {
            root_assigned: true,
            root_url: Some("https://drive.invalid".into()),
            prefix_url: Some(format!("https://drive.invalid{prefix_path}")),
            ..socket
        };
        assert_eq!(
            serde_json::from_value::<ExternalServiceInfo>(serde_json::to_value(&page).unwrap())
                .unwrap(),
            page
        );
    }

    #[test]
    fn public_origin_does_not_include_a_forwarding_prefix() {
        let context = ForwardContext {
            contract: crate::CONTRACT_VERSION,
            app_id: "example".into(),
            caller: ForwardCaller::External,
            entry: ForwardEntry::Prefix,
            request_id: "r1".into(),
            original_uri: "/admin/api/apps/v1/services/example/play".into(),
            public_origin: "https://drive.invalid".into(),
            public_base_url: "https://drive.invalid/admin/api/apps/v1/services/example".into(),
            client_ip: None,
        };
        let ticket = "/admin/api/apps/v1/media/t1";
        assert_eq!(
            format!("{}{ticket}", context.public_origin),
            "https://drive.invalid/admin/api/apps/v1/media/t1"
        );
        assert_ne!(
            format!("{}{ticket}", context.public_base_url),
            format!("{}{ticket}", context.public_origin)
        );
        assert_eq!(
            serde_json::from_value::<ForwardContext>(serde_json::to_value(&context).unwrap())
                .unwrap(),
            context
        );
        let mut missing_origin = serde_json::to_value(&context).unwrap();
        missing_origin
            .as_object_mut()
            .unwrap()
            .remove("public_origin");
        assert!(serde_json::from_value::<ForwardContext>(missing_origin).is_err());
    }

    #[test]
    fn enforcement_flags_must_be_explicit() {
        let incomplete = serde_json::json!({
            "memory_bytes":"536870912", "cpu_millis":1000, "pids":64, "open_files":1024,
            "cache_bytes":"1073741824", "database_bytes":"536870912"
        });
        assert!(serde_json::from_value::<BackendResourceLimits>(incomplete).is_err());
        assert!(
            serde_json::from_value::<BackendLimitEnforcement>(serde_json::json!({
                "memory":false, "cpu":false, "pids":true
            }))
            .is_err()
        );
    }
}
