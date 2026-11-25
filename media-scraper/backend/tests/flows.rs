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

fn title(xml: &[u8]) -> String {
    let xml = std::str::from_utf8(xml).unwrap();
    let start = xml.find("<title>").unwrap() + "<title>".len();
    xml[start..xml.find("</title>").unwrap()].to_owned()
}

#[tokio::test]
async fn parts_and_versions_of_one_work_are_labelled_and_query_the_source_once() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (app, host) = configured(
        vec![
            root(),
            // 散放的上下两段：逐个移入番号目录，第一段处理时第二段还留在原处。
            video("3", "ABC-123-A.mp4"),
            video("4", "ABC-123-B.mp4"),
            // 同一番号的另外两个版本，各带自己的字幕。
            video("5", "ABC-123.mp4"),
            video("6", "ABC-123-4K.mkv"),
            seed("7", "2", "ABC-123-4K.srt", NodeKind::File, b"subtitle"),
            seed("8", "2", "ABC-123.zh.srt", NodeKind::File, b"subtitle"),
            // 没有 A、B 作伴的 -C 是中文字幕版；单独一个带清晰度的文件不加标签。
            video("9", "DEF-456-C.mp4"),
            video("10", "DEF-456.mp4"),
            video("11", "GHI-789-1080p.mp4"),
            video("12", "JKL-012 part2.mp4"),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.state, "completed");
    assert_eq!(result.counts.done, 8, "{:?}", result.counts);
    let expected = [
        (
            "/影片/ABC-123/ABC-123-A",
            "ABC-123 合成影片 &amp; 完整片名 [第1段]",
        ),
        (
            "/影片/ABC-123/ABC-123-B",
            "ABC-123 合成影片 &amp; 完整片名 [第2段]",
        ),
        ("/影片/ABC-123/ABC-123", "ABC-123 合成影片 &amp; 完整片名"),
        (
            "/影片/ABC-123/ABC-123-4K",
            "ABC-123 合成影片 &amp; 完整片名 [4K]",
        ),
        (
            "/影片/DEF-456/DEF-456-C",
            "DEF-456 合成影片 &amp; 完整片名 [中字]",
        ),
        ("/影片/DEF-456/DEF-456", "DEF-456 合成影片 &amp; 完整片名"),
        (
            "/影片/GHI-789/GHI-789-1080p",
            "GHI-789 合成影片 &amp; 完整片名",
        ),
        (
            "/影片/JKL-012/JKL-012 part2",
            "JKL-012 合成影片 &amp; 完整片名 [第2段]",
        ),
    ];
    for (base, wanted) in expected {
        assert_eq!(
            title(&content(&host, &format!("{base}.nfo")).await),
            wanted,
            "{base}"
        );
        node(&host, &format!("{base}.jpg")).await;
    }
    // 各版本的字幕跟着自己的视频移动。
    node(&host, "/影片/ABC-123/ABC-123-4K.srt").await;
    node(&host, "/影片/ABC-123/ABC-123.zh.srt").await;
    // 视频保留原名。
    node(&host, "/影片/ABC-123/ABC-123-A.mp4").await;
    node(&host, "/影片/JKL-012/JKL-012 part2.mp4").await;
    // 页面结果里带上识别出的标签。
    let labels: Vec<(String, String)> = app
        .db
        .items(&result.id, -1, 100)
        .unwrap()
        .into_iter()
        .map(|item| (item.files[0].name.clone(), item.variant))
        .collect();
    for (name, label) in [
        ("ABC-123-A.mp4", "第1段"),
        ("ABC-123-B.mp4", "第2段"),
        ("ABC-123-4K.mkv", "4K"),
        ("ABC-123.mp4", ""),
        ("DEF-456-C.mp4", "中字"),
        ("GHI-789-1080p.mp4", ""),
    ] {
        assert!(
            labels.contains(&(name.to_owned(), label.to_owned())),
            "{name} {labels:?}"
        );
    }
    // ABC-123 的四个视频只搜索一次、取一次详情、一次海报，演员也只查一次。
    assert_eq!(fake.count("/v1/movies/search?q=ABC-123"), 1);
    assert_eq!(fake.count("/v1/movies/First/ABC-123"), 1);
    assert_eq!(fake.count("/v1/images/primary/First/ABC-123"), 1);
    // 四部影片各查一次演员；演员头像地址相同，同样每部一次。
    assert_eq!(fake.count("/v1/actors/search"), 4);
    assert_eq!(fake.count("/v1/images/primary/Actors/one"), 4);
    app.shutdown().await;
}

#[tokio::test]
async fn a_later_run_labels_files_already_inside_the_number_directory() {
    let fake = Fake::normal().await;
    let (app, host) = configured(
        vec![
            root(),
            seed("20", "2", "ABC-123", NodeKind::Directory, b""),
            // 番号来自目录的文件同样参与分段与版本判断。
            seed("21", "20", "cd1.mp4", NodeKind::File, b"synthetic-video"),
            seed("22", "20", "cd2.mp4", NodeKind::File, b"synthetic-video"),
            seed(
                "23",
                "20",
                "ABC-123-UC.mp4",
                NodeKind::File,
                b"synthetic-video",
            ),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 3, "{:?}", result.counts);
    for (name, wanted) in [
        ("cd1", "ABC-123 合成影片 &amp; 完整片名 [第1段]"),
        ("cd2", "ABC-123 合成影片 &amp; 完整片名 [第2段]"),
        ("ABC-123-UC", "ABC-123 合成影片 &amp; 完整片名 [无码 中字]"),
    ] {
        assert_eq!(
            title(&content(&host, &format!("/影片/ABC-123/{name}.nfo")).await),
            wanted
        );
    }
    // 默认只补缺：再跑一遍不改动已有 NFO，标签不会因为重跑而变化。
    let before = node(&host, "/影片/ABC-123/cd1.nfo").await;
    let again = run(&app, None).await;
    assert_eq!(again.counts.done, 3);
    assert_eq!(
        node(&host, "/影片/ABC-123/cd1.nfo").await.revision,
        before.revision
    );
    app.shutdown().await;
}
