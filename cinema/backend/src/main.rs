use futures_util::StreamExt;
use http_body_util::BodyExt;
use std::sync::Arc;
use tgdrive_backend_sdk::{BackendServer, Error, StartContext, UnixHostClient, collect_bytes};
use tgdrive_cinema::Application;
use tgdrive_contract::{CONTRACT_VERSION, error_code, runtime::ForwardCaller};

#[tokio::main]
async fn main() -> tgdrive_backend_sdk::Result<()> {
    let start = StartContext::from_args(std::env::args_os(), CONTRACT_VERSION)?;
    if start.context.app.id != "cinema" || start.context.app.version != env!("CARGO_PKG_VERSION") {
        return Err(Error::Protocol("影视启动身份与应用包不符"));
    }
    let connection = rusqlite::Connection::open(&start.context.database_path)
        .map_err(|_| Error::api(error_code::STORAGE_UNAVAILABLE, "无法打开影视应用数据库"))?;
    connection
        .pragma_update(None, "cache_size", -8192)
        .map_err(|_| Error::Protocol("影视数据库缓存设置失败"))?;
    let app = Arc::new(Application::new(
        Arc::new(UnixHostClient::new(&start)),
        connection,
        start.context.ffprobe_path.clone(),
        start.context.ffmpeg_path.clone(),
    )?);
    app.db
        .bind_installation(&start.context.app.generation, &start.context.app.version)?;
    app.start_jobs();
    let cleanup = app.clone();
    BackendServer::bind(start)?
        .run(
            move |forward| {
                let app = app.clone();
                async move {
                    let method = forward.request.method().clone();
                    let path = forward.request.uri().path().to_owned();
                    let headers = forward.request.headers().clone();
                    if forward.context.caller == ForwardCaller::External
                        && !app.db.settings()?.running
                    {
                        return tgdrive_cinema::fntv::error_response(&Error::api(
                            error_code::UNAUTHORIZED,
                            "飞牛影视兼容服务尚未启动",
                        ));
                    }
                    let value = if matches!(method.as_str(), "GET" | "HEAD") {
                        serde_json::Value::Null
                    } else {
                        let limit = if forward.context.caller == ForwardCaller::Owner {
                            tgdrive_contract::http::MAX_JSON_REQUEST_BYTES
                        } else {
                            16 * 1024
                        };
                        let decoded = async {
                            let bytes = collect_bytes(
                                Box::pin(
                                    forward
                                        .request
                                        .into_body()
                                        .into_data_stream()
                                        .map(|chunk| chunk.map_err(|_| Error::Transport)),
                                ),
                                limit,
                            )
                            .await?;
                            if bytes.is_empty() {
                                Ok(serde_json::json!({}))
                            } else {
                                tgdrive_backend_sdk::decode_json::<serde_json::Value>(&bytes)
                            }
                        }
                        .await;
                        match decoded {
                            Ok(value) => value,
                            Err(error) if forward.context.caller == ForwardCaller::External => {
                                return tgdrive_cinema::fntv::error_response(&error);
                            }
                            Err(error) => return Err(error),
                        }
                    };
                    app.handle(forward.context, method, path, headers, value)
                        .await
                }
            },
            move |_| async move {
                cleanup.shutdown().await;
            },
        )
        .await
}
