use futures_util::StreamExt;
use http_body_util::BodyExt;
use std::sync::Arc;
use tgdrive_backend_sdk::{
    BackendServer, Error, ForwardRequest, Result, StartContext, UnixHostClient, collect_bytes,
    decode_json, json_response,
};
use tgdrive_contract::{
    CONTRACT_VERSION, error_code, http::MAX_JSON_REQUEST_BYTES, runtime::ForwardCaller,
};
use tgdrive_example_backend::{Application, ConfigureRequest, DirectoryRequest};

async fn body<T: serde::de::DeserializeOwned + serde::Serialize>(
    request: hyper::Request<hyper::body::Incoming>,
) -> Result<T> {
    let bytes = collect_bytes(
        Box::pin(
            request
                .into_body()
                .into_data_stream()
                .map(|chunk| chunk.map_err(|_| Error::Transport)),
        ),
        MAX_JSON_REQUEST_BYTES,
    )
    .await?;
    decode_json(&bytes)
}
async fn route(
    app: Arc<Application>,
    request: ForwardRequest,
) -> Result<tgdrive_backend_sdk::HttpResponse> {
    let method = request.request.method().clone();
    let path = request.request.uri().path().to_owned();
    match request.context.caller {
        ForwardCaller::Owner => match (method.as_str(), path.as_str()) {
            ("GET", "/owner/config") => json_response(200, &app.configuration()?),
            ("PUT", "/owner/config") => json_response(
                200,
                &app.configure(body::<ConfigureRequest>(request.request).await?)
                    .await?,
            ),
            ("POST", "/owner/directory") => json_response(
                200,
                &app.directory(body::<DirectoryRequest>(request.request).await?)
                    .await?,
            ),
            _ => Err(Error::api(error_code::NOT_FOUND, "主人页面接口不存在")),
        },
        ForwardCaller::External => {
            if path != "/file" || !matches!(method.as_str(), "GET" | "HEAD") {
                return Err(Error::api(error_code::NOT_FOUND, "应用服务接口不存在"));
            }
            let authorization = request
                .request
                .headers()
                .get("Authorization")
                .and_then(|header| header.to_str().ok());
            app.external_file(&method, authorization).await
        }
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let start = StartContext::from_args(std::env::args_os(), CONTRACT_VERSION)?;
    let host = Arc::new(UnixHostClient::new(&start));
    let database = rusqlite::Connection::open(&start.context.database_path)
        .map_err(|_| Error::Protocol("无法打开上下文指定的应用数据库"))?;
    let app = Arc::new(Application::new(host, database)?);
    let cleanup = app.clone();
    BackendServer::bind(start)?
        .run(
            move |request| route(app.clone(), request),
            move |_shutdown| async move {
                cleanup.shutdown();
            },
        )
        .await
}
