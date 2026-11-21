//! 旧飞牛协议、播放权威和生命周期回归，改由应用后端与内存宿主替身执行。
mod common;
use common::*;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tgdrive_backend_sdk::{
    HostClient, ReadOptions,
    http::{HeaderMap, Method},
};
use tgdrive_cinema::catalog::{self, Query};
use tgdrive_contract::{events::event_name, files::*, runtime::ForwardEntry};

async fn fixture(
    bytes: &[u8],
) -> (
    std::sync::Arc<tgdrive_cinema::Application>,
    tgdrive_test_host::MemoryHost,
    String,
) {
    configured(
        vec![
            root(),
            seed("3", "2", "隔离.mp4", NodeKind::File, bytes),
            seed("4", "1", "库外", NodeKind::Directory, b""),
        ],
        "movie",
    )
    .await
}
#[tokio::test]
async fn installation_service_secret_and_owner_external_boundaries() {
    let (app, _) = memory(vec![
        root(),
        seed("3", "2", "片.mp4", NodeKind::File, b"video"),
    ]);
    let app = std::sync::Arc::new(app);
    assert_eq!(
        wire(&app, false, "GET", "/trimcon", None, Value::Null, &[])
            .await
            .status(),
        401
    );
    assert!(
        app.start_service(&app.db.settings().unwrap().revision)
            .await
            .is_err()
    );
    let (app, _, token) = fixture(b"video").await;
    let (status, config) =
        body(wire(&app, true, "GET", "/owner/config", None, Value::Null, &[]).await).await;
    assert_eq!(status, 200);
    assert!(config.get("verifier").is_none());
    assert!(config.get("password").is_none());
    assert_eq!(
        wire(
            &app,
            false,
            "GET",
            "/owner/config",
            Some(&token),
            Value::Null,
            &[]
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        wire(
            &app,
            false,
            "GET",
            "/v/api/v1/user/info",
            None,
            Value::Null,
            &[("Authx", "unproven-signature")]
        )
        .await
        .status(),
        401
    );
    let mut context = context(false);
    context.entry = ForwardEntry::Page;
    assert!(
        app.clone()
            .handle(
                context,
                Method::GET,
                "/owner/config".into(),
                HeaderMap::new(),
                Value::Null
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn native_library_details_require_current_authorization() {
    let (app, host, token) = fixture(b"video").await;
    for prefix in ["/v/api/v1/mdb/", "/v/api/v1/item/"] {
        let (status, value) = body(
            wire(
                &app,
                false,
                "GET",
                &format!("{prefix}{LIBRARY}"),
                Some(&token),
                Value::Null,
                &[],
            )
            .await,
        )
        .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["data"]["guid"], LIBRARY);
        assert_eq!(
            wire(
                &app,
                false,
                "GET",
                &format!("{prefix}{LIBRARY}"),
                None,
                Value::Null,
                &[]
            )
            .await
            .status(),
            401
        );
    }
    host.set_scope(DirectoryScope::Selected {
        directories: vec![DirectoryGrant {
            directory_id: "4".into(),
            access: AccessLevel::ReadOnly,
        }],
    })
    .unwrap();
    assert_eq!(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/mdb/{LIBRARY}"),
            Some(&token),
            Value::Null,
            &[]
        )
        .await
        .status(),
        401
    );
    assert!(app.service.authenticate(&token).is_err());
}
#[tokio::test]
async fn original_ranges_head_304_if_range_and_no_backend_byte_copy() {
    let (app, host, token) = fixture(b"0123456789").await;
    let e = app.db.entry("3").unwrap().unwrap();
    let path = format!("/v/api/v1/media/range/{}", e.media_guid);
    let response = wire(
        &app,
        false,
        "GET",
        &path,
        Some(&token),
        Value::Null,
        &[("Range", "bytes=2-6")],
    )
    .await;
    assert_eq!(response.status(), 204);
    let control = directive(&response);
    assert!(control.lease_id.is_some());
    assert!(control.correlation_id.is_some());
    assert_eq!(control.content_type.as_deref(), Some("video/mp4"));
    assert!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    let bytes = host
        .direct_stream(
            Method::GET,
            control.clone(),
            ReadOptions {
                range: Some("bytes=2-6".into()),
                ..Default::default()
            },
            "range".into(),
        )
        .unwrap();
    assert_eq!(bytes.headers["Content-Range"], "bytes 2-6/10");
    let etag = bytes.headers["ETag"].to_str().unwrap().to_owned();
    assert_eq!(
        tgdrive_backend_sdk::collect_bytes(bytes.body, 100)
            .await
            .unwrap()
            .as_ref(),
        b"23456"
    );
    let mut head = host
        .direct_stream(
            Method::HEAD,
            control.clone(),
            ReadOptions {
                range: Some("bytes=-3".into()),
                ..Default::default()
            },
            "head".into(),
        )
        .unwrap();
    assert_eq!(head.headers["Content-Length"], "3");
    assert!(head.body.next().await.is_none());
    assert!(
        host.direct_stream(
            Method::GET,
            control.clone(),
            ReadOptions {
                range: Some("bytes=10-".into()),
                ..Default::default()
            },
            "bad".into()
        )
        .is_err()
    );
    let cached = host
        .direct_stream(
            Method::GET,
            control.clone(),
            ReadOptions {
                if_none_match: Some(etag),
                ..Default::default()
            },
            "304".into(),
        )
        .unwrap();
    assert_eq!(cached.status, 304);
    let fallback = host
        .direct_stream(
            Method::GET,
            control,
            ReadOptions {
                range: Some("bytes=1-2".into()),
                if_range: Some("different".into()),
                ..Default::default()
            },
            "if-range".into(),
        )
        .unwrap();
    assert_eq!(fallback.status, 200);
    assert_eq!(
        tgdrive_backend_sdk::collect_bytes(fallback.body, 100)
            .await
            .unwrap()
            .as_ref(),
        b"0123456789"
    );
}
#[tokio::test]
async fn only_stream_started_grants_authority_new_play_wins_and_active_can_rewind() {
    let (app, host, a) = fixture(b"0123456789").await;
    let b = login(&app).await;
    let e = app.db.entry("3").unwrap().unwrap();
    let _ = wire(
        &app,
        false,
        "POST",
        "/v/api/v1/play/info",
        Some(&a),
        json!({"item_guid":e.guid}),
        &[],
    )
    .await;
    assert_eq!(record(&app, &a, "3", "pre-read", 99.0).await, 200);
    assert_eq!(app.db.progress(&e).unwrap().ts, 0.0);
    start(&app, &host, &a, "3").await;
    assert_eq!(record(&app, &a, "3", "play-a", 207.75).await, 200);
    assert_eq!(app.db.progress(&e).unwrap().ts, 207.75);
    let (status, info) = body(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/play/info",
            Some(&b),
            json!({"item_guid":e.guid}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(info["data"]["ts"].as_u64(), Some(207));
    record(&app, &a, "3", "play-a", 180.0).await;
    assert_eq!(app.db.progress(&e).unwrap().ts, 180.0);
    host.advance(1000).unwrap();
    start(&app, &host, &b, "3").await;
    record(&app, &b, "3", "play-b", 40.0).await;
    record(&app, &a, "3", "play-a", 250.0).await;
    assert_eq!(app.db.progress(&e).unwrap().ts, 40.0);
    record(&app, &b, "3", "play-b", 10.0).await;
    assert_eq!(app.db.progress(&e).unwrap().ts, 10.0);
    wire(
        &app,
        false,
        "POST",
        "/v/api/v1/play/quit",
        Some(&b),
        json!({"play_link":"play-b"}),
        &[],
    )
    .await;
    record(&app, &b, "3", "play-b", 80.0).await;
    assert_eq!(app.db.progress(&e).unwrap().ts, 10.0);
}
#[tokio::test]
async fn head_or_304_do_not_count_as_start_and_logout_wins_prebyte_race() {
    let (app, host, token) = fixture(b"0123456789").await;
    let e = app.db.entry("3").unwrap().unwrap();
    let response = wire(
        &app,
        false,
        "HEAD",
        &format!("/v/api/v1/media/range/{}", e.media_guid),
        Some(&token),
        Value::Null,
        &[],
    )
    .await;
    let control = directive(&response);
    let cursor = host.events_snapshot(None).unwrap()[0].cursor.clone();
    let mut head = host
        .direct_stream(
            Method::HEAD,
            control.clone(),
            ReadOptions::default(),
            "head".into(),
        )
        .unwrap();
    assert!(head.body.next().await.is_none());
    assert!(
        host.events_snapshot(Some(cursor))
            .unwrap()
            .iter()
            .all(|e| e.event != event_name::STREAM_STARTED)
    );
    record(&app, &token, "3", "only-head", 42.0).await;
    assert_eq!(app.db.progress(&e).unwrap().ts, 0.0);
    assert_eq!(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/user/logout",
            Some(&token),
            json!({}),
            &[]
        )
        .await
        .status(),
        200
    );
    assert!(
        host.direct_stream(Method::GET, control, ReadOptions::default(), "late".into())
            .is_err()
    );
}
#[tokio::test]
async fn dates_are_milliseconds_progress_is_seconds_and_invalid_tracks_fail() {
    let (app, host, token) = fixture(b"video").await;
    host.advance(60_000).unwrap();
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    let e = app.db.entry("3").unwrap().unwrap();
    let (_, info) = body(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/stream/list/{}", e.media_guid),
            Some(&token),
            Value::Null,
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(info["data"]["files"][0]["timestamp"], e.timestamp);
    assert_eq!(info["data"]["files"][0]["create_time"], e.added_at);
    assert!(e.timestamp > e.added_at);
    assert_eq!(info["data"]["video_streams"][0]["duration"], 300);
    start(&app, &host, &token, "3").await;
    for invalid in [-1.0, 302.001, 207000.0] {
        assert_eq!(record(&app, &token, "3", "play", invalid).await, 400);
    }
    assert_eq!(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/stream",
            Some(&token),
            json!({"item_guid":e.guid,"audio_guid":"invented"}),
            &[]
        )
        .await
        .status(),
        400
    );
}
#[tokio::test]
async fn stop_account_scope_and_host_lifecycle_revoke_inflight_leases() {
    for operation in [
        "logout",
        "stop",
        "account",
        "scope",
        "disable",
        "restart",
        "reinstall",
    ] {
        let (app, host, token) = fixture(&vec![7; 200_000]).await;
        let e = app.db.entry("3").unwrap().unwrap();
        let control = directive(
            &wire(
                &app,
                false,
                "GET",
                &format!("/v/api/v1/media/range/{}", e.media_guid),
                Some(&token),
                Value::Null,
                &[],
            )
            .await,
        );
        let mut response = host
            .direct_stream(
                Method::GET,
                control,
                ReadOptions::default(),
                "inflight".into(),
            )
            .unwrap();
        assert_eq!(response.body.next().await.unwrap().unwrap().len(), 65536);
        match operation {
            "logout" => {
                wire(
                    &app,
                    false,
                    "POST",
                    "/v/api/v1/user/logout",
                    Some(&token),
                    json!({}),
                    &[],
                )
                .await;
            }
            "stop" => app
                .stop_service(&app.db.settings().unwrap().revision)
                .await
                .unwrap(),
            "account" => app
                .configure_account(
                    &app.db.settings().unwrap().revision,
                    "synthetic",
                    "New-Synthetic-Only",
                )
                .await
                .unwrap(),
            "scope" => {
                host.set_scope(DirectoryScope::None).unwrap();
            }
            "disable" => host.set_enabled(false).unwrap(),
            "restart" => host.restart().unwrap(),
            "reinstall" => host.reinstall().unwrap(),
            _ => unreachable!(),
        }
        assert!(response.body.next().await.unwrap().is_err(), "{operation}");
        assert_eq!(
            host.fork(tgdrive_contract::runtime::RuntimeCaller::Backend)
                .stat(NodeReference::Id {
                    id: "3".into(),
                    content_version: None
                })
                .await
                .is_ok(),
            !matches!(operation, "scope" | "disable")
        );
    }
}
#[tokio::test]
async fn title_added_date_sort_filter_favorite_and_keyset_page_are_stable() {
    let (app, host, token) = fixture(b"first").await;
    host.advance(1000).unwrap();
    host.add_node(seed("5", "2", "B 最新.mp4", NodeKind::File, b"second"))
        .unwrap();
    host.advance(1000).unwrap();
    host.add_node(seed("6", "2", "A 中间.mp4", NodeKind::File, b"third"))
        .unwrap();
    app.synchronize(false).await.unwrap();
    let descending = list(
        &app,
        &token,
        json!({"sort_column":"create_time","sort_type":"DESC","page_size":1}),
    )
    .await;
    assert_eq!(descending["total"], 3);
    assert_eq!(descending["list"][0]["title"], "A 中间");
    let second = list(
        &app,
        &token,
        json!({"sort_column":"create_time","sort_type":"DESC","page":2,"page_size":1}),
    )
    .await;
    assert_eq!(second["list"][0]["title"], "B 最新");
    let title = list(
        &app,
        &token,
        json!({"sort_column":"sort_title","sort_type":"DESC"}),
    )
    .await;
    assert_eq!(title["list"][0]["title"], "隔离");
    let e = app.db.entry("5").unwrap().unwrap();
    wire(
        &app,
        false,
        "PUT",
        "/v/api/v1/item/favorite",
        Some(&token),
        json!({"item_guid":e.guid}),
        &[],
    )
    .await;
    let (status, favorites) = body(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/favorite/list",
            Some(&token),
            json!({"q":"最新"}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(favorites["data"]["total"], 1);
    let query = Query {
        limit: 1,
        raw_files: true,
        sort_column: "create_time".into(),
        descending: true,
        ..Default::default()
    };
    let first = catalog::list(&app, &query, 0).unwrap();
    let second = catalog::list(
        &app,
        &Query {
            cursor: first.next_cursor,
            ..query
        },
        0,
    )
    .unwrap();
    assert_ne!(first.ids, second.ids);
}
#[tokio::test]
async fn tv_groups_resolve_first_episode_and_keep_manual_flags_independent() {
    let (app, _, token) = configured(
        vec![
            root(),
            seed("3", "2", "SeasonedAlpha", NodeKind::Directory, b""),
            seed("4", "3", "Season01", NodeKind::Directory, b""),
            seed("5", "4", "S01E02.mkv", NodeKind::File, b"second"),
            seed("6", "4", "S01E01.mkv", NodeKind::File, b"first"),
            seed("7", "4", "含糊.mkv", NodeKind::File, b"unknown"),
        ],
        "tv",
    )
    .await;
    let rows = list(&app, &token, json!({"tags":{"type":["TV"]}})).await;
    assert_eq!(rows["total"], 2);
    let e = app.db.entry("6").unwrap().unwrap();
    let group = e.show_guid.clone();
    for reference in [&group, &e.season_guid()] {
        let (status, value) = body(
            wire(
                &app,
                false,
                "POST",
                "/v/api/v1/play/info",
                Some(&token),
                json!({"item_guid":reference}),
                &[],
            )
            .await,
        )
        .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["data"]["guid"], e.guid);
        assert_eq!(value["data"]["type"], "Episode");
    }
    assert_eq!(
        wire(
            &app,
            false,
            "GET",
            &format!("/v/api/v1/media/range/{group}"),
            Some(&token),
            Value::Null,
            &[]
        )
        .await
        .status(),
        404
    );
    wire(
        &app,
        false,
        "PUT",
        "/v/api/v1/item/favorite",
        Some(&token),
        json!({"item_guid":group}),
        &[],
    )
    .await;
    assert!(!app.db.flags(&e.guid).unwrap().0);
    wire(
        &app,
        false,
        "POST",
        "/v/api/v1/item/watched",
        Some(&token),
        json!({"item_guid":group}),
        &[],
    )
    .await;
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
    assert_eq!(detail["data"]["is_watched"], 1);
}
#[tokio::test]
async fn page_and_fntv_share_progress_favorites_and_late_page_is_rejected() {
    let (app, host, token) = fixture(b"video").await;
    // 替身时钟在夹具初始化时固定；明确覆盖初始化耗时导致它落后页面真实时钟的场景。
    host.advance(-60_000).unwrap();
    let (status, started) = body(
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
    assert_eq!(status, 200);
    let play_id = started["play_id"].as_str().unwrap();
    let(status,saved)=body(wire(&app,true,"POST","/owner/storage/set",None,json!({"key":"progress:3","revision":null,"play_id":play_id,"value":{"seconds":50.75,"duration":300,"completed":false}}),&[]).await).await;
    assert_eq!(status, 200, "{saved}");
    let e = app.db.entry("3").unwrap().unwrap();
    let (_, info) = body(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/play/info",
            Some(&token),
            json!({"item_guid":e.guid}),
            &[],
        )
        .await,
    )
    .await;
    assert_eq!(info["data"]["ts"], 50);
    let host_now = host
        .events_snapshot(None)
        .unwrap()
        .last()
        .unwrap()
        .occurred_at
        .0;
    host.advance(tgdrive_cinema::model::now() + 1000 - host_now)
        .unwrap();
    start(&app, &host, &token, "3").await;
    assert_eq!(record(&app, &token, "3", "external", 20.0).await, 200);
    assert_eq!(app.db.progress(&e).unwrap().ts, 20.0);
    assert_eq!(
        wire(
            &app,
            true,
            "POST",
            "/owner/storage/set",
            None,
            json!({"key":"progress:3","play_id":play_id,"value":{"seconds":80,"completed":false}}),
            &[]
        )
        .await
        .status(),
        409
    );
    assert_eq!(app.db.progress(&e).unwrap().ts, 20.0);
    wire(
        &app,
        false,
        "PUT",
        "/v/api/v1/item/favorite",
        Some(&token),
        json!({"item_guid":e.guid}),
        &[],
    )
    .await;
    let (_, favorite) = body(
        wire(
            &app,
            true,
            "POST",
            "/owner/storage/get",
            None,
            json!({"key":"favorite:3"}),
            &[],
        )
        .await,
    )
    .await;
    assert!(!favorite.is_null());
}
#[tokio::test]
async fn unproven_authx_prefix_cookie_and_explicit_login_budget_stay_closed() {
    let (app, _, token) = fixture(b"video").await;
    let mut context = context(false);
    context.entry = ForwardEntry::Prefix;
    let mut headers = HeaderMap::new();
    headers.insert("Cookie", format!("Trim-MC-token={token}").parse().unwrap());
    let response = app
        .clone()
        .handle(
            context,
            Method::GET,
            "/v/api/v1/user/info".into(),
            headers,
            Value::Null,
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    for _ in 0..19 {
        app.service.login_budget().unwrap();
    }
    assert!(app.service.login_budget().is_err());
}
