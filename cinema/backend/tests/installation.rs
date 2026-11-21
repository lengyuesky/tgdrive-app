//! 更新真实应用数据库后重建安装游标，保留媒体库、连接账号与用户观看状态。
mod common;

use common::{LIBRARY, memory, root, seed};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tgdrive_backend_sdk::{
    ByteResponse, ByteStream, Error, EventStream, HostClient, HostFuture, ReadOptions,
};
use tgdrive_cinema::{
    Application,
    model::{Library, Progress},
};
use tgdrive_contract::{data::*, error_code, files::*, runtime::*};
use tgdrive_test_host::MemoryHost;

async fn index(app: &Application) {
    app.configure_libraries(
        &app.db.settings().unwrap().revision,
        vec![Library {
            id: LIBRARY.into(),
            name: "珍藏电影".into(),
            kind: "movie".into(),
            root_id: "2".into(),
        }],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
}

#[tokio::test]
async fn upgrade_rebuilds_checkpoint_and_preserves_library_account_and_user_data() {
    let (_, host) = memory(vec![
        root(),
        seed("3", "2", "影片.mp4", NodeKind::File, b"synthetic"),
    ]);
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("cinema.sqlite");
    let app = Application::new(
        Arc::new(host.clone()),
        rusqlite::Connection::open(&database).unwrap(),
        "/usr/bin/true".into(),
        "/usr/bin/true".into(),
    )
    .unwrap();
    app.db.bind_installation("g1", "1.0.1").unwrap();
    index(&app).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    app.db.set_flag(&entry.guid, true, true).unwrap();
    app.db.set_flag(&entry.guid, false, true).unwrap();
    let serial = app.db.activate(&entry.media_guid).unwrap();
    assert!(
        app.db
            .save_progress(
                &entry.media_guid,
                serial,
                &Progress {
                    ts: 207.75,
                    duration: 300.0,
                    ..Default::default()
                },
            )
            .unwrap()
    );
    app.db
        .preference("preferences", &json!({"speed":1.25}), None)
        .unwrap();
    app.db
        .update_account(
            &app.db.settings().unwrap().revision,
            "synthetic",
            "verifier",
        )
        .unwrap();
    app.db
        .set_running(&app.db.settings().unwrap().revision, true)
        .unwrap();
    let previous = app.db.settings().unwrap();
    let preferences = app.db.preference_record("preferences").unwrap();
    assert!(previous.change_cursor.is_some());
    app.db.bind_installation("g1", "1.0.1").unwrap();
    assert_eq!(
        app.db.settings().unwrap().change_cursor,
        previous.change_cursor
    );
    app.db.close();
    drop(app);

    host.reinstall().unwrap();
    host.change_node("3".into(), None, Some("更新后影片.mp4".into()), None, None)
        .unwrap();
    let current = host.fork(RuntimeCaller::Backend);
    let generation = current.runtime_info().await.unwrap().app.generation;
    let app = Application::new(
        Arc::new(current),
        rusqlite::Connection::open(&database).unwrap(),
        "/usr/bin/true".into(),
        "/usr/bin/true".into(),
    )
    .unwrap();
    app.db.bind_installation(&generation, "1.0.2").unwrap();
    let settings = app.db.settings().unwrap();
    assert!(settings.change_cursor.is_none());
    assert!(settings.scope_revision.is_empty());
    assert_eq!(settings.revision, previous.revision);
    assert_eq!(settings.index_revision, previous.index_revision);
    assert_eq!(settings.username, "synthetic");
    assert_eq!(settings.verifier, "verifier");
    assert!(settings.running);
    assert_eq!(app.db.libraries().unwrap()[0].name, "珍藏电影");
    app.synchronize(false).await.unwrap();
    let rebuilt = app.db.entry("3").unwrap().unwrap();
    assert_eq!(rebuilt.guid, entry.guid);
    assert_eq!(rebuilt.filename, "更新后影片.mp4");
    assert_eq!(app.db.flags(&rebuilt.guid).unwrap(), (true, Some(true)));
    assert_eq!(app.db.progress(&rebuilt).unwrap().ts, 207.75);
    assert_eq!(
        app.db.preference_record("preferences").unwrap(),
        preferences
    );
    assert!(app.db.settings().unwrap().change_cursor.is_some());
}

struct CursorHost {
    host: MemoryHost,
    old_cursor: String,
    reject_empty: bool,
    requests: Arc<Mutex<Vec<Option<String>>>>,
}
macro_rules! delegate {($(fn $name:ident($($arg:ident:$type:ty),*)->$output:ty;)* )=>{$(fn $name(&self,$($arg:$type),*)->HostFuture<'_,$output>{self.host.$name($($arg),*)})*};}
impl HostClient for CursorHost {
    fn changes(&self, request: FileChangesRequest) -> HostFuture<'_, FileChangesPage> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.cursor.clone());
            tokio::task::yield_now().await;
            if request.cursor.as_deref() == Some(&self.old_cursor) {
                return Err(Error::api(error_code::APP_CHANGED, "游标所属安装已改变"));
            }
            if self.reject_empty && request.cursor.is_none() {
                return Err(Error::api(error_code::SCOPE_CHANGED, "当前授权已改变"));
            }
            self.host.changes(request).await
        })
    }
    delegate! {
        fn runtime_info()->RuntimeInfo;fn scope()->ScopeInfo;fn stat(request:NodeReference)->FileNode;
        fn list(request:ListDirectoryRequest)->DirectoryPage;fn query(request:FileQuery)->FilePage;
        fn directories_with_files(request:DirectoriesWithFilesQuery)->FilePage;fn random(request:RandomFilesRequest)->RandomFilesResponse;
        fn bytes(file:ContentRef,options:ReadOptions)->ByteResponse;fn ticket_bytes(url:String,options:ReadOptions)->ByteResponse;
        fn media_url(request:MediaUrlRequest)->MediaUrl;fn local_url(request:LocalFileUrlRequest)->LocalFileUrl;fn revoke_local_url(id:String)->();
        fn create_read_lease(request:CreateReadLeaseRequest)->ReadLease;fn renew_read_lease(id:String,request:CreateReadLeaseRequest)->ReadLease;fn revoke_read_lease(id:String)->();
        fn mutate(key:String,request:FileMutationRequest)->MutationReceipt;fn mutation_receipt(key:String)->MutationReceipt;
        fn create_upload(key:String,request:CreateUploadRequest)->UploadInfo;fn upload_body(id:String,body:ByteStream,length:Option<u64>)->UploadInfo;fn upload_status(id:String)->UploadInfo;fn cancel_upload(id:String)->();
        fn kv_get(key:String)->KvGetResponse;fn kv_put(key:String,request:KvPutRequest)->KvRecord;fn kv_delete(key:String,request:KvDeleteRequest)->();fn kv_list(request:KvListRequest)->KvPage;fn data_usage()->DataUsage;
        fn cache_put(key:String,body:ByteStream,content_type:String,metadata:CachePutMetadata)->CacheEntry;fn cache_get(key:String,options:ReadOptions)->ByteResponse;fn cache_delete(key:String)->();fn cache_lookup(request:CacheLookupRequest)->CacheLookupResponse;
        fn events(cursor:Option<String>)->EventStream;fn keepalive(request:BackendKeepaliveRequest)->();
    }
}

#[tokio::test]
async fn persisted_cursor_from_previous_installation_recovers_when_opening_the_page() {
    let (mut app, host) = memory(vec![
        root(),
        seed("3", "2", "影片.mp4", NodeKind::File, b"synthetic"),
    ]);
    index(&app).await;
    let old_cursor = app.db.settings().unwrap().change_cursor.unwrap();
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    app.host = Arc::new(CursorHost {
        host,
        old_cursor: old_cursor.clone(),
        reject_empty: false,
        requests: requests.clone(),
    });
    let app = Arc::new(app);
    let response = common::wire(
        &app,
        true,
        "POST",
        "/owner/storage/get",
        None,
        json!({"key":"preferences"}),
        &[],
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(*requests.lock().unwrap(), [Some(old_cursor), None]);
    assert_eq!(app.db.entry("3").unwrap().unwrap().filename, "改名.mp4");
}

#[tokio::test]
async fn manual_rebuild_does_not_submit_the_previous_checkpoint() {
    let (mut app, host) = memory(vec![root()]);
    index(&app).await;
    let requests = Arc::new(Mutex::new(Vec::new()));
    app.host = Arc::new(CursorHost {
        host,
        old_cursor: app.db.settings().unwrap().change_cursor.unwrap(),
        reject_empty: false,
        requests: requests.clone(),
    });
    app.synchronize(true).await.unwrap();
    assert_eq!(*requests.lock().unwrap(), [None]);
}

#[tokio::test]
async fn fresh_checkpoint_failure_is_reported_without_an_unbounded_retry() {
    let (mut app, host) = memory(vec![root()]);
    index(&app).await;
    let requests = Arc::new(Mutex::new(Vec::new()));
    app.host = Arc::new(CursorHost {
        host,
        old_cursor: app.db.settings().unwrap().change_cursor.unwrap(),
        reject_empty: true,
        requests: requests.clone(),
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), app.synchronize(false))
        .await
        .expect("全新 checkpoint 失败后不得反复重试");
    assert_eq!(result.unwrap_err().code(), error_code::SCOPE_CHANGED);
    assert_eq!(requests.lock().unwrap().len(), 2);
}
