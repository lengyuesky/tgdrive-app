//! 对照旧页面流程补足迁移后的后端业务回归；仅使用合成网盘和本地假服务。
mod common;
use common::fault_host::SpyHost;
use common::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tgdrive_contract::files::*;

#[tokio::test]
async fn a_transient_single_source_detail_is_retried_once_and_finishes_the_movie() {
    let details = AtomicUsize::new(0);
    let fake = Fake::new(move |uri| {
        if uri.starts_with("/v1/movies/First/") && details.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::json(503, json!({}))
        } else {
            standard(uri, &[])
        }
    })
    .await;
    let (app, _) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 1);
    assert_eq!(fake.count("/v1/movies/First/ABC-123"), 2);
    let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
    assert_eq!(app.db.attempts(&item.id, 0, 100).unwrap().len(), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn many_real_source_failures_keep_a_bounded_summary_and_all_attempts_then_continue() {
    let fake = Fake::new(|uri| {
        if uri == "/v1/movies/search?q=ABC-123" {
            Reply::json(
                200,
                json!({"data":(0..100).map(|i| json!({"provider":format!("Provider{i}"),"id":"ABC-123","number":"ABC-123"})).collect::<Vec<_>>()}),
            )
        } else if uri.starts_with("/v1/movies/Provider") {
            Reply::json(404, json!({}))
        } else {
            standard(uri, &[])
        }
    })
    .await;
    let (app, _) = configured(
        vec![root(), video("3", "ABC-123.mp4"), video("4", "DEF-456.mp4")],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.state, "completed");
    assert_eq!(result.counts.failed, 1);
    assert_eq!(result.counts.done, 1);
    let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
    assert!(item.reason.contains("另有 97 次来源失败"));
    assert_eq!(app.db.attempts(&item.id, 0, 100).unwrap().len(), 100);
    assert!(item.reason.len() < 1024);
    app.shutdown().await;
}

#[tokio::test]
async fn moving_the_root_after_the_first_movie_stops_the_whole_task_before_the_next_source() {
    let fake = Fake::normal().await;
    let memory = memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
        video("4", "DEF-456.mp4"),
    ]);
    let changed = memory.clone();
    let spy = Arc::new(SpyHost::new(memory));
    let commits = AtomicUsize::new(0);
    *spy.fail_after.lock().unwrap() = Some(Arc::new(move |request| {
        if request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
            && commits.fetch_add(1, Ordering::SeqCst) == 1
        {
            changed
                .change_node("2".into(), None, Some("已移动".into()), None, None)
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
    assert_eq!(result.state, "failed");
    assert_eq!(result.counts.done, 1);
    assert_eq!(fake.count("/v1/movies/search?q=DEF-456"), 0);
    assert_eq!(node(spy.as_ref(), "/已移动/DEF-456.mp4").await.id, "4");
    assert_eq!(
        node(spy.as_ref(), "/已移动/ABC-123/ABC-123.mp4").await.id,
        "3"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn a_retry_of_an_incomplete_scan_rescans_every_page_and_does_not_use_a_partial_video_list() {
    let fake = Fake::normal().await;
    let mut nodes = vec![root(), video("3", "ABC-123.mp4")];
    for id in 4..604 {
        nodes.push(video(&id.to_string(), &format!("没有番号{id}.mp4")));
    }
    nodes.push(video("604", "ABC-123.mkv"));
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let queries = AtomicUsize::new(0);
    *spy.before_query.lock().unwrap() = Some(Arc::new(move |_, host| {
        if queries.fetch_add(1, Ordering::SeqCst) == 1 {
            host.set_scope(DirectoryScope::None).unwrap();
        }
    }));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let interrupted = run(&app, None).await;
    assert!(!interrupted.scan_complete);
    assert!(interrupted.counts.total > 0 && interrupted.counts.total < 602);
    assert_eq!(fake.count("/v1/"), 0);
    spy.memory
        .set_scope(DirectoryScope::All {
            access: AccessLevel::ReadWrite,
        })
        .unwrap();
    *spy.before_query.lock().unwrap() = None;
    let retried = run(&app, Some(interrupted.id)).await;
    assert!(retried.scan_complete);
    assert_eq!(retried.counts.total, 602);
    assert_eq!(retried.counts.done, 2);
    assert_eq!(retried.counts.skipped, 600);
    app.shutdown().await;
}
