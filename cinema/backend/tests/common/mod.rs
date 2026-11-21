#![allow(dead_code)]
//! 共享合成夹具；不会启动宿主、读取生产配置或连接 Telegram。
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tgdrive_backend_sdk::{
    HttpResponse, ReadOptions,
    http::{HeaderMap, Method},
};
use tgdrive_cinema::{
    Application,
    model::{Library, MediaInfo},
};
use tgdrive_contract::{
    Timestamp,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, ForwardCaller, ForwardContext, ForwardEntry, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

pub const LIBRARY: &str = "11111111111111111111111111111111";
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
pub fn memory(nodes: Vec<SeedNode>) -> (Application, MemoryHost) {
    let host = MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "cinema".into(),
            name: "影视".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: false,
            ..Default::default()
        },
        scope: DirectoryScope::All {
            access: AccessLevel::ReadOnly,
        },
        nodes,
        caller: RuntimeCaller::Backend,
        now: Timestamp(tgdrive_cinema::model::now()),
        has_backend: true,
    })
    .unwrap();
    let app = Application::new(
        Arc::new(host.clone()),
        rusqlite::Connection::open_in_memory().unwrap(),
        "/usr/bin/true".into(),
        "/usr/bin/true".into(),
    )
    .unwrap();
    (app, host)
}
pub async fn configured(
    nodes: Vec<SeedNode>,
    kind: &str,
) -> (Arc<Application>, MemoryHost, String) {
    let (app, host) = memory(nodes);
    let revision = app.db.settings().unwrap().revision;
    app.configure_libraries(
        &revision,
        vec![Library {
            id: LIBRARY.into(),
            name: "合成媒体库".into(),
            kind: kind.into(),
            root_id: "2".into(),
        }],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
    let revision = app.db.settings().unwrap().revision;
    app.configure_account(&revision, "synthetic", "Synthetic-Only-Account")
        .await
        .unwrap();
    let revision = app.db.settings().unwrap().revision;
    app.start_service(&revision).await.unwrap();
    let app = Arc::new(app);
    let mut after = String::new();
    loop {
        let ids = app.db.entry_ids(&after, 200).unwrap();
        if ids.is_empty() {
            break;
        }
        for id in ids {
            after = id.clone();
            let e = app.db.entry(&id).unwrap().unwrap();
            app.db.put_probe(&e,&MediaInfo{version:e.version.clone(),wrapper:if e.filename.ends_with(".mkv"){"mkv"}else{"mp4"}.into(),duration:300.0,policy_version:1,streams:vec![json!({"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"color_transfer":"bt709"}),json!({"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000"})]}).unwrap();
        }
    }
    let token = login(&app).await;
    (app, host, token)
}
pub fn root() -> SeedNode {
    seed("2", "1", "影视", NodeKind::Directory, b"")
}
pub fn context(owner: bool) -> ForwardContext {
    ForwardContext {
        contract: tgdrive_contract::CONTRACT_VERSION,
        app_id: "cinema".into(),
        caller: if owner {
            ForwardCaller::Owner
        } else {
            ForwardCaller::External
        },
        entry: if owner {
            ForwardEntry::Page
        } else {
            ForwardEntry::Root
        },
        request_id: "synthetic-request".into(),
        original_uri: "/synthetic".into(),
        public_origin: "https://synthetic.invalid".into(),
        public_base_url: "https://synthetic.invalid".into(),
        client_ip: None,
    }
}
pub async fn wire(
    app: &Arc<Application>,
    owner: bool,
    method: &str,
    path: &str,
    token: Option<&str>,
    value: Value,
    headers: &[(&str, &str)],
) -> HttpResponse {
    let mut map = HeaderMap::new();
    if let Some(token) = token {
        map.insert("Authorization", token.parse().unwrap());
    }
    for (name, value) in headers {
        map.insert(
            tgdrive_backend_sdk::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    match app
        .clone()
        .handle(
            context(owner),
            method.parse().unwrap(),
            path.into(),
            map,
            value,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => error.response("synthetic-request"),
    }
}
pub async fn body(response: HttpResponse) -> (u16, Value) {
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
pub async fn login(app: &Arc<Application>) -> String {
    let password = format!("{:x}", Sha256::digest(b"Synthetic-Only-Account"));
    let (status, value) = body(
        wire(
            app,
            false,
            "POST",
            "/v/api/v2/user/loginByPassword",
            None,
            json!({"username":"synthetic","password":password}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    value["data"]["token"].as_str().unwrap().into()
}
pub async fn list(app: &Arc<Application>, token: &str, value: Value) -> Value {
    let (status, value) = body(
        wire(
            app,
            false,
            "POST",
            "/v/api/v1/item/list",
            Some(token),
            value,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    value["data"].clone()
}
pub fn directive(response: &HttpResponse) -> StreamDirective {
    let value = response.headers()["X-Tgdrive-Stream"]
        .to_str()
        .unwrap()
        .strip_prefix("v1;")
        .unwrap();
    tgdrive_backend_sdk::decode_json(&URL_SAFE_NO_PAD.decode(value).unwrap()).unwrap()
}
pub async fn start(app: &Arc<Application>, host: &MemoryHost, token: &str, id: &str) {
    use futures_util::StreamExt;
    let e = app.db.entry(id).unwrap().unwrap();
    let (status, response) = body(
        wire(
            app,
            false,
            "POST",
            "/v/api/v1/stream",
            Some(token),
            json!({"item_guid":e.guid,"media_guid":e.media_guid}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let response = wire(
        app,
        false,
        "GET",
        &format!("/v/api/v1/media/range/{}", e.media_guid),
        Some(token),
        Value::Null,
        &[],
    )
    .await;
    let cursor = host.events_snapshot(None).unwrap()[0].cursor.clone();
    let mut response = host
        .direct_stream(
            Method::GET,
            directive(&response),
            ReadOptions::default(),
            "synthetic-read".into(),
        )
        .unwrap();
    assert!(response.body.next().await.unwrap().is_ok());
    for event in host.events_snapshot(Some(cursor.clone())).unwrap() {
        app.event(&event).await.unwrap();
    }
    while let Some(bytes) = response.body.next().await {
        bytes.unwrap();
    }
    for event in host.events_snapshot(Some(cursor)).unwrap() {
        app.event(&event).await.unwrap();
    }
}
pub async fn record(app: &Arc<Application>, token: &str, id: &str, link: &str, ts: f64) -> u16 {
    let e = app.db.entry(id).unwrap().unwrap();
    wire(app,false,"POST","/v/api/v1/play/record",Some(token),json!({"item_guid":e.guid,"media_guid":e.media_guid,"play_link":link,"ts":ts,"subtitle_guid":"_no_display_"}),&[]).await.status().as_u16()
}
