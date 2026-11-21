//! MetaTube 固定接口适配；不读取资料中的外部 URL，不回显 Token 或连接地址。
use crate::model::{
    Candidate, Movie, Person, exact_candidates, exact_person, identity, valid_number,
};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::Value;
use std::time::Duration;
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::error_code;
use tokio_util::sync::CancellationToken;

pub const JSON_LIMIT: usize = 2 * 1024 * 1024;
pub const IMAGE_INPUT_LIMIT: usize = 8 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct SourceFailure {
    pub message: String,
    pub retryable: bool,
    pub retry_after: Duration,
}
impl SourceFailure {
    fn terminal(message: &str) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            retry_after: Duration::ZERO,
        }
    }
    pub fn app(&self) -> Error {
        Error::api(error_code::UPSTREAM_UNAVAILABLE, &self.message)
    }
}
type SourceResult<T> = std::result::Result<T, SourceFailure>;
pub fn base_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw.trim())
        .map_err(|_| Error::api(error_code::INVALID_REQUEST, "MetaTube 地址格式无效"))?;
    if raw.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "MetaTube 地址须为不含账号、查询或片段的 HTTP/HTTPS 地址",
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
pub fn validate_token(token: Option<&str>) -> Result<()> {
    if token.is_some_and(|s| s.len() > 1024 || !s.bytes().all(|b| (0x21..=0x7e).contains(&b))) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "Token 须为不超过 1024 字节、无空白控制字符的 ASCII 文本",
        ));
    }
    Ok(())
}
#[derive(Clone)]
pub struct Backend {
    client: Client,
    base: Url,
    token: Option<String>,
}
impl Backend {
    pub fn new(raw: &str, token: Option<String>) -> Result<Self> {
        Self::timeouts(raw, token, Duration::from_secs(10), Duration::from_secs(40))
    }
    fn timeouts(
        raw: &str,
        token: Option<String>,
        connect: Duration,
        total: Duration,
    ) -> Result<Self> {
        validate_token(token.as_deref())?;
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(connect)
            .timeout(total)
            // 保持旧版的零跳重定向策略：不会跨源转交凭据，也不会进入任意资料 URL。
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::api(error_code::UPSTREAM_UNAVAILABLE, "无法创建 MetaTube 连接"))?;
        Ok(Self {
            client,
            base: base_url(raw)?,
            token,
        })
    }
    async fn get(
        &self,
        parts: &[&str],
        query: &[(&str, &str)],
        limit: usize,
        cancel: &CancellationToken,
    ) -> SourceResult<Option<Vec<u8>>> {
        let future = async {
            let mut url = self.base.clone();
            let mut path = url
                .path_segments_mut()
                .map_err(|_| SourceFailure::terminal("MetaTube 地址路径无效"))?;
            path.pop_if_empty();
            for part in parts {
                path.push(part);
            }
            drop(path);
            let mut request = self.client.get(url).query(query);
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.map_err(network_failure)?;
            let status = response.status();
            if status.as_u16() == 404 {
                return Ok(None);
            }
            if !status.is_success() {
                let retry_after = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(1)
                    .min(2);
                return Err(SourceFailure {
                    message: format!("资料接口返回 HTTP {}", status.as_u16()),
                    retryable: status.as_u16() == 429 || status.is_server_error(),
                    retry_after: Duration::from_secs(retry_after),
                });
            }
            if response.content_length().is_some_and(|n| n > limit as u64) {
                return Err(SourceFailure::terminal("MetaTube 响应超过读取预算"));
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(network_failure)?;
                if bytes.len().saturating_add(chunk.len()) > limit {
                    return Err(SourceFailure::terminal("MetaTube 响应超过读取预算"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(Some(bytes))
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(SourceFailure::terminal("刮削任务已停止")), result = future => result }
    }
    async fn data(
        &self,
        parts: &[&str],
        query: &[(&str, &str)],
        cancel: &CancellationToken,
    ) -> SourceResult<Option<Value>> {
        let Some(bytes) = self.get(parts, query, JSON_LIMIT, cancel).await? else {
            return Ok(None);
        };
        let value = tgdrive_contract::validation::parse_unique_json(&bytes)
            .map_err(|_| SourceFailure::terminal("MetaTube 响应不是有效且唯一键的 JSON"))?;
        value
            .get("data")
            .cloned()
            .map(Some)
            .ok_or_else(|| SourceFailure::terminal("MetaTube 响应缺少 data 字段"))
    }
    pub async fn search_once(
        &self,
        number: &str,
        cancel: &CancellationToken,
    ) -> SourceResult<Vec<Candidate>> {
        let number =
            valid_number(number).map_err(|_| SourceFailure::terminal("作品番号格式无效"))?;
        let Some(value) = self
            .data(&["v1", "movies", "search"], &[("q", &number)], cancel)
            .await?
        else {
            return Ok(Vec::new());
        };
        let candidates: Vec<Candidate> = serde_json::from_value(value)
            .map_err(|_| SourceFailure::terminal("影片搜索结果格式无效"))?;
        // 按完整有界正文过滤，不在过滤同号候选前截断模糊结果。
        Ok(exact_candidates(candidates, &number))
    }
    pub async fn search(
        &self,
        number: &str,
        cancel: &CancellationToken,
        report: impl Fn(&SourceFailure) -> Result<()> + Send + Sync,
    ) -> Result<Vec<Candidate>> {
        for attempt in 0..=1 {
            match self.search_once(number, cancel).await {
                Ok(candidates) => return Ok(candidates),
                Err(error) => {
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    report(&error)?;
                    if attempt == 1 || !error.retryable {
                        return Err(error.app());
                    }
                    wait_retry(cancel, error.retry_after).await?;
                }
            }
        }
        unreachable!()
    }
    pub async fn movie_once(
        &self,
        candidate: &Candidate,
        cancel: &CancellationToken,
    ) -> SourceResult<Movie> {
        identity(&candidate.provider, &candidate.id)
            .map_err(|_| SourceFailure::terminal("资料来源或条目 ID 无效"))?;
        let Some(value) = self
            .data(
                &["v1", "movies", &candidate.provider, &candidate.id],
                &[("lazy", "true")],
                cancel,
            )
            .await?
        else {
            return Err(SourceFailure::terminal("影片详情返回 HTTP 404"));
        };
        let movie: Movie = serde_json::from_value(value)
            .map_err(|_| SourceFailure::terminal("影片详情格式无效"))?;
        if movie.provider != candidate.provider
            || movie.id != candidate.id
            || movie.title.trim().is_empty()
            || valid_number(&movie.number).is_err()
            || crate::model::normalized_number(&movie.number)
                != crate::model::normalized_number(&candidate.number)
        {
            return Err(SourceFailure::terminal(
                "影片详情身份、番号与候选不一致或缺少标题",
            ));
        }
        Ok(movie)
    }
    pub async fn person(
        &self,
        name: &str,
        cancel: &CancellationToken,
    ) -> SourceResult<Option<Person>> {
        if name.len() > 512 {
            return Err(SourceFailure::terminal("姓名超过人物查询长度预算"));
        }
        let Some(value) = self
            .data(
                &["v1", "actors", "search"],
                &[("q", name), ("fallback", "false")],
                cancel,
            )
            .await?
        else {
            return Ok(None);
        };
        let candidates: Vec<Person> = serde_json::from_value(value)
            .map_err(|_| SourceFailure::terminal("人物搜索格式无效"))?;
        let Some(candidate) = exact_person(candidates, name) else {
            return Ok(None);
        };
        let Some(value) = self
            .data(
                &["v1", "actors", &candidate.provider, &candidate.id],
                &[("lazy", "true")],
                cancel,
            )
            .await?
        else {
            return Ok(None);
        };
        let person: Person = serde_json::from_value(value)
            .map_err(|_| SourceFailure::terminal("人物详情格式无效"))?;
        Ok((person.provider == candidate.provider
            && person.id == candidate.id
            && person.name.trim() == name.trim())
        .then_some(person))
    }
    pub async fn image(
        &self,
        provider: &str,
        id: &str,
        cancel: &CancellationToken,
    ) -> SourceResult<Option<Vec<u8>>> {
        identity(provider, id).map_err(|_| SourceFailure::terminal("图片来源或条目 ID 无效"))?;
        self.get(
            &["v1", "images", "primary", provider, id],
            &[],
            IMAGE_INPUT_LIMIT,
            cancel,
        )
        .await
    }
}
fn network_failure(error: reqwest::Error) -> SourceFailure {
    SourceFailure {
        message: if error.is_timeout() {
            "资料连接或响应超时"
        } else {
            "资料连接失败或响应读取中断"
        }
        .into(),
        retryable: error.is_timeout()
            || error.is_connect()
            || error.is_body()
            || error.is_request(),
        retry_after: Duration::from_millis(800),
    }
}
pub async fn wait_retry(cancel: &CancellationToken, delay: Duration) -> Result<()> {
    tokio::select! { biased; _ = cancel.cancelled() => Err(Error::Cancelled), _ = tokio::time::sleep(delay.min(Duration::from_secs(2))) => Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Response, service::service_fn};
    use hyper_util::rt::TokioIo;
    use serde_json::json;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    async fn server(
        handler: impl Fn(hyper::Request<hyper::body::Incoming>) -> Response<Full<Bytes>>
        + Send
        + Sync
        + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/prefix/", listener.local_addr().unwrap());
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            TokioIo::new(socket),
                            service_fn(move |request| {
                                let response = handler(request);
                                async move { Ok::<_, std::convert::Infallible>(response) }
                            }),
                        )
                        .await;
                });
            }
        });
        (url, task)
    }
    fn response(status: u16, value: Value) -> Response<Full<Bytes>> {
        Response::builder()
            .status(status)
            .body(Full::new(Bytes::from(serde_json::to_vec(&value).unwrap())))
            .unwrap()
    }
    #[test]
    fn addresses_and_tokens_reject_unintended_transports() {
        for raw in [
            "file:///etc/passwd",
            "ftp://example.invalid/",
            "http://user:secret@example.invalid/",
            "https://example.invalid/?q=1",
            "https://example.invalid/#x",
        ] {
            assert!(base_url(raw).is_err());
        }
        assert_eq!(
            base_url("https://example.invalid/prefix").unwrap().as_str(),
            "https://example.invalid/prefix/"
        );
        assert!(validate_token(Some("secret\r\nInjected: yes")).is_err());
    }
    #[tokio::test]
    async fn fixed_paths_filters_same_number_and_keeps_token_private() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let records = calls.clone();
        let (url,task) = server(move |request| { records.lock().unwrap().push((request.uri().to_string(),request.headers().get("Authorization").unwrap().to_str().unwrap().to_owned())); response(200,json!({"data":[{"provider":"B","id":"one","number":"OTHER-123"},{"provider":"A","id":"two","number":"ABC-123"}]})) }).await;
        let backend = Backend::new(&url, Some("synthetic-secret".into())).unwrap();
        let results = backend
            .search_once("ABC-123", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].provider, "A");
        assert_eq!(
            calls.lock().unwrap()[0],
            (
                "/prefix/v1/movies/search?q=ABC-123".into(),
                "Bearer synthetic-secret".into()
            )
        );
        task.abort();
    }
    #[tokio::test]
    async fn retries_transient_search_once_and_logs_before_the_second_call() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (url, task) = server(move |_| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Response::builder()
                    .status(500)
                    .header("Retry-After", "0")
                    .body(Full::new(Bytes::new()))
                    .unwrap()
            } else {
                response(200, json!({"data":[]}))
            }
        })
        .await;
        let backend = Backend::new(&url, None).unwrap();
        let logs = Mutex::new(Vec::new());
        backend
            .search("ABC-123", &CancellationToken::new(), |e| {
                assert_eq!(count.load(Ordering::SeqCst), 1);
                logs.lock().unwrap().push(e.message.clone());
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(logs.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn errors_and_redirects_are_bounded_and_do_not_disclose_credentials() {
        let (url, task) = server(|_| {
            Response::builder()
                .status(302)
                .header("Location", "http://external.invalid/secret")
                .body(Full::new(Bytes::new()))
                .unwrap()
        })
        .await;
        let backend = Backend::new(&url, Some("synthetic-secret".into())).unwrap();
        let error = backend
            .search_once("ABC-123", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(!error.retryable);
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains(&url));
        task.abort();
        let (url, task) = server(|_| {
            Response::builder()
                .status(200)
                .header("Content-Length", (JSON_LIMIT + 1).to_string())
                .body(Full::new(Bytes::new()))
                .unwrap()
        })
        .await;
        assert!(
            !Backend::new(&url, None)
                .unwrap()
                .search_once("ABC-123", &CancellationToken::new())
                .await
                .unwrap_err()
                .retryable
        );
        task.abort();
    }
    #[tokio::test]
    async fn cancelling_retry_wait_never_issues_another_search() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (url, task) = server(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            response(503, json!({}))
        })
        .await;
        let backend = Backend::new(&url, None).unwrap();
        let cancel = CancellationToken::new();
        assert!(
            backend
                .search("ABC-123", &cancel, |_| {
                    cancel.cancel();
                    Ok(())
                })
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }
    #[tokio::test]
    async fn malformed_and_duplicate_json_are_not_retried() {
        for raw in [
            b"{\"data\":[],\"data\":[]}".as_slice(),
            b"<html>error</html>".as_slice(),
        ] {
            let body = Bytes::copy_from_slice(raw);
            let (url, task) = server(move |_| Response::new(Full::new(body.clone()))).await;
            assert!(
                !Backend::new(&url, None)
                    .unwrap()
                    .search_once("ABC-123", &CancellationToken::new())
                    .await
                    .unwrap_err()
                    .retryable
            );
            task.abort();
        }
    }
}
