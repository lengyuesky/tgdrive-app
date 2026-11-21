//! 不含内容业务的应用后端 SDK。宿主客户端可替换为测试库的内存实现。
//! 只提供 Unix HTTP 传输，不替应用选择外网客户端、TLS 或数据库。

mod client;
mod context;
mod events;
mod io;
mod server;

pub use client::{HostClient, UnixHostClient};
pub use context::{StartContext, parse_forward_context};
pub use hyper::http;
pub use server::{BackendServer, ForwardRequest, Shutdown, stream_response};
pub use tgdrive_contract as contract;

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::body::Frame;
use std::{future::Future, pin::Pin};
use tgdrive_contract::{ApiError, ErrorResponse, error_code, error_http_status};

pub type Result<T> = std::result::Result<T, Error>;
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;
pub type EventStream = Pin<Box<dyn Stream<Item = Result<contract::events::HostEvent>> + Send>>;
pub type HttpBody = UnsyncBoxBody<Bytes, Error>;
pub type HttpResponse = http::Response<HttpBody>;

#[derive(Debug)]
pub enum Error {
    Api { status: u16, error: ApiError },
    Validation(contract::validation::ValidationError),
    Protocol(&'static str),
    Transport,
    Timeout,
    Cancelled,
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl Error {
    pub fn api(code: &str, message: &str) -> Self {
        Self::Api {
            status: error_http_status(code).unwrap_or(500),
            error: ApiError {
                code: code.into(),
                message: message.into(),
                request_id: "sdk".into(),
                details: None,
                retry_after_ms: None,
            },
        }
    }
    pub fn code(&self) -> &str {
        match self {
            Self::Api { error, .. } => &error.code,
            Self::Validation(error) => &error.code,
            Self::Timeout => error_code::REQUEST_TIMEOUT,
            Self::Transport => error_code::UPSTREAM_UNAVAILABLE,
            _ => error_code::INVALID_REQUEST,
        }
    }
    pub fn response(&self, request_id: &str) -> HttpResponse {
        let mut error = match self {
            Self::Api { error, .. } => error.clone(),
            _ => ApiError {
                code: self.code().into(),
                message: "应用请求未能完成".into(),
                request_id: request_id.into(),
                details: None,
                retry_after_ms: None,
            },
        };
        error.request_id = request_id.into();
        let status = match self {
            Self::Api { status, .. } => *status,
            _ => error_http_status(self.code()).unwrap_or(500),
        };
        json_response(status, &ErrorResponse { error }).expect("错误对象可以序列化")
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不显示内部异常链、套接字路径、完整票据或外部凭据。
        match self {
            Self::Api { error, .. } => write!(f, "{}：{}", error.code, error.message),
            Self::Validation(error) => error.fmt(f),
            _ => f.write_str("SDK 请求未能完成"),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
impl From<contract::validation::ValidationError> for Error {
    fn from(value: contract::validation::ValidationError) -> Self {
        Self::Validation(value)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ReadOptions {
    pub range: Option<String>,
    pub if_none_match: Option<String>,
    pub if_range: Option<String>,
    pub head: bool,
}

pub struct ByteResponse {
    pub status: http::StatusCode,
    pub headers: http::HeaderMap,
    /// 丢弃流即取消读取；调用者自己决定是否以及最多缓冲多少字节。
    pub body: ByteStream,
}

pub fn empty_body() -> HttpBody {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed_unsync()
}
pub fn bytes_body(bytes: impl Into<Bytes>) -> HttpBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}
pub fn stream_body(body: ByteStream) -> HttpBody {
    StreamBody::new(body.map(|chunk| chunk.map(Frame::data))).boxed_unsync()
}
pub fn byte_stream(bytes: impl Into<Bytes>) -> ByteStream {
    let bytes = bytes.into();
    Box::pin(stream::once(async { Ok(bytes) }))
}
pub fn json_response<T: serde::Serialize>(status: u16, value: &T) -> Result<HttpResponse> {
    let bytes = serde_json::to_vec(value)?;
    contract::validation::parse_unique_json(&bytes)?;
    http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(bytes_body(bytes))
        .map_err(|_| Error::Protocol("响应头无效"))
}

/// 所有层级先严格解析，再解码线上对象；serde 的位置数组不是协议对象。
pub fn decode_json<T: serde::de::DeserializeOwned + serde::Serialize>(bytes: &[u8]) -> Result<T> {
    let value = contract::validation::parse_unique_json(bytes)?;
    if !value.is_object() {
        return Err(Error::Protocol("JSON 必须为对象"));
    }
    let decoded: T = serde_json::from_value(value.clone())?;
    validate_object_shapes(&value, &serde_json::to_value(&decoded)?)?;
    Ok(decoded)
}

fn validate_object_shapes(raw: &serde_json::Value, canonical: &serde_json::Value) -> Result<()> {
    match (raw, canonical) {
        (serde_json::Value::Array(_), serde_json::Value::Object(_)) => {
            Err(Error::Protocol("结构体不能使用位置数组"))
        }
        (serde_json::Value::Object(raw), serde_json::Value::Object(canonical)) => {
            for (key, value) in canonical {
                if let Some(raw) = raw.get(key) {
                    validate_object_shapes(raw, value)?;
                }
            }
            Ok(())
        }
        (serde_json::Value::Array(raw), serde_json::Value::Array(canonical)) => {
            for (raw, canonical) in raw.iter().zip(canonical) {
                validate_object_shapes(raw, canonical)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub async fn collect_bytes(mut stream: ByteStream, limit: u64) -> Result<Bytes> {
    let mut output = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if (output.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "读取超过调用方预算",
            ));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(output))
}
