mod common;
use common::fault_host::{MutationFilter, SpyHost};
use common::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tgdrive_backend_sdk::{Error, HostClient};
use tgdrive_contract::files::*;
use tgdrive_media_scraper::{
    model::{StartRequest, random_id},
    nfo,
};
use tgdrive_test_host::SeedNode;

fn existing_media() -> (Vec<SeedNode>, String) {
    let old = nfo::actor_image_name("ABC-123", "旧刮削", 0);
    let nodes = vec![
        root(),
        seed("4", "2", "ABC-123", NodeKind::Directory, b""),
        seed("3", "4", "ABC-123.mp4", NodeKind::File, b"synthetic-video"),
        seed("5", "4", "ABC-123.nfo", NodeKind::File, &existing_nfo(&old)),
        seed("6", "4", "ABC-123.jpg", NodeKind::File, &jpeg()),
        seed("7", "4", &old, NodeKind::File, &jpeg()),
    ];
    (nodes, old)
}

fn existing_nfo(thumb: &str) -> Vec<u8> {
    format!("<movie><num>ABC-123</num><title>原资料</title><actor><name>演员甲</name><thumb>{thumb}</thumb></actor></movie>").into_bytes()
}

fn has_trash(request: &FileMutationRequest) -> bool {
    request
        .operations
        .iter()
        .any(|op| matches!(op, FileOperation::Trash { .. }))
}

fn nth_commit(index: usize) -> MutationFilter {
    let count = AtomicUsize::new(0);
    Arc::new(move |request| {
        request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
            && count.fetch_add(1, Ordering::SeqCst) + 1 == index
    })
}

async fn missing(host: &dyn HostClient, id: &str) {
    assert_eq!(
        host.stat(NodeReference::Id {
            id: id.into(),
            content_version: None
        })
        .await
        .unwrap_err()
        .code(),
        "not_found"
    );
}

async fn portraits(host: &dyn HostClient, directory: &str) -> Vec<FileNode> {
    let mut request = ListDirectoryRequest {
        directory: NodeReference::Id {
            id: directory.into(),
            content_version: None,
        },
        sort: NodeSort::Id,
        order: SortOrder::Asc,
        limit: 500,
        cursor: None,
    };
    let mut files = Vec::new();
    loop {
        let page = host.list(request.clone()).await.unwrap();
        files.extend(page.items.into_iter().filter(|node| {
            node.kind == NodeKind::File && nfo::is_actor_image(&node.name, "ABC-123")
        }));
        request.cursor = page.next_cursor;
        if request.cursor.is_none() {
            return files;
        }
    }
}

#[tokio::test]
async fn repeated_overwrites_reclaim_old_portraits_after_confirming_the_new_nfo() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (app, host) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    configure(&app, &fake, true, false).await;
    let mut previous = None;
    for _ in 0..3 {
        let run = run(&app, None).await;
        assert_eq!(run.counts.done, 1);
        let item = app.db.items(&run.id, -1, 100).unwrap().remove(0);
        let files = portraits(&host, item.target_id.as_ref().unwrap()).await;
        assert_eq!(files.len(), 1, "连续覆盖后只保留 NFO 正在引用的头像");
        assert_eq!(files[0].name, item.actors[0].data.thumb);
        let xml = String::from_utf8(content(&host, "/影片/ABC-123/ABC-123.nfo").await).unwrap();
        assert!(xml.contains(&format!("<thumb>{}</thumb>", files[0].name)));
        if let Some(id) = previous {
            assert_eq!(
                host.stat(NodeReference::Id {
                    id,
                    content_version: None,
                })
                .await
                .unwrap_err()
                .code(),
                "not_found"
            );
        }
        previous = Some(files[0].id.clone());
    }
    app.shutdown().await;
}

#[tokio::test]
async fn keeping_a_valid_nfo_cleans_orphans_without_replacing_its_referenced_portrait() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (mut nodes, old) = existing_media();
    nodes.push(seed(
        "10",
        "4",
        &nfo::actor_image_name("ABC-123", "已失效的一代", 0),
        NodeKind::File,
        &jpeg(),
    ));
    let (app, host) = configured(nodes, &fake).await;
    let original = node(&host, "/影片/ABC-123/ABC-123.nfo").await;
    let completed = run(&app, None).await;
    assert_eq!(completed.counts.done, 1);
    assert_eq!(
        content(&host, "/影片/ABC-123/ABC-123.nfo").await,
        existing_nfo(&old)
    );
    assert_eq!(
        node(&host, "/影片/ABC-123/ABC-123.nfo")
            .await
            .content_version,
        original.content_version
    );
    missing(&host, "10").await;
    assert_eq!(portraits(&host, "4").await[0].id, "7");
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}

#[tokio::test]
async fn overwrite_cleans_every_old_generation_but_keeps_shared_and_unrelated_images() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (mut nodes, _) = existing_media();
    for id in ["10", "11", "12", "13"] {
        nodes.push(seed(
            id,
            "4",
            &nfo::actor_image_name("ABC-123", id, 0),
            NodeKind::File,
            &jpeg(),
        ));
    }
    let shared = nfo::actor_image_name("ABC-123", "12", 0);
    let other = nfo::actor_image_name("ABC-123", "13", 0);
    nodes.extend([
        seed(
            "22",
            "4",
            "movie.nfo",
            NodeKind::File,
            &existing_nfo(&format!("./{}", shared.to_ascii_uppercase())),
        ),
        seed(
            "23",
            "4",
            "另一视频.nfo",
            NodeKind::File,
            &existing_nfo(&format!("images/../{other}")),
        ),
        seed(
            "14",
            "4",
            &nfo::actor_image_name("DEF-456", "其他视频", 0),
            NodeKind::File,
            &jpeg(),
        ),
        seed("15", "4", "手工演员.jpg", NodeKind::File, &jpeg()),
        seed(
            "16",
            "4",
            &format!("{}manual-0.jpg", nfo::actor_image_prefix("ABC-123")),
            NodeKind::File,
            &jpeg(),
        ),
        seed(
            "17",
            "4",
            &nfo::actor_image_name("ABC-123", "目录", 0),
            NodeKind::Directory,
            b"",
        ),
    ]);
    let (app, host) = configured(nodes, &fake).await;
    configure(&app, &fake, true, false).await;
    let completed = run(&app, None).await;
    assert_eq!(completed.counts.done, 1);
    for id in ["7", "10", "11"] {
        missing(&host, id).await;
    }
    for id in ["12", "13", "14", "15", "16", "17"] {
        assert!(
            host.stat(NodeReference::Id {
                id: id.into(),
                content_version: None
            })
            .await
            .is_ok(),
            "仍需保留节点 {id}"
        );
    }
    assert_eq!(portraits(&host, "4").await.len(), 3);
    assert!(
        String::from_utf8(content(&host, "/影片/ABC-123/movie.nfo").await)
            .unwrap()
            .contains(&shared.to_ascii_uppercase())
    );
    app.shutdown().await;
}

#[tokio::test]
async fn rejected_nfo_overwrite_preserves_the_old_nfo_and_its_portrait() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, old) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let reject = nth_commit(2);
    *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |request, _| {
        if reject(request) {
            Err(Error::api("node_changed", "合成 NFO 覆盖冲突"))
        } else {
            Ok(())
        }
    }));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let rejected = run(&app, None).await;
    assert_eq!(rejected.counts.skipped, 1);
    assert_eq!(
        content(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await,
        existing_nfo(&old)
    );
    assert!(
        spy.stat(NodeReference::Id {
            id: "7".into(),
            content_version: None
        })
        .await
        .is_ok()
    );
    let item = app.db.items(&rejected.id, -1, 100).unwrap().remove(0);
    assert!(
        app.db
            .steps(&item.id)
            .unwrap()
            .iter()
            .all(|step| step.role != "actor_cleanup")
    );
    app.shutdown().await;
}

#[tokio::test]
async fn unknown_nfo_submission_retains_old_images_until_retry_confirms_the_nfo() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, _) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    *spy.fail_after.lock().unwrap() = Some(nth_commit(2));
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let first = run(&app, None).await;
    assert_eq!(first.state, "interrupted");
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 2);
    let submitted = node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await;
    let retried = run(&app, Some(first.id)).await;
    assert_eq!(retried.counts.done, 1);
    assert_eq!(
        node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo")
            .await
            .content_version,
        submitted.content_version
    );
    missing(spy.as_ref(), "7").await;
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 1);
    assert_eq!(fake.count("/v1/actors/search"), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn stopping_during_nfo_submission_preserves_old_portraits() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, _) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *spy.block_mutation.lock().unwrap() = Some((nth_commit(2), entered.clone(), release.clone()));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let active = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    app.stop(&active.id).await.unwrap();
    release.notify_one();
    app.wait_idle().await;
    assert_eq!(app.db.run(&active.id).unwrap().state, "cancelled");
    assert!(
        spy.stat(NodeReference::Id {
            id: "7".into(),
            content_version: None
        })
        .await
        .is_ok()
    );
    app.shutdown().await;
}

#[tokio::test]
async fn adding_an_nfo_reference_during_cleanup_prevents_the_trash_transaction() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, old) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let changed = AtomicBool::new(false);
    *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |request, host| {
        if has_trash(request) && !changed.swap(true, Ordering::SeqCst) {
            host.add_node(seed(
                "50",
                "4",
                "movie.nfo",
                NodeKind::File,
                &existing_nfo(&old),
            ))?;
        }
        Ok(())
    }));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let conflicted = run(&app, None).await;
    assert_eq!(conflicted.counts.skipped, 1);
    assert!(
        spy.stat(NodeReference::Id {
            id: "7".into(),
            content_version: None
        })
        .await
        .is_ok()
    );
    let retried = run(&app, Some(conflicted.id)).await;
    assert_eq!(retried.counts.done, 1);
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 2);
    assert_eq!(fake.count("/v1/actors/search"), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn malformed_neighbor_nfo_preserves_old_images_instead_of_guessing_references() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (mut nodes, _) = existing_media();
    nodes.push(seed(
        "10",
        "4",
        "movie.nfo",
        NodeKind::File,
        b"<movie><actor>",
    ));
    let (app, host) = configured(nodes, &fake).await;
    configure(&app, &fake, true, false).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.skipped, 1);
    assert!(
        host.stat(NodeReference::Id {
            id: "7".into(),
            content_version: None
        })
        .await
        .is_ok()
    );
    app.shutdown().await;
}

#[tokio::test]
async fn cleanup_pages_the_whole_directory_and_batches_more_than_sixty_four_old_images() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let mut nodes = vec![
        seed("2", "1", "ABC-123", NodeKind::Directory, b""),
        video("3", "ABC-123.mp4"),
        seed("5", "2", "ABC-123.nfo", NodeKind::File, &existing_nfo("")),
        seed("6", "2", "ABC-123.jpg", NodeKind::File, &jpeg()),
    ];
    for id in 100..230 {
        nodes.push(seed(
            &id.to_string(),
            "2",
            &nfo::actor_image_name("ABC-123", &id.to_string(), 0),
            NodeKind::File,
            &jpeg(),
        ));
    }
    for id in 1000..1550 {
        nodes.push(seed(
            &id.to_string(),
            "2",
            &format!("保留文件{id}.txt"),
            NodeKind::File,
            b"manual",
        ));
    }
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let completed = run(&app, None).await;
    assert_eq!(completed.counts.done, 1);
    assert_eq!(portraits(spy.as_ref(), "2").await.len(), 1);
    for id in 100..230 {
        missing(spy.as_ref(), &id.to_string()).await;
    }
    assert!(
        spy.stat(NodeReference::Id {
            id: "1549".into(),
            content_version: None
        })
        .await
        .is_ok()
    );
    let item = app.db.items(&completed.id, -1, 100).unwrap().remove(0);
    let cleanup: Vec<_> = app
        .db
        .steps(&item.id)
        .unwrap()
        .into_iter()
        .filter(|step| step.role == "actor_cleanup")
        .collect();
    assert_eq!(cleanup.len(), 3);
    assert_eq!(
        cleanup.iter().map(|step| step.before.len()).sum::<usize>(),
        130
    );
    assert!(cleanup.iter().all(|step| step.state == "done"
        && step.mutation_request.as_ref().unwrap().operations.len() <= 64));
    assert!(spy.lists.load(Ordering::SeqCst) > 1);
    app.shutdown().await;
}

#[tokio::test]
async fn unknown_cleanup_is_verified_without_replaying_it_or_uploading_portraits_again() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, _) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    *spy.fail_after.lock().unwrap() = Some(Arc::new(has_trash));
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let first = run(&app, None).await;
    assert_eq!(first.state, "interrupted");
    let item = app.db.items(&first.id, -1, 100).unwrap().remove(0);
    let cleanup = app
        .db
        .steps(&item.id)
        .unwrap()
        .into_iter()
        .find(|step| step.role == "actor_cleanup")
        .unwrap();
    assert_eq!(cleanup.state, "unknown");
    missing(spy.as_ref(), "7").await;
    let second = run(&app, Some(first.id)).await;
    assert_eq!(second.state, "interrupted");
    spy.hide_receipts.store(false, Ordering::SeqCst);
    let confirmed = run(&app, Some(second.id)).await;
    assert_eq!(confirmed.counts.done, 1);
    assert_eq!(app.db.step(&cleanup.id).unwrap().state, "done");
    let event = format!("mutate:{}", cleanup.mutation_key.unwrap());
    assert_eq!(
        spy.events
            .lock()
            .unwrap()
            .iter()
            .filter(|value| *value == &event)
            .count(),
        1
    );
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 1);
    assert_eq!(fake.count("/v1/actors/search"), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn an_unsubmitted_cleanup_requires_restart_then_replans_against_current_files() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (nodes, _) = existing_media();
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let once = AtomicBool::new(false);
    *spy.fail_before.lock().unwrap() = Some(Arc::new(move |request| {
        has_trash(request) && !once.swap(true, Ordering::SeqCst)
    }));
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("app.sqlite3");
    let app = application(
        spy.clone(),
        rusqlite::Connection::open(&path).unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, false).await;
    let first = run(&app, None).await;
    assert_eq!(first.state, "interrupted");
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 2);
    let item = app.db.items(&first.id, -1, 100).unwrap().remove(0);
    let cleanup = app
        .db
        .steps(&item.id)
        .unwrap()
        .into_iter()
        .find(|step| step.role == "actor_cleanup")
        .unwrap();
    let second = run(&app, Some(first.id)).await;
    assert_eq!(second.state, "interrupted");
    app.shutdown().await;
    let restarted = application(
        spy.clone(),
        rusqlite::Connection::open(&path).unwrap(),
        "run-2",
    );
    let finished = run(&restarted, Some(second.id)).await;
    assert_eq!(finished.counts.done, 1);
    missing(spy.as_ref(), "7").await;
    let event = format!("mutate:{}", cleanup.mutation_key.unwrap());
    assert_eq!(
        spy.events
            .lock()
            .unwrap()
            .iter()
            .filter(|value| *value == &event)
            .count(),
        1
    );
    assert_eq!(portraits(spy.as_ref(), "4").await.len(), 1);
    assert_eq!(fake.count("/v1/actors/search"), 1);
    restarted.shutdown().await;
}
