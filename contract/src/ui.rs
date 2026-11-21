//! 消息通道仅用于界面操作；不携带文件字节、不代理网络或宿主接口。

use crate::{
    ApiError,
    files::{AccessLevel, FileNode, ScopeInfo},
    runtime::Theme,
};
use serde::{Deserialize, Serialize};

pub const UI_CHANNEL: &str = "tgdrive.ui.v1";
pub const BOOTSTRAP_FRAGMENT_KEY: &str = "tgdrive";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ImmersiveRequest {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct TitleRequest {
    pub title: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct PickDirectoryRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_id: Option<String>,
}

/// 仅由页面界面消息请求主人授权；不是应用后端的 HTTP 能力。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct ScopeAuthorizationRequest {
    pub reason: String,
    pub preferred_access: AccessLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum TaskState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub struct TaskProgress {
    pub id: String,
    pub title: String,
    pub completed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    pub state: TaskState,
    #[serde(default)]
    pub cancellable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UiRequest {
    #[serde(rename = "ui.set_immersive")]
    SetImmersive(ImmersiveRequest),
    #[serde(rename = "ui.set_title")]
    SetTitle(TitleRequest),
    #[serde(rename = "ui.pick_directory")]
    PickDirectory(PickDirectoryRequest),
    #[serde(rename = "ui.request_scope")]
    RequestScope(ScopeAuthorizationRequest),
    #[serde(rename = "ui.task")]
    Task(TaskProgress),
    #[serde(rename = "ui.close")]
    Close,
    #[serde(rename = "ui.closed")]
    Closed { close_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UiValue {
    Acknowledged,
    Directory { directory: Option<FileNode> },
    Authorization { scope: Option<ScopeInfo> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UiResult {
    Ok { value: UiValue },
    Error { error: ApiError },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UiNotice {
    #[serde(rename = "ui.theme_changed")]
    ThemeChanged { theme: Theme },
    #[serde(rename = "ui.task_cancel")]
    TaskCancel { task_id: String },
    #[serde(rename = "ui.before_close")]
    BeforeClose { close_id: String, deadline_ms: u16 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "types", derive(ts_rs::TS))]
pub enum UiMessage {
    Request {
        channel: String,
        nonce: String,
        id: String,
        request: UiRequest,
    },
    Response {
        channel: String,
        nonce: String,
        id: String,
        result: UiResult,
    },
    Notice {
        channel: String,
        nonce: String,
        notice: UiNotice,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_channel_cannot_serialize_a_file_rpc() {
        let request = serde_json::json!({"method":"files.read","params":{"id":"1"}});
        assert!(serde_json::from_value::<UiRequest>(request).is_err());
        let request = UiRequest::Close;
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({"method":"ui.close"})
        );
    }

    #[test]
    fn authorization_is_a_ui_message_not_a_backend_http_request() {
        let request = UiRequest::RequestScope(ScopeAuthorizationRequest {
            reason: "选择取材目录".into(),
            preferred_access: AccessLevel::ReadOnly,
        });
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["method"], "ui.request_scope");
        assert_eq!(value["params"]["preferred_access"], "read_only");
        assert!(serde_json::from_value::<UiRequest>(value).is_ok());
    }

    #[test]
    fn task_and_theme_messages_have_fixed_wire_names() {
        let request = UiRequest::SetImmersive(ImmersiveRequest {
            active: true,
            background: None,
        });
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "method":"ui.set_immersive", "params":{"active":true}
            })
        );
        let notice = UiNotice::ThemeChanged { theme: Theme::Dark };
        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            serde_json::json!({
                "event":"ui.theme_changed", "data":{"theme":"dark"}
            })
        );
    }
}
