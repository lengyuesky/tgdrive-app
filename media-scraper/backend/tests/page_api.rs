mod common;
use common::fault_host::SpyHost;
use common::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tgdrive_contract::{
    files::*,
    runtime::{ForwardCaller, ForwardContext, ForwardEntry},
};
use tgdrive_media_scraper::model::{StartRequest, random_id};
fn context(owner: bool) -> ForwardContext {
    ForwardContext {
        contract: tgdrive_contract::CONTRACT_VERSION,
        app_id: "media-scraper".into(),
        caller: if owner {
            ForwardCaller::Owner
        } else {
            ForwardCaller::External
        },
        entry: if owner {
            ForwardEntry::Page
        } else {
            ForwardEntry::Prefix
        },
        request_id: "synthetic-request".into(),
        original_uri: "/synthetic".into(),
        public_origin: "https://synthetic.invalid".into(),
        public_base_url: "https://synthetic.invalid/admin/api/apps/v1/self/backend".into(),
        client_ip: None,
    }
}
async fn api(app: &Arc<tgdrive_media_scraper::Application>, path: &str, value: Value) -> Value {
    body(
        app.handle(context(true), "POST".parse().unwrap(), path.into(), value)
            .await
            .unwrap(),
    )
    .await
}
#[tokio::test]
async fn owner_routes_do_not_accept_external_context_or_wrong_app_identity() {
    let fake = Fake::normal().await;
    let (app, _) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    assert_eq!(
        app.handle(
            context(false),
            "POST".parse().unwrap(),
            "/owner/runs".into(),
            json!({"request_id":random_id(),"directory_id":"2","retry_of":null})
        )
        .await
        .err()
        .unwrap()
        .code(),
        "caller_not_allowed"
    );
    let mut other = context(true);
    other.app_id = "other".into();
    assert!(
        app.handle(
            other,
            "GET".parse().unwrap(),
            "/owner/settings".into(),
            json!({})
        )
        .await
        .is_err()
    );
    assert!(app.db.active_run().unwrap().is_none());
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn status_and_execution_details_never_return_token_or_full_write_request() {
    let fake = Fake::normal().await;
    let (app, _) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    let settings = app.db.settings().unwrap().view;
    app.configure(tgdrive_media_scraper::model::ConfigureRequest {
        revision: settings.revision,
        backend_url: fake.url.clone(),
        token: Some("synthetic-private-token".into()),
        overwrite_nfo: false,
        overwrite_poster: false,
    })
    .await
    .unwrap();
    let run = run(&app, None).await;
    let item = app.db.items(&run.id, -1, 100).unwrap().remove(0);
    let status = body(app.status().unwrap()).await;
    assert_eq!(status["settings"]["token_configured"], true);
    assert!(status["active"].is_null());
    assert_eq!(status["latest"]["id"], run.id);
    let detail = api(
        &app,
        "/owner/detail",
        json!({"item_id":item.id,"after":null,"actor_after":null,"attempt_after":null,"limit":100}),
    )
    .await;
    let serialized = serde_json::to_string(&json!([status, detail])).unwrap();
    assert!(!serialized.contains("synthetic-private-token"));
    assert!(!serialized.contains("create_request"));
    assert!(!serialized.contains("mutation_request"));
    app.shutdown().await;
}
#[tokio::test]
async fn history_keeps_every_run_created_in_the_same_millisecond_with_keyset_cursors() {
    let fake = Fake::normal().await;
    let (app, _) = configured(vec![root(), video("3", "没有番号.mp4")], &fake).await;
    for _ in 0..5 {
        run(&app, None).await;
    }
    app.db
        .with(|db| {
            db.execute("UPDATE runs SET created_at=42", []).unwrap();
            Ok(())
        })
        .unwrap();
    let mut cursor = Value::Null;
    let mut ids = std::collections::HashSet::new();
    loop {
        let response = api(&app, "/owner/history", json!({"cursor":cursor,"limit":1})).await;
        for row in response["records"].as_array().unwrap() {
            assert!(ids.insert(row["id"].as_str().unwrap().to_owned()));
        }
        cursor = response["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(ids.len(), 5);
    app.shutdown().await;
}
#[tokio::test]
async fn source_attempts_have_an_independent_cursor_and_preserve_all_long_failures() {
    let fake = Fake::normal().await;
    let (app, _) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    let run = run(&app, None).await;
    let item = app.db.items(&run.id, -1, 100).unwrap().remove(0);
    for i in 0..100 {
        app.db
            .attempt(
                &item.id,
                "detail",
                &format!("Provider{i}"),
                &"完整来源失败原因。".repeat(1000),
            )
            .unwrap();
    }
    let mut cursor = Value::Null;
    let mut count = 0;
    loop {
        let detail=api(&app,"/owner/detail",json!({"item_id":item.id,"after":100000,"actor_after":null,"attempt_after":cursor,"limit":10})).await;
        let attempts = detail["attempts"].as_array().unwrap();
        for row in attempts {
            assert_eq!(
                row["reason"].as_str().unwrap(),
                "完整来源失败原因。".repeat(1000)
            );
        }
        count += attempts.len();
        cursor = detail["next_attempt"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(count, 100);
    app.shutdown().await;
}
#[tokio::test]
async fn malformed_nested_cursors_and_page_limits_are_rejected_not_interpreted_as_positions() {
    let fake = Fake::normal().await;
    let (app, _) = configured(vec![root()], &fake).await;
    for value in [
        json!({"cursor":[42,"id"],"limit":1}),
        json!({"cursor":null,"limit":0}),
        json!({"cursor":null,"limit":101}),
    ] {
        assert!(
            app.handle(
                context(true),
                "POST".parse().unwrap(),
                "/owner/history".into(),
                value
            )
            .await
            .is_err()
        );
    }
    app.shutdown().await;
}
#[tokio::test]
async fn long_unicode_paths_make_short_pages_without_truncating_the_scanned_or_recorded_files() {
    let fake = Fake::normal().await;
    let mut nodes = vec![root()];
    let mut parent = "2".to_owned();
    for i in 0..15 {
        let id = (10000 + i).to_string();
        nodes.push(seed(
            &id,
            &parent,
            &format!("{}层{i}", "\"".repeat(240)),
            NodeKind::Directory,
            b"",
        ));
        parent = id;
    }
    for i in 0..201 {
        nodes.push(seed(
            &(20000 + i).to_string(),
            &parent,
            &format!("没有番号{i}.mp4"),
            NodeKind::File,
            b"video",
        ));
    }
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let run = run(&app, None).await;
    assert_eq!(run.counts.total, 201);
    assert!(spy.queries.load(Ordering::SeqCst) > 1);
    let first = api(
        &app,
        "/owner/items",
        json!({"run_id":run.id,"after":null,"limit":100}),
    )
    .await;
    assert!(first["items"].as_array().unwrap().len() < 100);
    assert!(!first["next_after"].is_null());
    let mut response = first;
    let mut ids = std::collections::HashSet::new();
    loop {
        for item in response["items"].as_array().unwrap() {
            assert!(ids.insert(item["files"][0]["id"].as_str().unwrap().to_owned()));
        }
        if response["next_after"].is_null() {
            break;
        }
        response = api(
            &app,
            "/owner/items",
            json!({"run_id":run.id,"after":response["next_after"],"limit":100}),
        )
        .await;
    }
    assert_eq!(ids.len(), 201);
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn more_than_ten_thousand_videos_are_not_limited_to_the_first_legacy_page() {
    let fake = Fake::normal().await;
    let mut nodes = vec![root()];
    for id in 3..10004 {
        nodes.push(video(&id.to_string(), &format!("没有番号{id}.mp4")));
    }
    let spy = Arc::new(SpyHost::new(memory(nodes)));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let run = run(&app, None).await;
    assert_eq!(run.counts.total, 10001);
    assert_eq!(run.counts.skipped, 10001);
    assert!(spy.queries.load(Ordering::SeqCst) > 20);
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn weak_scan_upserts_before_the_first_snapshot_and_scope_changes_stop_before_mutation() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "没有番号.mp4"),
    ])));
    let once = AtomicBool::new(false);
    *spy.before_query.lock().unwrap() = Some(Arc::new(move |_, host| {
        if !once.swap(true, Ordering::SeqCst) {
            host.add_node(video("4", "ABC-123.mp4")).unwrap();
        }
    }));
    let app = application(
        spy,
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let run = run(&app, None).await;
    assert_eq!(run.counts.total, 2);
    assert_eq!(run.counts.done, 1);
    app.shutdown().await;
}
#[tokio::test]
async fn read_only_scope_is_rejected_before_any_source_call_or_file_write() {
    let fake = Fake::normal().await;
    let memory = memory(vec![root(), video("3", "ABC-123.mp4")]);
    memory
        .set_scope(DirectoryScope::All {
            access: AccessLevel::ReadOnly,
        })
        .unwrap();
    let app = application(
        Arc::new(memory),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    assert_eq!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None
        })
        .await
        .unwrap_err()
        .code(),
        "scope_denied"
    );
    assert_eq!(fake.count("/v1/"), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn retry_after_seven_day_host_receipt_expiry_verifies_current_bytes_and_keeps_nfo() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    *spy.fail_after.lock().unwrap() = Some(first_commit());
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let first = run(&app, None).await;
    let original = node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await;
    spy.memory.advance(8 * 86400 * 1000).unwrap();
    let second = run(&app, Some(first.id)).await;
    assert_eq!(second.counts.done, 1);
    assert_eq!(
        node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo")
            .await
            .content_version,
        original.content_version
    );
    app.shutdown().await;
}
#[tokio::test]
async fn retry_reuses_confirmed_actor_images_instead_of_generating_duplicate_portraits() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    *spy.fail_after.lock().unwrap() = Some(first_commit());
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let first = run(&app, None).await;
    assert_eq!(first.state, "interrupted");
    let old_item = app.db.items(&first.id, -1, 100).unwrap().remove(0);
    let old = app
        .db
        .steps(&old_item.id)
        .unwrap()
        .into_iter()
        .find(|s| s.role == "actor_0")
        .unwrap()
        .name;
    let second = run(&app, Some(first.id)).await;
    assert_eq!(second.counts.done, 1);
    let item = app.db.items(&second.id, -1, 100).unwrap().remove(0);
    assert_eq!(item.actors[0].data.thumb, old);
    assert_eq!(fake.count("/v1/actors/search"), 1);
    assert_eq!(fake.count("/v1/images/primary/Actors/"), 1);
    app.shutdown().await;
}
