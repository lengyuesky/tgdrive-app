//! 宿主与应用契约第 1 版。此库只定义传输类型、常量与校验，不执行网盘或应用业务。

pub mod data;
pub mod events;
pub mod files;
pub mod http;
pub mod manifest;
pub mod runtime;
pub mod ui;
pub mod validation;

use serde::{Deserialize, Serialize};

/// 节点 ID 使用十进制字符串，其他引用是不透明字符串；两类都不传 JSON 大整数。
macro_rules! wire_aliases {
    ($($name:ident = $value:ty),+ $(,)?) => {
        $(pub type $name = $value;)+
        #[cfg(feature = "types")]
        pub fn typescript_aliases() -> Vec<String> {
            vec![$(format!("export type {} = {};", stringify!($name), <$value as ts_rs::TS>::name())),+]
        }
    };
}
wire_aliases! {
    NodeId = String,
    ContentVersion = String,
    Revision = String,
    Cursor = String,
    LeaseId = String,
}
/// Unix 毫秒；有效值限制为 0..=2^53-1，因此页面可以无损使用 number。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct Timestamp(#[cfg_attr(feature = "types", ts(type = "number"))] pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ContractVersion {
    pub major: u16,
    pub minor: u16,
}

pub const CONTRACT_VERSION: ContractVersion = ContractVersion { major: 1, minor: 0 };
pub const PACKAGE_FORMAT: ContractVersion = CONTRACT_VERSION;
pub const CATALOG_FORMAT: ContractVersion = CONTRACT_VERSION;

/// 字节数量在线上总是十进制字符串；不使用 JSON 大整数或隐式浮点转换。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ByteCount(
    #[serde(with = "decimal_u64")]
    #[cfg_attr(feature = "types", ts(type = "string"))]
    pub u64,
);

impl From<u64> for ByteCount {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || value.len() > crate::http::MAX_BYTE_COUNT_DIGITS as usize
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(D::Error::custom("字节数量必须是无前导零的十进制字符串"));
        }
        value.parse().map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct EmptyResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ErrorResponse {
    pub error: ApiError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ApiError {
    /// 错误码是开放字符串；页面必须为未来的新错误保留通用处理分支。
    pub code: String,
    pub message: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u32>,
}

/// 单一清单生成错误码、HTTP 状态与页面常量，避免另抄一份映射。
macro_rules! error_codes {
    ($( $name:ident => ($code:literal, $status:literal) ),+ $(,)?) => {
        pub mod error_code {
            $(pub const $name: &str = $code;)+
        }
        pub const ERROR_CODES: &[(&str, u16)] = &[$(($code, $status)),+];
        pub fn error_http_status(code: &str) -> Option<u16> {
            ERROR_CODES.iter().find(|(name, _)| *name == code).map(|(_, status)| *status)
        }
    };
}

error_codes! {
    INVALID_REQUEST => ("invalid_request", 400),
    INVALID_CURSOR => ("invalid_cursor", 400),
    INVALID_PATH => ("invalid_path", 400),
    UNAUTHORIZED => ("unauthorized", 401),
    SESSION_EXPIRED => ("session_expired", 401),
    DEVICE_REVOKED => ("device_revoked", 401),
    SCOPE_DENIED => ("scope_denied", 403),
    WRITE_NOT_DECLARED => ("write_not_declared", 403),
    CALLER_NOT_ALLOWED => ("caller_not_allowed", 403),
    NOT_FOUND => ("not_found", 404),
    METHOD_NOT_ALLOWED => ("method_not_allowed", 405),
    APP_CHANGED => ("app_changed", 409),
    APP_DISABLED => ("app_disabled", 409),
    CONTENT_CHANGED => ("content_changed", 409),
    NODE_CHANGED => ("node_changed", 409),
    CHILDREN_CHANGED => ("children_changed", 409),
    SCOPE_CHANGED => ("scope_changed", 409),
    STORAGE_CONFLICT => ("storage_conflict", 409),
    NAME_CONFLICT => ("name_conflict", 409),
    UPLOAD_STATE => ("upload_state", 409),
    IDEMPOTENCY_CONFLICT => ("idempotency_conflict", 409),
    INCOMPATIBLE_CONTRACT => ("incompatible_contract", 409),
    PACKAGE_CHANGED => ("package_changed", 409),
    CAPABILITY_UNAVAILABLE => ("capability_unavailable", 409),
    CURSOR_EXPIRED => ("cursor_expired", 410),
    TICKET_EXPIRED => ("ticket_expired", 410),
    LEASE_EXPIRED => ("lease_expired", 410),
    UPLOAD_EXPIRED => ("upload_expired", 410),
    LENGTH_REQUIRED => ("length_required", 411),
    PAYLOAD_TOO_LARGE => ("payload_too_large", 413),
    RANGE_NOT_SATISFIABLE => ("range_not_satisfiable", 416),
    NOT_DIRECTORY => ("not_directory", 422),
    IS_DIRECTORY => ("is_directory", 422),
    INVALID_OPERATION => ("invalid_operation", 422),
    INVALID_MANIFEST => ("invalid_manifest", 422),
    INVALID_PACKAGE => ("invalid_package", 422),
    INVALID_CATALOG => ("invalid_catalog", 422),
    RATE_LIMITED => ("rate_limited", 429),
    QUOTA_EXCEEDED => ("quota_exceeded", 429),
    INTERNAL_ERROR => ("internal_error", 500),
    INVALID_BACKEND_RESPONSE => ("invalid_backend_response", 502),
    UPSTREAM_UNAVAILABLE => ("upstream_unavailable", 502),
    BACKEND_UNAVAILABLE => ("backend_unavailable", 503),
    STORAGE_UNAVAILABLE => ("storage_unavailable", 503),
    HOST_MAINTENANCE => ("host_maintenance", 503),
    REQUEST_TIMEOUT => ("request_timeout", 504),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_counts_are_lossless_decimal_strings() {
        for value in [0, 1, 9_007_199_254_740_993, u64::MAX] {
            let json = serde_json::to_string(&ByteCount(value)).unwrap();
            assert_eq!(json, format!("\"{value}\""));
            assert_eq!(
                serde_json::from_str::<ByteCount>(&json).unwrap(),
                ByteCount(value)
            );
        }
        for raw in ["1", "\"01\"", "\"-1\"", "\"\"", "\"18446744073709551616\""] {
            assert!(
                serde_json::from_str::<ByteCount>(raw).is_err(),
                "不应接受 {raw}"
            );
        }
    }

    #[test]
    fn error_codes_are_unique_and_have_valid_statuses() {
        let mut seen = std::collections::BTreeSet::new();
        for (code, status) in ERROR_CODES {
            assert!(seen.insert(code));
            assert!((400..=599).contains(status));
            assert_eq!(error_http_status(code), Some(*status));
        }
        assert_eq!(error_http_status("future_error"), None);
    }
}
