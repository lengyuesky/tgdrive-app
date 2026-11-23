//! 清单、分架构应用包与目录索引。未知可选字段保留而不授予任何额外权限。

use crate::{ByteCount, ContractVersion, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Extensions = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FilePermissions {
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub write: bool,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PageManifest {
    pub entry: String,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum RunMode {
    Resident,
    OnDemand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendManifest {
    pub entry: String,
    pub run_mode: RunMode,
    #[serde(default)]
    pub external_service: bool,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct OpenWith {
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub directories: bool,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 应用要求的最低契约版本；不是宿主产品版本。
    pub contract: ContractVersion,
    pub description: String,
    pub author: String,
    #[serde(default)]
    pub files: FilePermissions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<PageManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub open_with: OpenWith,
    /// 保留未知可选字段，使完整清单比较也覆盖未来的元数据。
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum PackageTarget {
    Web,
    LinuxAmd64,
    LinuxArm64,
}

impl PackageTarget {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::LinuxAmd64 => "linux-amd64",
            Self::LinuxArm64 => "linux-arm64",
        }
    }
}

pub const PACKAGE_TARGETS: &[&str] = &["web", "linux-amd64", "linux-arm64"];
pub const MANIFEST_PATH: &str = "app.json";
pub const PACKAGE_METADATA_PATH: &str = "package.json";
pub const BACKEND_ENTRY: &str = "backend/app";
pub const DATABASE_RELATIVE_PATH: &str = "state/app.sqlite3";
pub const CACHE_RELATIVE_PATH: &str = "cache";
pub const HOST_SOCKET_RELATIVE_PATH: &str = "run/host.sock";
pub const BACKEND_SOCKET_RELATIVE_PATH: &str = "run/backend/backend.sock";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PackageMetadata {
    pub format: ContractVersion,
    pub target: PackageTarget,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PackageArtifact {
    pub url: String,
    pub sha256: String,
    pub size: ByteCount,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogEntry {
    pub manifest: Manifest,
    /// 字符串键允许未来增加架构；v1 宿主只选择自己认识的目标。
    pub packages: BTreeMap<String, PackageArtifact>,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct Catalog {
    pub format: ContractVersion,
    pub repository: String,
    pub entries: Vec<CatalogEntry>,
    #[serde(flatten)]
    pub extra: Extensions,
}

/// 在解析未来契约的清单前，先读取身份与最低版本；不能先按当前完整清单反序列化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RawCatalogEntry {
    pub manifest: Value,
    pub packages: BTreeMap<String, PackageArtifact>,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct RawCatalog {
    pub format: ContractVersion,
    pub repository: String,
    pub entries: Vec<RawCatalogEntry>,
    #[serde(flatten)]
    pub extra: Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogCompatibility {
    pub id: String,
    pub version: String,
    pub contract: ContractVersion,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct IncompatibleEntry {
    pub id: String,
    pub version: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogReadResult {
    pub catalog: Catalog,
    pub incompatible: Vec<IncompatibleEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum CatalogState {
    Ready,
    Stale,
    Unavailable,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CatalogStatus {
    pub state: CatalogState,
    pub repository: String,
    pub last_success_at: Option<Timestamp>,
    pub error: Option<String>,
}

/// 归档校验器读出条目元数据后调用契约校验；此库不依赖 ZIP 或 ELF 解析库。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub path: String,
    pub kind: ArchiveEntryKind,
    pub expanded_size: u64,
    pub compression: ArchiveCompression,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveEntryKind {
    File,
    Directory,
    LinkOrSpecial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveCompression {
    Stored,
    Deflate,
    Unsupported,
}
