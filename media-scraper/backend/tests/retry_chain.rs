//! 空重试任务仍追溯原任务；同轮缺证据不写入，换轮次才按当前文件补缺。
mod common;
use common::fault_host::SpyHost;
use common::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tgdrive_contract::{files::*, runtime::RuntimeCaller};
use tgdrive_media_scraper::model::{StartRequest, random_id};

#[tokio::test]
async fn repeated_unscanned_retries_keep_verifying_the_original_and_preserve_request_idempotency() {
    let fake = Fake::normal().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite3");
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    let once = AtomicBool::new(false);
    *spy.fail_before.lock().unwrap() = Some(Arc::new(move |request| {
        request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::Move { .. }))
            && !once.swap(true, Ordering::SeqCst)
    }));
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open(&path).unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let original = run(&app, None).await;
    let first_retry = run(&app, Some(original.id.clone())).await;
    assert!(!first_retry.scan_complete);
    let input = StartRequest {
        request_id: random_id(),
        directory_id: "2".into(),
        retry_of: Some(first_retry.id),
    };
    let second = app.start(input.clone()).await.unwrap();
    app.wait_idle().await;
    let second = app.db.run(&second.id).unwrap();
    assert_eq!(second.state, "interrupted");
    assert_eq!(second.retry_of.as_deref(), Some(original.id.as_str()));
    assert_eq!(app.start(input.clone()).await.unwrap().id, second.id);
    let saved: String = app
        .db
        .with(|db| {
            Ok(db
                .query_row(
                    "SELECT request FROM runs WHERE id=?1",
                    [&second.id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    assert_eq!(saved, serde_json::to_string(&input).unwrap());
    assert_eq!(
        spy.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.starts_with("mutate:"))
            .count(),
        1
    );
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mp4").await.id, "3");
    let third = run(&app, Some(second.id)).await;
    assert_eq!(third.state, "interrupted");
    assert_eq!(third.retry_of.as_deref(), Some(original.id.as_str()));
    app.shutdown().await;

    spy.memory.restart().unwrap();
    let next = application(
        Arc::new(spy.memory.fork(RuntimeCaller::Backend)),
        rusqlite::Connection::open(&path).unwrap(),
        "run-2",
    );
    assert!(next.db.active_run().unwrap().is_none());
    let completed = run(&next, Some(third.id)).await;
    assert_eq!(completed.counts.done, 1);
    assert_eq!(completed.retry_of.as_deref(), Some(original.id.as_str()));
    next.shutdown().await;
}

#[tokio::test]
async fn malformed_retry_cycles_are_rejected_without_starting_network_or_file_work() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "没有番号.mp4"),
    ])));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let run = run(&app, None).await;
    app.db
        .with(|db| {
            db.execute(
                "UPDATE runs SET scan_complete=0,retry_of=id WHERE id=?1",
                [&run.id],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let before = spy.events.lock().unwrap().len();
    assert_eq!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: Some(run.id)
        })
        .await
        .unwrap_err()
        .code(),
        "storage_unavailable"
    );
    assert_eq!(spy.events.lock().unwrap().len(), before);
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
