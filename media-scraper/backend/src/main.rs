use futures_util::StreamExt;
use http_body_util::BodyExt;
use std::sync::Arc;
use tgdrive_backend_sdk::{BackendServer, Error, StartContext, UnixHostClient, collect_bytes};
use tgdrive_contract::{CONTRACT_VERSION, error_code, runtime::ForwardCaller};
use tgdrive_media_scraper::Application;

#[tokio::main]
async fn main() -> tgdrive_backend_sdk::Result<()> {
    let start = StartContext::from_args(std::env::args_os(), CONTRACT_VERSION)?;
    if start.context.app.id != "media-scraper"
        || start.context.app.version != env!("CARGO_PKG_VERSION")
    {
        return Err(Error::Protocol("刮削启动身份与应用包不符"));
    }
    let connection = rusqlite::Connection::open(&start.context.database_path)
        .map_err(|_| Error::api(error_code::STORAGE_UNAVAILABLE, "无法打开刮削应用数据库"))?;
    connection
        .pragma_update(None, "cache_size", -4096)
        .map_err(|_| Error::Protocol("数据库缓存预算设置失败"))?;
    connection
        .pragma_update(
            None,
            "max_page_count",
            (start.context.limits.database_bytes.0 / 4096).max(1) as i64,
        )
        .map_err(|_| Error::Protocol("数据库容量预算设置失败"))?;
    let app = Arc::new(Application::new(
        Arc::new(UnixHostClient::new(&start)),
        connection,
        start.context.run_id.clone(),
    )?);
    let cleanup = app.clone();
    BackendServer::bind(start)?
        .run(
            move |forward| {
                let app = app.clone();
                async move {
                    if forward.context.caller != ForwardCaller::Owner {
                        return Err(Error::api(
                            error_code::CALLER_NOT_ALLOWED,
                            "刮削应用不提供对外服务",
                        ));
                    }
                    let method = forward.request.method().clone();
                    let path = forward.request.uri().path().to_owned();
                    let value = if method == tgdrive_backend_sdk::http::Method::GET {
                        serde_json::json!({})
                    } else {
                        let bytes = collect_bytes(
                            Box::pin(
                                forward
                                    .request
                                    .into_body()
                                    .into_data_stream()
                                    .map(|chunk| chunk.map_err(|_| Error::Transport)),
                            ),
                            tgdrive_contract::http::MAX_JSON_REQUEST_BYTES,
                        )
                        .await?;
                        tgdrive_backend_sdk::decode_json::<serde_json::Value>(&bytes)?
                    };
                    app.handle(forward.context, method, path, value).await
                }
            },
            move |_| async move {
                cleanup.shutdown().await;
            },
        )
        .await
}
