//! 页面消费的业务修订、读取核对合并及封面缓存恢复回归。
mod common;
use common::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tgdrive_backend_sdk::{
    ByteResponse, ByteStream, EventStream, HostClient, HostFuture, ReadOptions,
};
use tgdrive_cinema::{Application, covers, model::Library};
use tgdrive_contract::{data::*, files::*, runtime::*};
use tgdrive_test_host::MemoryHost;

fn jpeg() -> Vec<u8> {
    use image::ImageEncoder;
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .write_image(
            &[220, 20, 30, 220, 20, 30, 220, 20, 30, 220, 20, 30],
            2,
            2,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes
}
async fn indexed(sidecar: bool, thumbnail: bool) -> (Arc<Application>, MemoryHost) {
    let mut video = seed("3", "2", "视频.mp4", NodeKind::File, b"synthetic");
    if thumbnail {
        video.thumbnail = Some(jpeg());
    }
    let mut nodes = vec![root(), video];
    if sidecar {
        nodes.push(seed("4", "2", "poster.jpg", NodeKind::File, &jpeg()));
    }
    let (app, host) = memory(nodes);
    app.configure_libraries(
        &app.db.settings().unwrap().revision,
        vec![Library {
            id: LIBRARY.into(),
            name: "合成".into(),
            kind: "movie".into(),
            root_id: "2".into(),
        }],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
    (Arc::new(app), host)
}
#[tokio::test]
async fn page_request_requeues_an_evicted_cover_without_regenerating_the_whole_library() {
    let (app, host) = indexed(true, false).await;
    assert!(covers::process_next(&app).await.unwrap());
    let entry = app.db.entry("3").unwrap().unwrap();
    let key = covers::page_key(&app, &entry).await.unwrap().unwrap();
    host.cache_delete(key.clone()).await.unwrap();
    assert!(covers::page_key(&app, &entry).await.unwrap().is_none());
    assert_eq!(covers::status(&app).unwrap()["pending"], 1);
    assert!(covers::process_next(&app).await.unwrap());
    assert_eq!(covers::page_key(&app, &entry).await.unwrap(), Some(key));
}
#[tokio::test]
async fn sidecar_cover_reuses_content_after_video_metadata_revision_changes() {
    let (app, host) = indexed(true, true).await;
    covers::process_next(&app).await.unwrap();
    let first = app.db.entry("3").unwrap().unwrap();
    let key = first.cover.clone().unwrap();
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    let current = app.db.entry("3").unwrap().unwrap();
    assert_ne!(current.thumbnail_revision, first.thumbnail_revision);
    assert_eq!(current.cover, Some(key));
    assert_eq!(covers::status(&app).unwrap()["ready"], 1);
}
#[tokio::test]
async fn thumbnail_needs_no_public_origin_and_is_conservatively_invalidated_on_node_revision() {
    let (app, host) = indexed(false, true).await;
    covers::process_next(&app).await.unwrap();
    let first = app.db.entry("3").unwrap().unwrap();
    assert_eq!(
        app.db
            .get::<covers::Record>("cover_states", &first.media_guid)
            .unwrap()
            .unwrap()
            .kind,
        "thumbnail"
    );
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    assert!(app.db.entry("3").unwrap().unwrap().cover.is_none());
    covers::process_next(&app).await.unwrap();
    assert_ne!(app.db.entry("3").unwrap().unwrap().cover, first.cover);
}
#[tokio::test]
async fn business_revision_changes_for_user_data_but_not_read_checkpoints() {
    let (app, _) = indexed(true, false).await;
    let initial = app.db.data_revision().unwrap();
    app.db.checkpoint("scope", "checkpoint").unwrap();
    assert_eq!(app.db.data_revision().unwrap(), initial);
    app.db
        .preference("preferences", &json!({"speed":1}), None)
        .unwrap();
    let preferences = app.db.data_revision().unwrap();
    assert_ne!(preferences, initial);
    app.db
        .set_flag(&app.db.entry("3").unwrap().unwrap().guid, true, true)
        .unwrap();
    assert_ne!(app.db.data_revision().unwrap(), preferences);
}

struct SlowScope {
    host: MemoryHost,
    calls: Arc<AtomicUsize>,
}
macro_rules! delegate {($(fn $name:ident($($arg:ident:$type:ty),*)->$output:ty;)* )=>{$(fn $name(&self,$($arg:$type),*)->HostFuture<'_,$output>{self.host.$name($($arg),*)})*};}
impl HostClient for SlowScope {
    fn scope(&self) -> HostFuture<'_, ScopeInfo> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            self.host.scope().await
        })
    }
    delegate! {
        fn runtime_info()->RuntimeInfo; fn stat(request:NodeReference)->FileNode; fn list(request:ListDirectoryRequest)->DirectoryPage;
        fn query(request:FileQuery)->FilePage;fn directories_with_files(request:DirectoriesWithFilesQuery)->FilePage;
        fn random(request:RandomFilesRequest)->RandomFilesResponse;fn changes(request:FileChangesRequest)->FileChangesPage;
        fn bytes(file:ContentRef,options:ReadOptions)->ByteResponse;fn ticket_bytes(url:String,options:ReadOptions)->ByteResponse;fn media_url(request:MediaUrlRequest)->MediaUrl;
        fn local_url(request:LocalFileUrlRequest)->LocalFileUrl;fn revoke_local_url(id:String)->();
        fn create_read_lease(request:CreateReadLeaseRequest)->ReadLease;fn renew_read_lease(id:String,request:CreateReadLeaseRequest)->ReadLease;fn revoke_read_lease(id:String)->();
        fn mutate(key:String,request:FileMutationRequest)->MutationReceipt;fn mutation_receipt(key:String)->MutationReceipt;
        fn create_upload(key:String,request:CreateUploadRequest)->UploadInfo;fn upload_body(id:String,body:ByteStream,length:Option<u64>)->UploadInfo;fn upload_status(id:String)->UploadInfo;fn cancel_upload(id:String)->();
        fn kv_get(key:String)->KvGetResponse;fn kv_put(key:String,request:KvPutRequest)->KvRecord;fn kv_delete(key:String,request:KvDeleteRequest)->();fn kv_list(request:KvListRequest)->KvPage;fn data_usage()->DataUsage;
        fn cache_put(key:String,body:ByteStream,content_type:String,metadata:CachePutMetadata)->CacheEntry;fn cache_get(key:String,options:ReadOptions)->ByteResponse;fn cache_delete(key:String)->();fn cache_lookup(request:CacheLookupRequest)->CacheLookupResponse;
        fn events(cursor:Option<String>)->EventStream;fn keepalive(request:BackendKeepaliveRequest)->();
    }
}
#[tokio::test]
async fn concurrent_owner_reads_share_one_slow_index_check_instead_of_rejecting_each_other() {
    let (mut app, host) = memory(vec![root()]);
    let calls = Arc::new(AtomicUsize::new(0));
    app.host = Arc::new(SlowScope {
        host,
        calls: calls.clone(),
    });
    app.synchronize(true).await.unwrap();
    let app = Arc::new(app);
    let before = calls.load(Ordering::Relaxed);
    let responses = futures_util::future::join_all((0..16).map(|_| {
        wire(
            &app,
            true,
            "POST",
            "/owner/storage/get",
            None,
            json!({"key":"preferences"}),
            &[],
        )
    }))
    .await;
    assert!(responses.iter().all(|response| response.status() == 200));
    assert_eq!(calls.load(Ordering::Relaxed) - before, 1);
}

#[tokio::test]
async fn startup_index_and_owner_read_share_the_same_check_without_a_busy_error() {
    let (mut app, host) = memory(vec![root()]);
    let calls = Arc::new(AtomicUsize::new(0));
    app.host = Arc::new(SlowScope {
        host,
        calls: calls.clone(),
    });
    let app = Arc::new(app);
    app.start_jobs();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while calls.load(Ordering::Relaxed) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let response = wire(
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
    app.shutdown().await;
}
