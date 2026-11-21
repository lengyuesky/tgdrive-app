mod common;
use common::fault_host::SpyHost;
use common::*;
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tgdrive_backend_sdk::HostClient;
use tgdrive_contract::files::*;
use tgdrive_media_scraper::model::{StartRequest, random_id};
#[tokio::test]
async fn stopping_receiving_actor_body_cancels_staging_and_never_writes_an_nfo_reference() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *spy.block_body.lock().unwrap() = Some((entered.clone(), release.clone()));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let task = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    entered.notified().await;
    let item = app.db.items(&task.id, -1, 100).unwrap().remove(0);
    let step = app
        .db
        .steps(&item.id)
        .unwrap()
        .into_iter()
        .find(|s| s.role == "actor_0")
        .unwrap();
    let upload = step.upload.unwrap().id;
    assert_eq!(
        spy.upload_status(upload.clone()).await.unwrap().state,
        UploadState::Receiving
    );
    app.stop(&task.id).await.unwrap();
    for _ in 0..100 {
        if spy.upload_status(upload.clone()).await.unwrap().state == UploadState::Cancelled {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        spy.upload_status(upload).await.unwrap().state,
        UploadState::Cancelled
    );
    release.notify_one();
    app.wait_idle().await;
    assert_eq!(app.db.run(&task.id).unwrap().state, "cancelled");
    assert!(
        spy.stat(NodeReference::Path {
            path: "/影片/ABC-123/ABC-123.nfo".into(),
            content_version: None
        })
        .await
        .is_err()
    );
    let completed = run(&app, Some(task.id)).await;
    assert_eq!(completed.counts.done, 1);
    let xml = String::from_utf8(content(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await).unwrap();
    assert!(!xml.contains(&step.name));
    assert!(xml.contains("<thumb>"));
    app.shutdown().await;
}
#[tokio::test(start_paused = true)]
async fn long_background_work_renews_keepalive_without_a_page_heartbeat() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let wait = gate.clone();
    let fake = Fake::new(move |uri| {
        let mut reply = standard(uri, &[]);
        if uri.starts_with("/v1/movies/search") {
            reply.gate = Some(wait.clone());
        }
        reply
    })
    .await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let task = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    for _ in 0..1000 {
        if fake.count("/v1/movies/search") > 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::task::yield_now().await;
    assert!(spy.keepalives.load(Ordering::SeqCst) >= 2);
    app.stop(&task.id).await.unwrap();
    app.wait_idle().await;
    app.shutdown().await;
}
#[tokio::test]
async fn avatar_moved_after_commit_but_before_nfo_is_not_written_as_a_stale_reference() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let memory = memory(vec![root(), video("3", "ABC-123.mp4")]);
    let changed = memory.clone();
    let spy = Arc::new(SpyHost::new(memory));
    let once = AtomicBool::new(false);
    *spy.fail_after.lock().unwrap() = Some(Arc::new(move |request| {
        if request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
            && !once.swap(true, Ordering::SeqCst)
        {
            changed
                .change_node("5".into(), Some("2".into()), None, None, None)
                .unwrap();
        }
        false
    }));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.skipped, 1);
    assert!(
        spy.stat(NodeReference::Path {
            path: "/影片/ABC-123/ABC-123.nfo".into(),
            content_version: None
        })
        .await
        .is_err()
    );
    app.shutdown().await;
}
#[tokio::test]
async fn changing_backend_url_before_retry_queries_the_new_source_and_keeps_existing_nfo() {
    let old = Fake::new(|uri| {
        if uri.starts_with("/v1/images/primary/") {
            Reply::json(503, json!({}))
        } else {
            standard(uri, &[])
        }
    })
    .await;
    let (app, host) = configured(vec![root(), video("3", "ABC-123.mp4")], &old).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.failed, 1);
    let nfo = node(&host, "/影片/ABC-123/ABC-123.nfo").await;
    let new = Fake::normal().await;
    configure(&app, &new, false, false).await;
    let completed = run(&app, Some(result.id)).await;
    assert_eq!(completed.counts.done, 1);
    assert_eq!(new.count("/v1/movies/search"), 1);
    assert_eq!(
        node(&host, "/影片/ABC-123/ABC-123.nfo")
            .await
            .content_version,
        nfo.content_version
    );
    app.shutdown().await;
}
