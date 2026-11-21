mod common;
use common::fault_host::SpyHost;
use common::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tgdrive_backend_sdk::HostClient;
use tgdrive_contract::files::*;
use tgdrive_media_scraper::{
    model::{StartRequest, random_id},
    nfo,
    planner::{DirectoryCache, build},
};

#[tokio::test]
async fn whole_group_moves_once_and_writes_complete_exclusive_sidecars() {
    let fake = Fake::normal().await;
    let (app, host) = configured(
        vec![
            root(),
            video("3", "ABC-123.mp4"),
            video("4", "ABC-123.mkv"),
            seed("5", "2", "ABC-123.zh.srt", NodeKind::File, b"caption"),
            seed("6", "2", "unrelated.txt", NodeKind::File, b"keep"),
        ],
        &fake,
    )
    .await;
    let before = node(&host, "/影片/ABC-123.mp4").await;
    let result = run(&app, None).await;
    assert_eq!(result.state, "completed");
    assert_eq!(result.counts.done, 2);
    let after = node(&host, "/影片/ABC-123/ABC-123.mp4").await;
    assert_eq!(after.id, before.id);
    assert_eq!(after.content_version, before.content_version);
    assert_eq!(node(&host, "/影片/ABC-123/ABC-123.zh.srt").await.id, "5");
    assert_eq!(node(&host, "/影片/unrelated.txt").await.id, "6");
    let xml = String::from_utf8(content(&host, "/影片/ABC-123/ABC-123.nfo").await).unwrap();
    let document = nfo::document(&xml).unwrap();
    let root = document.root_element();
    assert_eq!(
        root.children()
            .find(|n| n.has_tag_name("title"))
            .and_then(|n| n.text()),
        Some("ABC-123 合成影片 & 完整片名")
    );
    assert_eq!(
        root.children()
            .find(|n| n.has_tag_name("plot"))
            .and_then(|n| n.text())
            .unwrap()
            .len(),
        "长简介。".repeat(2000).len()
    );
    assert!(!xml.contains("<rating>"));
    let poster = content(&host, "/影片/ABC-123/ABC-123.jpg").await;
    let image = image::load_from_memory(&poster).unwrap();
    assert_eq!(image.width() * 3, image.height() * 2);
    let items = app.db.items(&result.id, -1, 100).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].files.len(), 2);
    for step in app.db.steps(&items[0].id).unwrap() {
        assert!(step.receipt.is_some() || step.state == "kept");
        assert!(step.state == "done" || step.state == "kept");
    }
    app.shutdown().await;
}
#[tokio::test]
async fn existing_valid_specific_metadata_is_kept_and_moves_with_video_without_network() {
    let fake = Fake::normal().await;
    let nfo = b"<movie><num>ABC-123</num><title>original</title></movie>";
    let jpeg = jpeg();
    let (app, host) = configured(
        vec![
            root(),
            video("3", "ABC-123.mp4"),
            seed("4", "2", "ABC-123.NFO", NodeKind::File, nfo),
            seed("5", "2", "ABC-123-poster.jpeg", NodeKind::File, &jpeg),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 1);
    assert_eq!(fake.count("/v1/"), 0);
    assert_eq!(content(&host, "/影片/ABC-123/ABC-123.NFO").await, nfo);
    assert_eq!(
        content(&host, "/影片/ABC-123/ABC-123-poster.jpeg").await,
        jpeg
    );
    app.shutdown().await;
}
#[tokio::test]
async fn loose_video_with_common_metadata_is_skipped_without_touching_any_file() {
    let fake = Fake::normal().await;
    let (app, host) = configured(
        vec![
            root(),
            video("3", "ABC-123.mp4"),
            seed(
                "4",
                "2",
                "movie.nfo",
                NodeKind::File,
                b"<movie><num>ABC-123</num></movie>",
            ),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.skipped, 1);
    assert_eq!(node(&host, "/影片/ABC-123.mp4").await.id, "3");
    assert_eq!(node(&host, "/影片/movie.nfo").await.id, "4");
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn subtitle_language_and_poster_aliases_with_multiple_owners_skip_affected_groups() {
    for (second, sidecar) in [
        ("ABC-123.zh.mp4", "ABC-123.zh.srt"),
        ("ABC-123-poster.mp4", "ABC-123-poster.jpg"),
    ] {
        let fake = Fake::normal().await;
        let (app, host) = configured(
            vec![
                root(),
                video("3", "ABC-123.mp4"),
                video("4", second),
                seed("5", "2", sidecar, NodeKind::File, &jpeg()),
            ],
            &fake,
        )
        .await;
        let result = run(&app, None).await;
        assert_eq!(result.counts.skipped, 2, "{second}");
        assert_eq!(node(&host, "/影片/ABC-123.mp4").await.id, "3");
        assert_eq!(node(&host, &format!("/影片/{second}")).await.id, "4");
        app.shutdown().await;
    }
}
#[tokio::test]
async fn existing_number_directory_is_reused_and_common_metadata_stays_shared() {
    let fake = Fake::normal().await;
    let (app, host) = configured(
        vec![
            seed("2", "1", "ABC-123", NodeKind::Directory, b""),
            seed("3", "2", "unknown.mp4", NodeKind::File, b"video"),
            seed(
                "4",
                "2",
                "movie.nfo",
                NodeKind::File,
                b"<movie><num>ABC-123</num><title>shared</title></movie>",
            ),
            seed("5", "2", "folder.jpg", NodeKind::File, &jpeg()),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 1);
    assert_eq!(node(&host, "/ABC-123/unknown.mp4").await.id, "3");
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn multiple_same_number_directories_and_target_collisions_never_move_part_of_group() {
    for targets in [
        vec![
            seed("5", "2", "ABC-123", NodeKind::Directory, b""),
            seed("6", "2", "abc123", NodeKind::Directory, b""),
        ],
        vec![
            seed("5", "2", "ABC-123", NodeKind::Directory, b""),
            seed("6", "5", "ABC-123.mp4", NodeKind::File, b"existing"),
        ],
        vec![seed("5", "2", "ABC-123", NodeKind::File, b"occupied")],
    ] {
        let fake = Fake::normal().await;
        let mut nodes = vec![root(), video("3", "ABC-123.mp4"), video("4", "ABC-123.mkv")];
        nodes.extend(targets);
        let (app, host) = configured(nodes, &fake).await;
        let result = run(&app, None).await;
        assert_eq!(result.counts.skipped, 2);
        assert_eq!(node(&host, "/影片/ABC-123.mp4").await.id, "3");
        assert_eq!(node(&host, "/影片/ABC-123.mkv").await.id, "4");
        app.shutdown().await;
    }
}
#[tokio::test]
async fn source_children_assertion_rejects_caption_added_after_plan() {
    let host = memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
        video("4", "ABC-123.mkv"),
    ]);
    let scope = host.scope().await.unwrap();
    let files = vec![
        node(&host, "/影片/ABC-123.mp4").await,
        node(&host, "/影片/ABC-123.mkv").await,
    ];
    let plan = build(
        &host,
        &mut DirectoryCache::default(),
        &files,
        "ABC-123",
        &scope.revision,
        (false, false),
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    let request = plan.organizing_request(&scope.revision).unwrap().unwrap();
    assert!(
        request
            .assertions
            .iter()
            .any(|a| matches!(a,FileAssertion::Children { directory_id,.. } if directory_id=="2"))
    );
    host.add_node(seed(
        "5",
        "2",
        "ABC-123.zh.srt",
        NodeKind::File,
        b"new caption",
    ))
    .unwrap();
    assert_eq!(
        host.mutate(random_id(), request).await.unwrap_err().code(),
        "children_changed"
    );
    assert_eq!(node(&host, "/影片/ABC-123.mp4").await.id, "3");
    assert!(
        host.stat(NodeReference::Path {
            path: "/影片/ABC-123".into(),
            content_version: None
        })
        .await
        .is_err()
    );
}
#[tokio::test]
async fn same_number_segments_share_a_source_but_keep_individual_playback_entries() {
    let fake = Fake::normal().await;
    let (app, host) = configured(
        vec![
            root(),
            video("3", "ABC-123-CD1.mp4"),
            video("4", "ABC-123-4K.mp4"),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 2);
    assert_eq!(fake.count("/v1/movies/search"), 1);
    assert_eq!(fake.count("/v1/movies/First/ABC-123"), 1);
    assert_ne!(
        node(&host, "/影片/ABC-123/ABC-123-CD1.mp4").await.id,
        node(&host, "/影片/ABC-123/ABC-123-4K.mp4").await.id
    );
    app.shutdown().await;
}
#[tokio::test]
async fn exact_sources_are_tried_in_order_before_retrying_a_transient_failure() {
    let fake=Fake::new(|uri| {
        if uri.starts_with("/v1/movies/search") { Reply::json(200,json!({"data":[{"provider":"FANZA","id":"sone00614","number":"SONE-614"},{"provider":"JAV321","id":"sone00614","number":"SONE-614"},{"provider":"Other","id":"other","number":"OTHER-123"}]})) }
        else if uri.starts_with("/v1/movies/FANZA/") { Reply::json(503,json!({})) }
        else { standard(uri,&[]) }
    }).await;
    let (app, _) = configured(
        vec![
            root(),
            video("3", "SONE-614.mp4"),
            video("4", "SONE-614-CD1.mp4"),
        ],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 2);
    assert_eq!(fake.count("/v1/movies/FANZA/"), 1);
    assert_eq!(fake.count("/v1/movies/JAV321/"), 1);
    let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
    assert_eq!(
        app.db.attempts(&item.id, 0, 100).unwrap()[0].provider,
        "FANZA"
    );
    app.shutdown().await;
}
#[tokio::test]
async fn missing_or_wrong_number_detail_falls_through_to_the_next_source() {
    for wrong in [false, true] {
        let fake=Fake::new(move |uri| {
            if uri.starts_with("/v1/movies/search") { Reply::json(200,json!({"data":[{"provider":"First","id":"ABC-123","number":"ABC-123"},{"provider":"Second","id":"ABC-123","number":"ABC-123"}]})) }
            else if uri.starts_with("/v1/movies/First/") { if wrong { Reply::json(200,json!({"data":{"provider":"First","id":"ABC-123","number":"OTHER-123","title":"wrong"}})) } else { Reply::json(404,json!({})) } }
            else { standard(uri,&[]) }
        }).await;
        let (app, _) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
        assert_eq!(run(&app, None).await.counts.done, 1);
        assert_eq!(fake.count("/v1/movies/First/"), 1);
        assert_eq!(fake.count("/v1/movies/Second/"), 1);
        app.shutdown().await;
    }
}
#[tokio::test]
async fn persistent_source_failure_is_logged_and_later_movie_still_finishes() {
    let fake = Fake::new(|uri| {
        if uri.contains("ABC-123") && uri.starts_with("/v1/movies/search") {
            Reply::json(503, json!({}))
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
    assert_eq!(result.counts.failed, 1);
    assert_eq!(result.counts.done, 1);
    assert_eq!(fake.count("/v1/movies/search?q=ABC-123"), 2);
    let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
    assert_eq!(app.db.attempts(&item.id, 0, 100).unwrap().len(), 2);
    app.shutdown().await;
}
#[tokio::test]
async fn later_slow_source_cannot_hold_back_the_already_completed_movie() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let later = gate.clone();
    let fake = Fake::new(move |uri| {
        let mut reply = standard(uri, &[]);
        if uri == "/v1/movies/search?q=DEF-456" {
            reply.gate = Some(later.clone());
        }
        reply
    })
    .await;
    let (app, host) = configured(
        vec![root(), video("3", "ABC-123.mp4"), video("4", "DEF-456.mp4")],
        &fake,
    )
    .await;
    let job = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    for _ in 0..1000 {
        if fake.count("/v1/movies/search?q=DEF-456") > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(
        node(&host, "/影片/ABC-123/ABC-123.nfo").await.kind,
        NodeKind::File
    );
    assert_eq!(app.db.run(&job.id).unwrap().counts.done, 1);
    gate.notify_one();
    app.wait_idle().await;
    assert_eq!(app.db.run(&job.id).unwrap().counts.done, 2);
    app.shutdown().await;
}
#[tokio::test]
async fn poster_service_failure_keeps_nfo_and_continues_other_movies() {
    let fake = Fake::new(|uri| {
        if uri.starts_with("/v1/images/primary/First/ABC-123") {
            Reply::json(503, json!({}))
        } else {
            standard(uri, &[])
        }
    })
    .await;
    let (app, host) = configured(
        vec![root(), video("3", "ABC-123.mp4"), video("4", "DEF-456.mp4")],
        &fake,
    )
    .await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.failed, 1);
    assert_eq!(result.counts.done, 1);
    assert_eq!(
        node(&host, "/影片/ABC-123/ABC-123.nfo").await.kind,
        NodeKind::File
    );
    app.shutdown().await;
}
#[tokio::test]
async fn weak_scan_handles_upserts_and_short_byte_pages_without_losing_cross_page_groups() {
    let fake = Fake::normal().await;
    let mut nodes = vec![root(), video("3", "ABC-123.mp4")];
    for id in 4..604 {
        nodes.push(video(&id.to_string(), &format!("没有番号-{id}.mp4")));
    }
    nodes.push(video("604", "ABC-123.mkv"));
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.total, 602);
    assert_eq!(result.counts.done, 2);
    assert_eq!(result.counts.skipped, 600);
    assert!(spy.queries.load(Ordering::SeqCst) >= 2);
    {
        let events = spy.events.lock().unwrap();
        let first_write = events
            .iter()
            .position(|e| e.starts_with("mutate:"))
            .unwrap();
        assert!(
            events[..first_write]
                .iter()
                .filter(|e| e.starts_with("query:"))
                .count()
                >= 2
        );
    }
    app.shutdown().await;
}
#[tokio::test]
async fn changing_source_children_after_preparation_never_moves_a_partial_group() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
        video("4", "ABC-123.mkv"),
    ])));
    let once = AtomicBool::new(false);
    *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |request, host| {
        if request
            .operations
            .iter()
            .any(|op| matches!(op, FileOperation::Move { .. }))
            && !once.swap(true, Ordering::SeqCst)
        {
            host.add_node(seed(
                "5",
                "2",
                "ABC-123.zh.srt",
                NodeKind::File,
                b"concurrent",
            ))
            .unwrap();
        }
        Ok(())
    }));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.skipped, 2);
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mp4").await.id, "3");
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mkv").await.id, "4");
    app.shutdown().await;
}
