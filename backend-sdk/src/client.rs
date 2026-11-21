use crate::{
    ByteResponse, ByteStream, Error, EventStream, HostFuture, HttpBody, ReadOptions, Result,
    StartContext, bytes_body, collect_bytes, decode_json, empty_body, stream_body,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::BodyExt;
use hyper::{
    Request, Response,
    body::Incoming,
    client::conn::http1::SendRequest,
    http::{HeaderMap, Method},
};
use hyper_util::rt::TokioIo;
use std::{sync::Arc, time::Duration};
use tgdrive_contract::{ErrorResponse, data::*, files::*, http::*, runtime::*, validation::*};
use tokio::{
    net::UnixStream,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
};

/// 应用业务只依赖这个接口；内存替身位于独立的测试 crate。
pub trait HostClient: Send + Sync {
    fn runtime_info(&self) -> HostFuture<'_, RuntimeInfo>;
    fn scope(&self) -> HostFuture<'_, ScopeInfo>;
    fn stat(&self, request: NodeReference) -> HostFuture<'_, FileNode>;
    fn list(&self, request: ListDirectoryRequest) -> HostFuture<'_, DirectoryPage>;
    fn query(&self, request: FileQuery) -> HostFuture<'_, FilePage>;
    fn directories_with_files(
        &self,
        request: DirectoriesWithFilesQuery,
    ) -> HostFuture<'_, FilePage>;
    fn random(&self, request: RandomFilesRequest) -> HostFuture<'_, RandomFilesResponse>;
    fn changes(&self, request: FileChangesRequest) -> HostFuture<'_, FileChangesPage>;
    fn bytes(&self, file: ContentRef, options: ReadOptions) -> HostFuture<'_, ByteResponse>;
    /// 经专用宿主套接字原样读取自己本轮签发的媒体／缓存票据，不需要公开源。
    fn ticket_bytes(&self, url: String, options: ReadOptions) -> HostFuture<'_, ByteResponse>;
    fn media_url(&self, request: MediaUrlRequest) -> HostFuture<'_, MediaUrl>;
    fn local_url(&self, request: LocalFileUrlRequest) -> HostFuture<'_, LocalFileUrl>;
    fn revoke_local_url(&self, id: String) -> HostFuture<'_, ()>;
    fn create_read_lease(&self, request: CreateReadLeaseRequest) -> HostFuture<'_, ReadLease>;
    fn renew_read_lease(
        &self,
        id: String,
        request: CreateReadLeaseRequest,
    ) -> HostFuture<'_, ReadLease>;
    fn revoke_read_lease(&self, id: String) -> HostFuture<'_, ()>;
    fn mutate(&self, key: String, request: FileMutationRequest) -> HostFuture<'_, MutationReceipt>;
    fn mutation_receipt(&self, key: String) -> HostFuture<'_, MutationReceipt>;
    fn create_upload(
        &self,
        key: String,
        request: CreateUploadRequest,
    ) -> HostFuture<'_, UploadInfo>;
    fn upload_body(
        &self,
        id: String,
        body: ByteStream,
        length: Option<u64>,
    ) -> HostFuture<'_, UploadInfo>;
    fn upload_status(&self, id: String) -> HostFuture<'_, UploadInfo>;
    fn cancel_upload(&self, id: String) -> HostFuture<'_, ()>;
    fn kv_get(&self, key: String) -> HostFuture<'_, KvGetResponse>;
    fn kv_put(&self, key: String, request: KvPutRequest) -> HostFuture<'_, KvRecord>;
    fn kv_delete(&self, key: String, request: KvDeleteRequest) -> HostFuture<'_, ()>;
    fn kv_list(&self, request: KvListRequest) -> HostFuture<'_, KvPage>;
    fn data_usage(&self) -> HostFuture<'_, DataUsage>;
    fn cache_put(
        &self,
        key: String,
        body: ByteStream,
        content_type: String,
        metadata: CachePutMetadata,
    ) -> HostFuture<'_, CacheEntry>;
    fn cache_get(&self, key: String, options: ReadOptions) -> HostFuture<'_, ByteResponse>;
    fn cache_delete(&self, key: String) -> HostFuture<'_, ()>;
    fn cache_lookup(&self, request: CacheLookupRequest) -> HostFuture<'_, CacheLookupResponse>;
    fn events(&self, cursor: Option<String>) -> HostFuture<'_, EventStream>;
    fn keepalive(&self, request: BackendKeepaliveRequest) -> HostFuture<'_, ()>;
}

type Pool = Arc<Mutex<Vec<SendRequest<HttpBody>>>>;
#[derive(Clone)]
pub struct UnixHostClient {
    socket: Arc<String>,
    control: Arc<Semaphore>,
    byte_slots: Arc<Semaphore>,
    pub(crate) event_slots: Arc<Semaphore>,
    control_pool: Pool,
    byte_pool: Pool,
    event_pool: Pool,
}

pub(crate) struct RawResponse {
    pub response: Response<Incoming>,
    pub permit: OwnedSemaphorePermit,
}

pub(crate) fn endpoint_path(name: &str, parameters: &[(&str, &str)]) -> String {
    let mut path = ENDPOINTS
        .iter()
        .find(|endpoint| endpoint.name == name)
        .expect("接口来自契约注册表")
        .path
        .to_owned();
    for (key, value) in parameters {
        path = path.replace(&format!("{{{key}}}"), &encode_component(value));
    }
    path
}
fn encode_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut result, "%{byte:02X}").expect("写入字符串");
        }
    }
    result
}

impl UnixHostClient {
    pub fn new(start: &StartContext) -> Self {
        Self {
            socket: Arc::new(start.context.host_socket.clone()),
            control: Arc::new(Semaphore::new(BACKEND_CONTROL_CONCURRENCY as usize)),
            byte_slots: Arc::new(Semaphore::new(BACKEND_BYTE_CONCURRENCY as usize)),
            event_slots: Arc::new(Semaphore::new(MAX_EVENT_CONNECTIONS_PER_CALLER as usize)),
            control_pool: Arc::default(),
            byte_pool: Arc::default(),
            event_pool: Arc::default(),
        }
    }

    async fn send(
        &self,
        path: String,
        method: Method,
        mut headers: HeaderMap,
        body: HttpBody,
        kind: u8,
    ) -> Result<RawResponse> {
        let (slots, pool) = match kind {
            1 => (&self.byte_slots, &self.byte_pool),
            2 => (&self.event_slots, &self.event_pool),
            _ => (&self.control, &self.control_pool),
        };
        let permit = tokio::time::timeout(
            Duration::from_secs(CONTROL_TIMEOUT_SECONDS),
            slots.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Cancelled)?;
        let mut sender = loop {
            match pool.lock().await.pop() {
                Some(sender) if !sender.is_closed() => break sender,
                Some(_) => continue,
                None => {
                    let socket = tokio::time::timeout(
                        Duration::from_secs(CONTROL_TIMEOUT_SECONDS),
                        UnixStream::connect(&*self.socket),
                    )
                    .await
                    .map_err(|_| Error::Timeout)?
                    .map_err(|_| Error::Transport)?;
                    #[cfg(target_os = "linux")]
                    if socket.peer_cred().map_err(|_| Error::Transport)?.uid() != 0 {
                        return Err(Error::api(
                            tgdrive_contract::error_code::UNAUTHORIZED,
                            "宿主套接字身份无效",
                        ));
                    }
                    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(
                        crate::io::IdleIo::new(socket),
                    ))
                    .await
                    .map_err(|_| Error::Transport)?;
                    tokio::spawn(async move {
                        let _ = connection.await;
                    });
                    break sender;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(CONTROL_TIMEOUT_SECONDS), sender.ready())
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Transport)?;
        // 套接字决定身份，不能携带主人凭据或在请求中指定应用 ID。
        headers.insert("Host", "tgdrive".parse().expect("固定 Host 合法"));
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .body(body)
            .map_err(|_| Error::Protocol("请求 URI 无效"))?;
        *request.headers_mut() = headers;
        let future = sender.send_request(request);
        let response = if kind == 1 {
            // 上传可持续很久；流的各次读写另有空闲时限，不用普通控制总时限截断它。
            future.await.map_err(|_| Error::Transport)?
        } else {
            tokio::time::timeout(Duration::from_secs(CONTROL_TIMEOUT_SECONDS), future)
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|_| Error::Transport)?
        };
        pool.lock().await.push(sender);
        Ok(RawResponse { response, permit })
    }

    pub(crate) async fn event_response(&self, cursor: Option<&str>) -> Result<RawResponse> {
        let mut headers = HeaderMap::new();
        headers.insert("Accept", "text/event-stream".parse().unwrap());
        if let Some(cursor) = cursor {
            headers.insert(
                "Last-Event-ID",
                cursor
                    .parse()
                    .map_err(|_| Error::Protocol("事件游标头无效"))?,
            );
        }
        self.send(
            endpoint_path("events", &[]),
            Method::GET,
            headers,
            empty_body(),
            2,
        )
        .await
    }

    async fn json<T: serde::de::DeserializeOwned + serde::Serialize>(
        &self,
        endpoint: &str,
        params: &[(&str, &str)],
        method: Method,
        request: Option<serde_json::Value>,
        headers: HeaderMap,
        read_only: bool,
    ) -> Result<T> {
        let mut headers = headers;
        let bytes = match request {
            Some(value) => {
                let bytes = serde_json::to_vec(&value)?;
                parse_unique_json(&bytes)?;
                if bytes.len() as u64 > MAX_JSON_REQUEST_BYTES {
                    return Err(Error::api(
                        tgdrive_contract::error_code::PAYLOAD_TOO_LARGE,
                        "JSON 正文过大",
                    ));
                }
                headers.insert("Content-Type", "application/json".parse().unwrap());
                Bytes::from(bytes)
            }
            None => Bytes::new(),
        };
        for attempt in 0..=2 {
            let result: Result<()> = match self
                .send(
                    endpoint_path(endpoint, params),
                    method.clone(),
                    headers.clone(),
                    bytes_body(bytes.clone()),
                    0,
                )
                .await
            {
                Ok(raw) => {
                    let status = raw.response.status().as_u16();
                    let retry_after = raw
                        .response
                        .headers()
                        .get("Retry-After")
                        .and_then(|header| header.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok());
                    let body = incoming_stream(raw.response.into_body(), raw.permit);
                    match collect_bytes(body, MAX_JSON_RESPONSE_BYTES).await {
                        Ok(bytes) if (200..300).contains(&status) => return decode_json(&bytes),
                        Ok(bytes) => {
                            let mut response: ErrorResponse = decode_json(&bytes)?;
                            if response.error.retry_after_ms.is_none() {
                                response.error.retry_after_ms = retry_after
                                    .and_then(|seconds| seconds.checked_mul(1000))
                                    .and_then(|ms| ms.try_into().ok());
                            }
                            Err(Error::Api {
                                status,
                                error: response.error,
                            })
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            };
            let error = result.expect_err("成功在分支中返回");
            if !read_only || attempt == 2 || !retryable(&error) {
                return Err(error);
            }
            tokio::time::sleep(retry_delay(&error, attempt)).await;
        }
        unreachable!()
    }

    async fn unit(
        &self,
        endpoint: &str,
        params: &[(&str, &str)],
        method: Method,
        request: Option<serde_json::Value>,
    ) -> Result<()> {
        let mut headers = HeaderMap::new();
        let body = if let Some(value) = request {
            headers.insert("Content-Type", "application/json".parse().unwrap());
            bytes_body(serde_json::to_vec(&value)?)
        } else {
            empty_body()
        };
        let raw = self
            .send(endpoint_path(endpoint, params), method, headers, body, 0)
            .await?;
        let status = raw.response.status().as_u16();
        let bytes = collect_bytes(
            incoming_stream(raw.response.into_body(), raw.permit),
            MAX_JSON_RESPONSE_BYTES,
        )
        .await?;
        if status == 204 && bytes.is_empty() {
            return Ok(());
        }
        if status >= 400 {
            let response: ErrorResponse = decode_json(&bytes)?;
            return Err(Error::Api {
                status,
                error: response.error,
            });
        }
        Err(Error::Protocol("空成功必须为 204"))
    }

    async fn binary_read(
        &self,
        name: &str,
        params: &[(&str, &str)],
        query: Option<&str>,
        options: ReadOptions,
    ) -> Result<ByteResponse> {
        let mut path = endpoint_path(name, params);
        if let Some(version) = query {
            path.push_str("?content_version=");
            path.push_str(&encode_component(version));
        }
        self.binary_read_path(path, options).await
    }

    async fn binary_read_path(&self, path: String, options: ReadOptions) -> Result<ByteResponse> {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("Range", &options.range),
            ("If-None-Match", &options.if_none_match),
            ("If-Range", &options.if_range),
        ] {
            if let Some(value) = value {
                headers.insert(
                    name,
                    value.parse().map_err(|_| Error::Protocol("条件头无效"))?,
                );
            }
        }
        for attempt in 0..=2 {
            let raw = match self
                .send(
                    path.clone(),
                    if options.head {
                        Method::HEAD
                    } else {
                        Method::GET
                    },
                    headers.clone(),
                    empty_body(),
                    1,
                )
                .await
            {
                Ok(raw) => raw,
                Err(error) if attempt < 2 && retryable(&error) => {
                    tokio::time::sleep(retry_delay(&error, attempt)).await;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let status = raw.response.status();
            let headers = raw.response.headers().clone();
            let body = incoming_stream(raw.response.into_body(), raw.permit);
            if status.as_u16() >= 400 {
                let bytes = collect_bytes(body, MAX_JSON_RESPONSE_BYTES).await?;
                let response: ErrorResponse = decode_json(&bytes)?;
                let error = Error::Api {
                    status: status.as_u16(),
                    error: response.error,
                };
                if attempt < 2 && retryable(&error) {
                    tokio::time::sleep(retry_delay(&error, attempt)).await;
                    continue;
                }
                return Err(error);
            }
            if !matches!(status.as_u16(), 200 | 206 | 304) {
                return Err(Error::Protocol("字节响应状态无效"));
            }
            validate_partial(status.as_u16(), &headers, options.range.as_deref())?;
            return Ok(ByteResponse {
                status,
                headers,
                body,
            });
        }
        unreachable!()
    }

    async fn binary_put<T: serde::de::DeserializeOwned + serde::Serialize>(
        &self,
        name: &str,
        id_key: (&str, &str),
        body: ByteStream,
        mut headers: HeaderMap,
    ) -> Result<T> {
        if !headers.contains_key("Content-Type") {
            headers.insert("Content-Type", "application/octet-stream".parse().unwrap());
        }
        let raw = self
            .send(
                endpoint_path(name, &[id_key]),
                Method::PUT,
                headers,
                stream_body(idle_source(body)),
                1,
            )
            .await?;
        let status = raw.response.status().as_u16();
        let bytes = collect_bytes(
            incoming_stream(raw.response.into_body(), raw.permit),
            MAX_JSON_RESPONSE_BYTES,
        )
        .await?;
        if status >= 400 {
            let response: ErrorResponse = decode_json(&bytes)?;
            return Err(Error::Api {
                status,
                error: response.error,
            });
        }
        decode_json(&bytes)
    }
}

fn idle_source(source: ByteStream) -> ByteStream {
    use futures_util::StreamExt;
    Box::pin(stream::unfold(Some(source), |state| async {
        let mut source = state?;
        match tokio::time::timeout(
            Duration::from_secs(STREAM_IDLE_TIMEOUT_SECONDS),
            source.next(),
        )
        .await
        {
            Ok(Some(result)) => {
                let next = result.is_ok().then_some(source);
                Some((result, next))
            }
            Ok(None) => None,
            Err(_) => Some((Err(Error::Timeout), None)),
        }
    }))
}

pub(crate) fn incoming_stream(body: Incoming, permit: OwnedSemaphorePermit) -> ByteStream {
    Box::pin(stream::unfold(Some((body, permit)), |state| async {
        let (mut body, permit) = state?;
        loop {
            match tokio::time::timeout(
                Duration::from_secs(STREAM_IDLE_TIMEOUT_SECONDS),
                body.frame(),
            )
            .await
            {
                Ok(Some(Ok(frame))) => {
                    if let Ok(bytes) = frame.into_data() {
                        return Some((Ok(bytes), Some((body, permit))));
                    }
                }
                Ok(None) => return None,
                Ok(Some(Err(_))) => return Some((Err(Error::Transport), None)),
                Err(_) => return Some((Err(Error::Timeout), None)),
            }
        }
    }))
}

pub(crate) fn retryable(error: &Error) -> bool {
    if matches!(error, Error::Api { error, .. } if error.retry_after_ms.is_some_and(|hint| u64::from(hint) >= CONTROL_TIMEOUT_SECONDS * 1000))
    {
        return false;
    }
    matches!(error, Error::Transport | Error::Timeout)
        || matches!(
            error,
            Error::Api {
                status: 429 | 500 | 502 | 503 | 504,
                ..
            }
        )
}
pub(crate) fn retry_delay(error: &Error, attempt: u32) -> Duration {
    let hint = match error {
        Error::Api { error, .. } => error.retry_after_ms.map(u64::from).unwrap_or(0),
        _ => 0,
    };
    Duration::from_millis(
        hint.max(250 * (1 << attempt))
            .min(CONTROL_TIMEOUT_SECONDS * 1000),
    )
}

pub fn validate_partial(
    status: u16,
    headers: &HeaderMap,
    requested_range: Option<&str>,
) -> Result<()> {
    if status != 206 {
        return Ok(());
    }
    let range = headers
        .get("Content-Range")
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .and_then(|value| value.split_once('/'))
        .ok_or(Error::Protocol("206 缺少有效 Content-Range"))?;
    let (start, end) = range
        .0
        .split_once('-')
        .ok_or(Error::Protocol("Content-Range 无效"))?;
    let number = |value: &str| {
        value
            .parse::<u64>()
            .map_err(|_| Error::Protocol("Content-Range 数值无效"))
    };
    let (start, end, size) = (number(start)?, number(end)?, number(range.1)?);
    let expected = resolve_single_range(requested_range, size)?;
    let length = headers
        .get("Content-Length")
        .and_then(|header| header.to_str().ok())
        .ok_or(Error::Protocol("206 缺少 Content-Length"))?;
    if !expected.partial
        || start != expected.start
        || end < start
        || end >= size
        || end - start + 1 != expected.length
        || number(length)? != expected.length
    {
        return Err(Error::Protocol("206 与请求区间或长度不符"));
    }
    Ok(())
}

macro_rules! json_methods {
    ($( $method:ident ($request:ident : $input:ty) -> $output:ty, $endpoint:literal, $read:literal; )*) => {
        $(fn $method(&self, $request: $input) -> HostFuture<'_, $output> {
            Box::pin(async move { self.json($endpoint, &[], Method::POST, Some(serde_json::to_value($request)?), HeaderMap::new(), $read).await })
        })*
    };
}
impl HostClient for UnixHostClient {
    fn runtime_info(&self) -> HostFuture<'_, RuntimeInfo> {
        Box::pin(self.json(
            "runtime.info",
            &[],
            Method::GET,
            None,
            HeaderMap::new(),
            true,
        ))
    }
    fn scope(&self) -> HostFuture<'_, ScopeInfo> {
        Box::pin(self.json("scope.read", &[], Method::GET, None, HeaderMap::new(), true))
    }
    json_methods! {
        stat(request: NodeReference) -> FileNode, "files.stat", true;
        list(request: ListDirectoryRequest) -> DirectoryPage, "files.list", true;
        query(request: FileQuery) -> FilePage, "files.query", true;
        directories_with_files(request: DirectoriesWithFilesQuery) -> FilePage, "files.directories_with_files", true;
        random(request: RandomFilesRequest) -> RandomFilesResponse, "files.random", true;
        changes(request: FileChangesRequest) -> FileChangesPage, "files.changes", true;
        media_url(request: MediaUrlRequest) -> MediaUrl, "files.media_url", false;
        local_url(request: LocalFileUrlRequest) -> LocalFileUrl, "files.local_url", false;
        create_read_lease(request: CreateReadLeaseRequest) -> ReadLease, "read_leases.create", false;
        kv_list(request: KvListRequest) -> KvPage, "kv.list", true;
        cache_lookup(request: CacheLookupRequest) -> CacheLookupResponse, "cache.lookup", false;
    }
    fn bytes(&self, file: ContentRef, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            validate_content_ref(&file)?;
            self.binary_read(
                "files.bytes",
                &[("id", &file.id)],
                Some(&file.content_version),
                options,
            )
            .await
        })
    }
    fn ticket_bytes(&self, url: String, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            validate_ticket_path(&url)?;
            self.binary_read_path(url, options).await
        })
    }
    fn revoke_local_url(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit(
                "files.local_url.revoke",
                &[("id", &id)],
                Method::DELETE,
                None,
            )
            .await
        })
    }
    fn renew_read_lease(
        &self,
        id: String,
        request: CreateReadLeaseRequest,
    ) -> HostFuture<'_, ReadLease> {
        Box::pin(async move {
            self.json(
                "read_leases.renew",
                &[("id", &id)],
                Method::PUT,
                Some(serde_json::to_value(request)?),
                HeaderMap::new(),
                false,
            )
            .await
        })
    }
    fn revoke_read_lease(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit("read_leases.revoke", &[("id", &id)], Method::DELETE, None)
                .await
        })
    }
    fn mutate(&self, key: String, request: FileMutationRequest) -> HostFuture<'_, MutationReceipt> {
        Box::pin(async move {
            let mut headers = HeaderMap::new();
            headers.insert(
                IDEMPOTENCY_HEADER,
                key.parse().map_err(|_| Error::Protocol("幂等键无效"))?,
            );
            self.json(
                "files.mutate",
                &[],
                Method::POST,
                Some(serde_json::to_value(request)?),
                headers,
                false,
            )
            .await
        })
    }
    fn mutation_receipt(&self, key: String) -> HostFuture<'_, MutationReceipt> {
        Box::pin(async move {
            self.json(
                "files.mutate.receipt",
                &[("key", &key)],
                Method::GET,
                None,
                HeaderMap::new(),
                true,
            )
            .await
        })
    }
    fn create_upload(
        &self,
        key: String,
        request: CreateUploadRequest,
    ) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move {
            let mut headers = HeaderMap::new();
            headers.insert(
                IDEMPOTENCY_HEADER,
                key.parse().map_err(|_| Error::Protocol("幂等键无效"))?,
            );
            self.json(
                "files.upload.create",
                &[],
                Method::POST,
                Some(serde_json::to_value(request)?),
                headers,
                false,
            )
            .await
        })
    }
    fn upload_body(
        &self,
        id: String,
        body: ByteStream,
        length: Option<u64>,
    ) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move {
            let mut headers = HeaderMap::new();
            if let Some(length) = length {
                headers.insert("Content-Length", length.to_string().parse().unwrap());
            }
            self.binary_put("files.upload.body", ("id", &id), body, headers)
                .await
        })
    }
    fn upload_status(&self, id: String) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move {
            self.json(
                "files.upload.status",
                &[("id", &id)],
                Method::GET,
                None,
                HeaderMap::new(),
                true,
            )
            .await
        })
    }
    fn cancel_upload(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit("files.upload.cancel", &[("id", &id)], Method::DELETE, None)
                .await
        })
    }
    fn kv_get(&self, key: String) -> HostFuture<'_, KvGetResponse> {
        Box::pin(async move {
            self.json(
                "kv.get",
                &[("key", &key)],
                Method::GET,
                None,
                HeaderMap::new(),
                true,
            )
            .await
        })
    }
    fn kv_put(&self, key: String, request: KvPutRequest) -> HostFuture<'_, KvRecord> {
        Box::pin(async move {
            self.json(
                "kv.put",
                &[("key", &key)],
                Method::PUT,
                Some(serde_json::to_value(request)?),
                HeaderMap::new(),
                false,
            )
            .await
        })
    }
    fn kv_delete(&self, key: String, request: KvDeleteRequest) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit(
                "kv.delete",
                &[("key", &key)],
                Method::DELETE,
                Some(serde_json::to_value(request)?),
            )
            .await
        })
    }
    fn data_usage(&self) -> HostFuture<'_, DataUsage> {
        Box::pin(self.json("data.usage", &[], Method::GET, None, HeaderMap::new(), true))
    }
    fn cache_put(
        &self,
        key: String,
        body: ByteStream,
        content_type: String,
        metadata: CachePutMetadata,
    ) -> HostFuture<'_, CacheEntry> {
        Box::pin(async move {
            let mut headers = HeaderMap::new();
            headers.insert(
                "Content-Type",
                content_type
                    .parse()
                    .map_err(|_| Error::Protocol("Content-Type 无效"))?,
            );
            headers.insert(
                CACHE_METADATA_HEADER,
                URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&metadata)?)
                    .parse()
                    .unwrap(),
            );
            self.binary_put("cache.put", ("key", &key), body, headers)
                .await
        })
    }
    fn cache_get(&self, key: String, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            self.binary_read("cache.get", &[("key", &key)], None, options)
                .await
        })
    }
    fn cache_delete(&self, key: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit("cache.delete", &[("key", &key)], Method::DELETE, None)
                .await
        })
    }
    fn events(&self, cursor: Option<String>) -> HostFuture<'_, EventStream> {
        Box::pin(async move { crate::events::subscribe(self.clone(), cursor).await })
    }
    fn keepalive(&self, request: BackendKeepaliveRequest) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.unit(
                "backend.keepalive",
                &[],
                Method::POST,
                Some(serde_json::to_value(request)?),
            )
            .await
        })
    }
}

fn validate_ticket_path(url: &str) -> Result<()> {
    if !valid_same_origin_path(url) {
        return Err(Error::Protocol("票据必须是同源相对路径"));
    }
    let uri: hyper::http::Uri = url.parse().map_err(|_| Error::Protocol("票据路径无效"))?;
    let path = uri.path();
    let id = path
        .strip_prefix(&format!("{MEDIA_TICKET_BASE}/"))
        .or_else(|| path.strip_prefix(&format!("{CACHE_TICKET_BASE}/")));
    if !id.is_some_and(valid_opaque_id) {
        return Err(Error::Protocol("仅可读取宿主的媒体或缓存票据路径"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_ticket_reader_accepts_only_registered_relative_paths() {
        for url in [
            format!("{MEDIA_TICKET_BASE}/ticket-1"),
            format!("{CACHE_TICKET_BASE}/ticket-1?size=small"),
        ] {
            assert!(validate_ticket_path(&url).is_ok());
        }
        for url in [
            "https://test.invalid/admin/api/apps/v1/media/t1",
            "//test.invalid/admin/api/apps/v1/media/t1",
            "/admin/api/apps/v1/self/info",
            "/admin/apps-local/v1/t1",
            "/admin/api/apps/v1/media/../secret",
            "/admin/api/apps/v1/media/a%2fb",
            "/admin/api/apps/v1/cache-media/",
        ] {
            assert!(validate_ticket_path(url).is_err(), "{url}");
        }
    }
    #[test]
    fn range_is_checked_with_the_contract_rule() {
        let mut headers = HeaderMap::new();
        headers.insert("Content-Range", "bytes 2-4/10".parse().unwrap());
        headers.insert("Content-Length", "3".parse().unwrap());
        assert!(validate_partial(206, &headers, Some("bytes=2-4")).is_ok());
        assert!(validate_partial(206, &headers, Some("bytes=1-3")).is_err());
        assert!(validate_partial(206, &headers, None).is_err());
        assert_eq!(
            endpoint_path("kv.get", &[("key", "state:1")]),
            format!("{SELF_API_BASE}/kv/state%3A1")
        );
    }
}
