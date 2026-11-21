use crate::{
    Error, HttpResponse, Result, StartContext, empty_body, json_response, parse_forward_context,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hyper::{
    Request,
    body::Incoming,
    http::{Method, StatusCode},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use std::{convert::Infallible, future::Future, sync::Arc, time::Duration};
use tgdrive_contract::{
    error_code, files::StreamDirective, http::*, runtime::ForwardContext,
    validation::validate_stream_directive,
};
use tokio::{net::UnixListener, sync::watch, task::JoinSet};

#[derive(Clone)]
pub struct Shutdown {
    receiver: watch::Receiver<bool>,
}
impl Shutdown {
    pub fn is_stopping(&self) -> bool {
        *self.receiver.borrow()
    }
    pub async fn wait(&mut self) {
        while !*self.receiver.borrow_and_update() && self.receiver.changed().await.is_ok() {}
    }
}

pub struct ForwardRequest {
    pub context: ForwardContext,
    pub request: Request<Incoming>,
    pub shutdown: Shutdown,
}

/// 在初始化/迁移完成后绑定上下文给定的 Unix 套接字。不删除既有目标或跟随链接。
pub struct BackendServer {
    listener: UnixListener,
    start: Arc<StartContext>,
}
impl BackendServer {
    pub fn bind(start: StartContext) -> Result<Self> {
        let listener = UnixListener::bind(&start.context.listen_socket)?;
        Ok(Self {
            listener,
            start: Arc::new(start),
        })
    }

    pub async fn run<H, F, C, CF>(self, handler: H, cleanup: C) -> Result<()>
    where
        H: Fn(ForwardRequest) -> F + Send + Sync + 'static,
        F: Future<Output = Result<HttpResponse>> + Send + 'static,
        C: FnOnce(Shutdown) -> CF,
        CF: Future<Output = ()> + Send,
    {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        self.run_until(
            handler,
            async move {
                signal.recv().await;
            },
            cleanup,
        )
        .await
    }

    /// 测试可以注入停止信号；生产 run 固定监听 SIGTERM，没有可配置的身份豁免。
    pub async fn run_until<H, F, S, C, CF>(self, handler: H, stop: S, cleanup: C) -> Result<()>
    where
        H: Fn(ForwardRequest) -> F + Send + Sync + 'static,
        F: Future<Output = Result<HttpResponse>> + Send + 'static,
        S: Future<Output = ()> + Send,
        C: FnOnce(Shutdown) -> CF,
        CF: Future<Output = ()> + Send,
    {
        let handler = Arc::new(handler);
        let (sender, receiver) = watch::channel(false);
        let shutdown = Shutdown { receiver };
        let mut connections = JoinSet::new();
        tokio::pin!(stop);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                accepted = self.listener.accept() => {
                    let (socket, _) = accepted?;
                    // 仅信任宿主 root 的连接；非 Linux 的本机测试遵守契约测试豁免。
                    #[cfg(target_os = "linux")]
                    if socket.peer_cred()?.uid() != 0 { continue; }
                    let start = self.start.clone();
                    let handler = handler.clone();
                    let mut shutdown = shutdown.clone();
                    connections.spawn(async move {
                        let request_shutdown = shutdown.clone();
                        let service = service_fn(move |request| {
                            let (start, handler, shutdown) = (start.clone(), handler.clone(), request_shutdown.clone());
                            async move { Ok::<_, Infallible>(dispatch(request, &start, &*handler, shutdown).await) }
                        });
                        let mut builder = http1::Builder::new();
                        builder.max_buf_size(MAX_HEADER_BYTES as usize).keep_alive(true).header_read_timeout(Duration::from_secs(CONTROL_TIMEOUT_SECONDS)).timer(hyper_util::rt::TokioTimer::new());
                        let connection = builder.serve_connection(TokioIo::new(crate::io::IdleIo::new(socket)), service);
                        tokio::pin!(connection);
                        tokio::select! {
                            result = &mut connection => { let _ = result; },
                            _ = shutdown.wait() => { connection.as_mut().graceful_shutdown(); let _ = connection.await; }
                        }
                    });
                },
                _ = connections.join_next(), if !connections.is_empty() => {},
            }
        }
        // 先关闭监听器，再通知应用任务；已有 HTTP 请求与业务清理共同使用停止预算。
        drop(self.listener);
        let _ = sender.send(true);
        let graceful = async {
            tokio::join!(cleanup(shutdown), async {
                while connections.join_next().await.is_some() {}
            });
        };
        if tokio::time::timeout(Duration::from_secs(BACKEND_STOP_SECONDS), graceful)
            .await
            .is_err()
        {
            connections.abort_all();
            return Err(Error::Timeout);
        }
        Ok(())
    }
}

async fn dispatch<H, F>(
    request: Request<Incoming>,
    start: &StartContext,
    handler: &H,
    shutdown: Shutdown,
) -> HttpResponse
where
    H: Fn(ForwardRequest) -> F,
    F: Future<Output = Result<HttpResponse>>,
{
    let context = match parse_forward_context(request.headers(), start) {
        Ok(context) => context,
        Err(error) => return error.response("sdk"),
    };
    let path = request.uri().path();
    let internal =
        path == BACKEND_INTERNAL_PREFIX || path.starts_with(&format!("{BACKEND_INTERNAL_PREFIX}/"));
    if internal {
        if context.is_some() {
            return Error::api(error_code::CALLER_NOT_ALLOWED, "转发请求不得访问内部前缀")
                .response("sdk");
        }
        if path == BACKEND_READY_PATH && request.method() == Method::GET {
            return json_response(200, &start.ready()).expect("就绪对象可序列化");
        }
        return Error::api(error_code::NOT_FOUND, "内部接口不存在").response("sdk");
    }
    let Some(context) = context else {
        return Error::api(error_code::UNAUTHORIZED, "业务请求缺少转发上下文").response("sdk");
    };
    if shutdown.is_stopping() {
        return Error::api(error_code::BACKEND_UNAVAILABLE, "应用正在停止")
            .response(&context.request_id);
    }
    let request_id = context.request_id.clone();
    match handler(ForwardRequest {
        context,
        request,
        shutdown,
    })
    .await
    {
        Ok(response) => response,
        Err(error) => error.response(&request_id),
    }
}

/// 构造空正文的控制响应，包括 HEAD。文件长度用于调用共享契约的窗口校验。
pub fn stream_response(
    method: &Method,
    directive: &StreamDirective,
    file_size: u64,
) -> Result<HttpResponse> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return Err(Error::api(
            error_code::INVALID_BACKEND_RESPONSE,
            "只有 GET/HEAD 可以原文件直传",
        ));
    }
    validate_stream_directive(directive, file_size)?;
    let header = format!(
        "{STREAM_DIRECTIVE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(directive)?)
    );
    hyper::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(STREAM_DIRECTIVE_HEADER, header)
        .body(empty_body())
        .map_err(|_| Error::Protocol("直传控制头无效"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tgdrive_contract::files::{ContentRef, Disposition, RangePolicy, StreamCachePolicy};
    #[tokio::test]
    async fn head_directive_has_no_body_and_is_validated() {
        let directive = StreamDirective {
            file: ContentRef {
                id: "2".into(),
                content_version: "v1".into(),
            },
            window: None,
            range: RangePolicy::Client,
            disposition: Disposition::Inline,
            filename: None,
            content_type: None,
            cache: StreamCachePolicy::NoStore,
            lease_id: None,
            correlation_id: None,
        };
        let response = stream_response(&Method::HEAD, &directive, 10).unwrap();
        assert_eq!(response.status(), 204);
        assert!(response.headers().contains_key(STREAM_DIRECTIVE_HEADER));
        assert!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
        assert!(stream_response(&Method::POST, &directive, 10).is_err());
    }
}
