//! 页面和应用后端通过 HTTP SSE 订阅有界的内存近期事件；未知事件保留原形并忽略。
//! SSE 不持久化，重启或缺口使用 sync.required；文件变更游标另有持久日志。

use crate::files::{ByteWindow, ContentRef};
use crate::runtime::BackendState;
use crate::{ByteCount, Cursor, LeaseId, Revision, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct HostEvent {
    pub cursor: Cursor,
    pub occurred_at: Timestamp,
    /// 开放字符串；识别 data 时可以调用 known()，不认识的事件仍应推进游标。
    pub event: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct FilesChangedEvent {
    pub change_cursor: Cursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ScopeChangedEvent {
    pub revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct KvChangedEvent {
    pub key: String,
    pub revision: Option<Revision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct StorageChangedEvent {
    pub readable: bool,
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct BackendChangedEvent {
    pub state: BackendState,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct AppChangedEvent {
    pub generation: Revision,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct StreamStartedEvent {
    pub request_id: String,
    pub correlation_id: String,
    pub file: ContentRef,
    pub range: ByteWindow,
    pub lease_id: Option<LeaseId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum StreamOutcome {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct StreamFinishedEvent {
    pub request_id: String,
    pub correlation_id: String,
    pub file: ContentRef,
    pub bytes_sent: ByteCount,
    pub outcome: StreamOutcome,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct SyncRequiredEvent {
    /// initial、cursor_expired、overflow、restored；未来可以增加其他原因。
    pub reason: String,
}

macro_rules! event_types {
    ($( $constant:ident => ($name:literal, $variant:ident, $body:ty) ),+ $(,)?) => {
        pub mod event_name {
            $(pub const $constant: &str = $name;)+
        }
        pub const EVENT_NAMES: &[&str] = &[$($name),+];
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(tag = "event", content = "data")]
        #[cfg_attr(feature = "types", derive(ts_rs::TS))]
        pub enum KnownHostEvent {
            $(#[serde(rename = $name)] $variant($body)),+
        }
    };
}

event_types! {
    FILES_CHANGED => ("files.changed", FilesChanged, FilesChangedEvent),
    SCOPE_CHANGED => ("scope.changed", ScopeChanged, ScopeChangedEvent),
    KV_CHANGED => ("kv.changed", KvChanged, KvChangedEvent),
    STORAGE_CHANGED => ("storage.changed", StorageChanged, StorageChangedEvent),
    BACKEND_CHANGED => ("backend.changed", BackendChanged, BackendChangedEvent),
    EXTERNAL_SERVICE_CHANGED => ("external_service.changed", ExternalServiceChanged, crate::EmptyResponse),
    APP_CHANGED => ("app.changed", AppChanged, AppChangedEvent),
    STREAM_STARTED => ("stream.started", StreamStarted, StreamStartedEvent),
    STREAM_FINISHED => ("stream.finished", StreamFinished, StreamFinishedEvent),
    SYNC_REQUIRED => ("sync.required", SyncRequired, SyncRequiredEvent),
}

impl HostEvent {
    pub fn known(&self) -> Result<Option<KnownHostEvent>, serde_json::Error> {
        if !EVENT_NAMES.contains(&self.event.as_str()) {
            return Ok(None);
        }
        serde_json::from_value(serde_json::json!({ "event": self.event, "data": self.data }))
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn future_events_are_preserved_and_ignored() {
        let raw = r#"{"cursor":"e1","occurred_at":1,"event":"future.changed","data":{"new":true},"future_field":1}"#;
        let event: HostEvent = serde_json::from_str(raw).unwrap();
        assert_eq!(event.event, "future.changed");
        assert_eq!(event.data["new"], true);
        assert!(event.known().unwrap().is_none());
    }

    #[test]
    fn external_service_change_is_a_small_hint_not_installation_revocation() {
        let event = HostEvent {
            cursor: "e1".into(),
            occurred_at: Timestamp(1),
            event: event_name::EXTERNAL_SERVICE_CHANGED.into(),
            data: serde_json::json!({}),
        };
        assert!(matches!(
            event.known().unwrap(),
            Some(KnownHostEvent::ExternalServiceChanged(
                crate::EmptyResponse {}
            ))
        ));
        let encoded = serde_json::to_value(KnownHostEvent::ExternalServiceChanged(
            crate::EmptyResponse {},
        ))
        .unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({"event":"external_service.changed","data":{}})
        );
    }

    #[test]
    fn malformed_known_event_is_not_silently_ignored() {
        let event: HostEvent = serde_json::from_value(serde_json::json!({
            "cursor":"e1", "occurred_at":1, "event":"files.changed", "data":{}
        }))
        .unwrap();
        assert!(event.known().is_err());
        let valid: HostEvent = serde_json::from_value(serde_json::json!({
            "cursor":"e2", "occurred_at":2, "event":"files.changed", "data":{"change_cursor":"f1","extra":true}
        })).unwrap();
        assert!(matches!(
            valid.known().unwrap(),
            Some(KnownHostEvent::FilesChanged(_))
        ));
    }
}
