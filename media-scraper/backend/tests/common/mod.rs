#![allow(dead_code)]
//! 本地进程内 MetaTube 假服务与合成网盘；不连接真实 MetaTube、Telegram 或生产配置。
pub mod fault_host;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tgdrive_backend_sdk::{HostClient, HttpResponse, ReadOptions, collect_bytes};
use tgdrive_contract::{
    Timestamp,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_media_scraper::{
    Application,
    model::{ConfigureRequest, Run, StartRequest, random_id},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub delay: Duration,
    pub gate: Option<Arc<tokio::sync::Notify>>,
}
impl Reply {
    pub fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            body: serde_json::to_vec(&value).unwrap(),
            delay: Duration::ZERO,
            gate: None,
        }
    }
    pub fn image(bytes: Vec<u8>) -> Self {
        Self {
            status: 200,
            body: bytes,
            delay: Duration::ZERO,
            gate: None,
        }
    }
}
pub struct Fake {
    pub url: String,
    pub calls: Arc<Mutex<HashMap<String, usize>>>,
    task: tokio::task::JoinHandle<()>,
    connections: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
}
impl Fake {
    pub async fn new(handler: impl Fn(&str) -> Reply + Send + Sync + 'static) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(HashMap::new()));
        let recorded = calls.clone();
        let handler = Arc::new(handler);
        let connections = Arc::new(Mutex::new(Vec::new()));
        let running = connections.clone();
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                let calls = recorded.clone();
                let handle = tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            TokioIo::new(socket),
                            service_fn(move |request: Request<Incoming>| {
                                let handler = handler.clone();
                                let calls = calls.clone();
                                async move {
                                    let uri = request.uri().to_string();
                                    *calls.lock().unwrap().entry(uri.clone()).or_default() += 1;
                                    let reply = handler(&uri);
                                    if let Some(gate) = reply.gate {
                                        gate.notified().await;
                                    }
                                    if !reply.delay.is_zero() {
                                        tokio::time::sleep(reply.delay).await;
                                    }
                                    Ok::<_, std::convert::Infallible>(
                                        Response::builder()
                                            .status(reply.status)
                                            .body(Full::new(Bytes::from(reply.body)))
                                            .unwrap(),
                                    )
                                }
                            }),
                        )
                        .await;
                });
                running.lock().unwrap().push(handle.abort_handle());
            }
        });
        Self {
            url,
            calls,
            task,
            connections,
        }
    }
    pub async fn normal() -> Self {
        Self::new(|uri| standard(uri, &[])).await
    }
    pub fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(uri, _)| uri.starts_with(path))
            .map(|(_, n)| n)
            .sum()
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
        for task in self.connections.lock().unwrap().iter() {
            task.abort();
        }
    }
}
pub fn jpeg() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&image::RgbImage::from_pixel(
            48,
            72,
            image::Rgb([80, 140, 200]),
        ))
        .unwrap();
    bytes
}
pub fn standard(uri: &str, actors: &[&str]) -> Reply {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{uri}")).unwrap();
    let path = url.path();
    let q = url
        .query_pairs()
        .find(|(key, _)| key == "q")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if path == "/v1/movies/search" {
        Reply::json(
            200,
            json!({"data":[{"provider":"First","id":q,"number":q,"title":"合成影片"}]}),
        )
    } else if path.starts_with("/v1/movies/") {
        let parts: Vec<_> = path.split('/').collect();
        let provider = parts[3];
        let id = parts[4];
        let number = if id == "sone00614" { "SONE-614" } else { id };
        Reply::json(
            200,
            json!({"data":{"provider":provider,"id":id,"number":number,"title":"合成影片 & 完整片名","summary":"长简介。".repeat(2000),"actors":actors,"maker":"厂商","label":"品牌","release_date":"2025-01-02","genres":["分类"],"score":5}}),
        )
    } else if path == "/v1/actors/search" {
        Reply::json(
            200,
            json!({"data":[{"provider":"Actors","id":"one","name":q}]}),
        )
    } else if path == "/v1/actors/Actors/one" {
        Reply::json(
            200,
            json!({"data":{"provider":"Actors","id":"one","name":actors.first().copied().unwrap_or("演员甲"),"summary":"完整人物简介。".repeat(2000)}}),
        )
    } else if path.starts_with("/v1/images/primary/") {
        Reply::image(jpeg())
    } else {
        Reply::json(404, json!({}))
    }
}
pub fn seed(id: &str, parent: &str, name: &str, kind: NodeKind, bytes: &[u8]) -> SeedNode {
    SeedNode {
        id: id.into(),
        parent_id: parent.into(),
        name: name.into(),
        kind,
        bytes: bytes.into(),
        thumbnail: None,
    }
}
pub fn root() -> SeedNode {
    seed("2", "1", "影片", NodeKind::Directory, b"")
}
pub fn video(id: &str, name: &str) -> SeedNode {
    seed(id, "2", name, NodeKind::File, b"synthetic-video")
}
pub fn memory(nodes: Vec<SeedNode>) -> MemoryHost {
    MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "media-scraper".into(),
            name: "影视刮削".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: true,
            ..Default::default()
        },
        scope: DirectoryScope::All {
            access: AccessLevel::ReadWrite,
        },
        nodes,
        caller: RuntimeCaller::Backend,
        now: Timestamp(tgdrive_media_scraper::model::now()),
        has_backend: true,
    })
    .unwrap()
}
pub fn application(
    host: Arc<dyn HostClient>,
    db: rusqlite::Connection,
    process: &str,
) -> Arc<Application> {
    Arc::new(Application::new(host, db, process.into()).unwrap())
}
pub async fn configured(nodes: Vec<SeedNode>, fake: &Fake) -> (Arc<Application>, MemoryHost) {
    let host = memory(nodes);
    let app = application(
        Arc::new(host.clone()),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, fake, false, false).await;
    (app, host)
}
pub async fn configure(app: &Application, fake: &Fake, nfo: bool, poster: bool) {
    let revision = app.db.settings().unwrap().view.revision;
    app.configure(ConfigureRequest {
        revision,
        backend_url: fake.url.clone(),
        token: None,
        overwrite_nfo: nfo,
        overwrite_poster: poster,
    })
    .await
    .unwrap();
}
pub async fn run(app: &Arc<Application>, retry_of: Option<String>) -> Run {
    let run = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), app.wait_idle())
        .await
        .unwrap();
    app.db.run(&run.id).unwrap()
}
pub async fn node(host: &dyn HostClient, path: &str) -> FileNode {
    host.stat(NodeReference::Path {
        path: path.into(),
        content_version: None,
    })
    .await
    .unwrap()
}
pub async fn content(host: &dyn HostClient, path: &str) -> Vec<u8> {
    let node = node(host, path).await;
    let response = host
        .bytes(
            ContentRef {
                id: node.id,
                content_version: node.content_version.unwrap(),
            },
            ReadOptions::default(),
        )
        .await
        .unwrap();
    collect_bytes(response.body, 2 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}
pub async fn body(response: HttpResponse) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}
pub fn first_commit() -> fault_host::MutationFilter {
    let once = std::sync::atomic::AtomicBool::new(false);
    Arc::new(move |request| {
        request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
            && !once.swap(true, std::sync::atomic::Ordering::SeqCst)
    })
}
