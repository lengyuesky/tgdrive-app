//! 页面迁移回归：独立 SQLite 提供目录、选集、收藏与观看标记，不依赖旧页面 SDK。
mod common;
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;
use tgdrive_cinema::{model::Library, page_files};
use tgdrive_contract::files::*;

async fn indexed(
    nodes: Vec<tgdrive_test_host::SeedNode>,
    kind: &str,
) -> (
    Arc<tgdrive_cinema::Application>,
    tgdrive_test_host::MemoryHost,
) {
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
    (Arc::new(app), host)
}

#[tokio::test]
async fn page_raw_tv_catalog_keeps_episodes_searches_filename_and_filters_extensions() {
    let (app, _) = indexed(
        vec![
            root(),
            seed("3", "2", "剧.S01E01.mp4", NodeKind::File, b"video"),
            seed("4", "2", "剧.S01E02.mkv", NodeKind::File, b"video"),
            seed(
                "5",
                "2",
                "剧.S01E01.nfo",
                NodeKind::File,
                "<episodedetails><title>资料标题</title></episodedetails>".as_bytes(),
            ),
        ],
        "tv",
    )
    .await;
    let (status, page) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/catalog",
            None,
            json!({"ancestor":LIBRARY,"raw_files":true,"limit":1}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["total"], 2);
    assert!(page["next_cursor"].is_string());
    let (_, filtered) = body(wire(&app,true,"POST","/owner/catalog",None,json!({"ancestor":LIBRARY,"raw_files":true,"q":"S01E01","extensions":["mp4"],"limit":48}),&[]).await).await;
    assert_eq!(filtered["items"][0]["id"], "3");
    assert_eq!(filtered["descriptions"]["3"]["title"], "资料标题");
    assert_eq!(filtered["total"], 1);
}

#[tokio::test]
async fn playlist_is_natural_keyset_paginated_and_neighbor_is_not_limited_to_a_page() {
    let (app, _) = indexed(
        vec![
            root(),
            seed("3", "2", "第10集.mp4", NodeKind::File, b"v"),
            seed("4", "2", "第2集.mp4", NodeKind::File, b"v"),
            seed("5", "2", "第1集.mp4", NodeKind::File, b"v"),
            seed("6", "2", "海报.jpg", NodeKind::File, b"image"),
            seed("7", "2", "子目录", NodeKind::Directory, b""),
        ],
        "movie",
    )
    .await;
    let first = page_files::playlist(&app, "3", LIBRARY, 2, None)
        .await
        .unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["5", "4"]
    );
    assert_eq!(first.total, 3);
    let last = page_files::playlist(&app, "3", LIBRARY, 2, first.next_cursor.as_deref())
        .await
        .unwrap();
    assert_eq!(last.items[0].id, "3");
    assert!(last.next_cursor.is_none());
    assert_eq!(
        page_files::neighbor(&app, "4", LIBRARY, 1)
            .await
            .unwrap()
            .unwrap()
            .id,
        "3"
    );
    assert_eq!(
        page_files::neighbor(&app, "4", LIBRARY, -1)
            .await
            .unwrap()
            .unwrap()
            .id,
        "5"
    );
    let directory = page_files::directory(&app, "/影视", LIBRARY, 200, None)
        .await
        .unwrap();
    assert_eq!(directory.items.len(), 4);
    assert!(!directory.items.iter().any(|node| node.id == "6"));
    assert!(
        page_files::playlist(&app, "3", LIBRARY, 1, first.next_cursor.as_deref())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn playlists_beyond_ten_thousand_are_not_truncated_and_cursors_invalidate_after_change() {
    let mut nodes = vec![root()];
    for index in 1..=10_205 {
        nodes.push(seed(
            &(index + 2).to_string(),
            "2",
            &format!("第{index}集.mp4"),
            NodeKind::File,
            b"v",
        ));
    }
    let (app, host) = indexed(nodes, "movie").await;
    let mut cursor = None;
    let mut count = 0;
    loop {
        let page = page_files::playlist(&app, "3", LIBRARY, 200, cursor.as_deref())
            .await
            .unwrap();
        count += page.items.len();
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(count, 10_205);
    let first = page_files::playlist(&app, "3", LIBRARY, 200, None)
        .await
        .unwrap();
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    assert!(
        page_files::playlist(&app, "3", LIBRARY, 200, first.next_cursor.as_deref())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn playlist_roots_follow_identity_and_reject_other_authorized_libraries() {
    let (app, host) = indexed(
        vec![
            root(),
            seed("3", "2", "视频.mp4", NodeKind::File, b"v"),
            seed("4", "1", "库外", NodeKind::Directory, b""),
        ],
        "movie",
    )
    .await;
    assert!(
        page_files::directory(&app, "/库外", LIBRARY, 48, None)
            .await
            .is_err()
    );
    host.change_node("2".into(), None, Some("改名库".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    assert_eq!(
        page_files::directory(&app, "/改名库", LIBRARY, 48, None)
            .await
            .unwrap()
            .items[0]
            .id,
        "3"
    );
    host.change_node("3".into(), Some("4".into()), None, None, None)
        .unwrap();
    assert!(
        page_files::playlist(&app, "3", LIBRARY, 100, None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn owner_and_fntv_share_watched_flags_including_season_inheritance() {
    let (app, _, token) = configured(
        vec![
            root(),
            seed("3", "2", "剧.S01E01.mp4", NodeKind::File, b"v"),
        ],
        "tv",
    )
    .await;
    let e = app.db.entry("3").unwrap().unwrap();
    wire(
        &app,
        false,
        "POST",
        "/v/api/v1/item/watched",
        Some(&token),
        json!({"item_guid":e.season_guid()}),
        &[],
    )
    .await;
    let (status, flag) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/flags/get",
            None,
            json!({"id":"3"}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(flag["watched"], true);
    let (status, _) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/flags/watched",
            None,
            json!({"id":"3","watched":false,"revision":flag["revision"]}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    let (_, detail) = body(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/item/{}", e.guid),
            Some(&token),
            Value::Null,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(detail["data"]["is_watched"], 0);
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/flags/watched",
            None,
            json!({"id":"3","watched":true,"revision":null}),
            &[]
        )
        .await
        .status(),
        409
    );
}

#[tokio::test]
async fn clear_history_is_atomic_includes_hidden_records_and_revokes_old_progress_authority() {
    let (app, _, _) = configured(
        vec![root(), seed("3", "2", "视频.mp4", NodeKind::File, b"v")],
        "movie",
    )
    .await;
    let (_, started) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/play/start",
            None,
            json!({"id":"3"}),
            &[],
        )
        .await,
    )
    .await;
    let value = json!({"key":"progress:3","play_id":started["play_id"],"value":{"seconds":50,"completed":false}});
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/storage/set",
            None,
            value.clone(),
            &[]
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/history/clear",
            None,
            json!({}),
            &[]
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        wire(&app, true, "POST", "/owner/storage/set", None, value, &[])
            .await
            .status(),
        409
    );
    let (_, record) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/storage/get",
            None,
            json!({"key":"progress:3"}),
            &[],
        )
        .await,
    )
    .await;
    assert!(record.is_null());
}

#[tokio::test]
async fn indexing_does_not_queue_byte_requests_or_owner_shutdown_behind_a_full_scan() {
    let (app, _, token) = configured(
        vec![root(), seed("3", "2", "视频.mp4", NodeKind::File, b"v")],
        "movie",
    )
    .await;
    let _scan = app.index_lock.lock().await;
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/catalog",
            None,
            json!({"raw_files":true,"limit":48}),
            &[]
        )
        .await
        .status(),
        429
    );
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/play/quit",
            None,
            json!({"play_id":"unknown"}),
            &[]
        )
        .await
        .status(),
        200
    );
    let e = app.db.entry("3").unwrap().unwrap();
    assert_eq!(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/media/range/{}", e.media_guid),
            Some(&token),
            Value::Null,
            &[]
        )
        .await
        .status(),
        204
    );
}
