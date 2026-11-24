//! 应用命名空间内的持久键值存储，以及通用、可再生小对象缓存。

use crate::{ByteCount, Cursor, Revision, Timestamp, files::ContentRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// kv.device 可选能力的设备授权，由主人配对/设置保存；不授予目录或主人管理接口的权限。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct DeviceAppDataGrant {
    pub app_id: String,
    pub access: crate::files::AccessLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvRecord {
    pub key: String,
    pub value: Value,
    pub revision: Revision,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum KvCondition {
    Absent,
    Revision { revision: Revision },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvPutRequest {
    pub value: Value,
    pub condition: KvCondition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvDeleteRequest {
    pub revision: Revision,
}

fn default_kv_limit() -> u16 {
    crate::http::DEFAULT_KV_PAGE_LIMIT as u16
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvListRequest {
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "default_kv_limit")]
    pub limit: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
}

/// records 累计 JSON 至多 512 KiB，同时受最多 200 条限制；提前截页必须返回续页游标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvPage {
    pub records: Vec<KvRecord>,
    pub next_cursor: Option<Cursor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvGetResponse {
    /// 不存在时是 null；记录中的 value 本身仍可以合法地为 JSON null。
    pub record: Option<KvRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct DataUsage {
    pub kv_entries: u32,
    pub kv_bytes: ByteCount,
    pub kv_entry_limit: u32,
    pub kv_byte_limit: ByteCount,
    /// 宿主代管的本应用可再生对象缓存占用，不含后端私有缓存与临时目录。
    pub cache_bytes: ByteCount,
    pub cache_byte_limit: ByteCount,
    /// 带后端应用的数据库用量；页面应用为 null，不提供数据库上限。
    pub database_bytes: Option<ByteCount>,
}

/// 仅用于 PUT 请求头：无 padding base64url(UTF-8 JSON CachePutMetadata)。
/// GET/HEAD 响应的同名 X-Tgdrive-Cache-Meta 头使用 CacheEntry，不使用本类型。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CachePutMetadata {
    #[serde(default)]
    pub metadata: Value,
    /// 若有依赖，每次读取都重新核对授权与内容版本；失效时作为缓存未命中处理。
    #[serde(default)]
    pub sources: Vec<ContentRef>,
}

/// 缓存元信息的唯一响应表示：PUT 的 200 正文、lookup.entry，以及缓存 GET/HEAD 响应头。
/// X-Tgdrive-Cache-Meta 响应头是无 padding base64url(UTF-8 JSON CacheEntry)。
/// metadata 最多 4096 字节；完整 JSON 最多 5120 字节，编码后的头值最多 6827 字节。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CacheEntry {
    pub key: String,
    pub content_type: String,
    pub size: ByteCount,
    pub revision: Revision,
    pub metadata: Value,
    pub updated_at: Timestamp,
}

impl CacheEntry {
    /// 将响应头及其边界直接绑定到既有 CacheEntry 类型，不新增响应 DTO。
    pub const METADATA_HEADER: &'static str = crate::http::CACHE_METADATA_HEADER;
    pub const HEADER_JSON_MAX_BYTES: u64 = crate::http::MAX_CACHE_ENTRY_HEADER_JSON_BYTES;
    pub const HEADER_VALUE_MAX_BYTES: u64 = crate::http::MAX_CACHE_ENTRY_HEADER_BYTES;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CacheLookupRequest {
    pub keys: Vec<String>,
}

/// 单个缓存票据；公网与宿主套接字都只支持 GET/HEAD、If-None-Match 和 200/304。
/// 不支持 Range/If-Range，不提供 206 或 416 响应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CacheHit {
    pub entry: CacheEntry,
    /// 所有调用方统一得到以 / 开头的同源相对缓存票据路径，不包含 scheme/authority。
    /// 页面可直接使用或加 host_origin；后端仅在转交外部客户端时加 ForwardContext.public_origin。
    /// 后端自身把相对路径原样经 host.sock 请求，只接受本应用当前启动轮次签发的票据。
    pub url: String,
    pub expires_at: Timestamp,
}

impl CacheHit {
    pub const TICKET_BASE: &'static str = crate::http::CACHE_TICKET_BASE;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct CacheLookupResponse {
    pub hits: Vec<CacheHit>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_usage_reports_database_usage_without_a_database_limit() {
        for database_bytes in [Some(ByteCount(536_870_912)), None] {
            let usage = DataUsage {
                kv_entries: 1,
                kv_bytes: ByteCount(32),
                kv_entry_limit: crate::http::DEFAULT_KV_ENTRIES as u32,
                kv_byte_limit: ByteCount(crate::http::DEFAULT_KV_BYTES),
                cache_bytes: ByteCount(1024),
                cache_byte_limit: ByteCount(crate::http::DEFAULT_CACHE_BYTES),
                database_bytes,
            };
            let value = serde_json::to_value(&usage).unwrap();
            assert_eq!(
                value,
                serde_json::json!({
                    "kv_entries": 1,
                    "kv_bytes": "32",
                    "kv_entry_limit": 100_000,
                    "kv_byte_limit": "67108864",
                    "cache_bytes": "1024",
                    "cache_byte_limit": "1073741824",
                    "database_bytes": database_bytes
                })
            );
            assert_eq!(serde_json::from_value::<DataUsage>(value).unwrap(), usage);
        }
    }
}
