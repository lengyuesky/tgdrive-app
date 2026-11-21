mod common;
use common::fault_host::SpyHost;
use common::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tgdrive_backend_sdk::HostClient;
use tgdrive_contract::{files::*, runtime::RuntimeCaller};
use tgdrive_media_scraper::{
    model::{StartRequest, random_id},
    writes,
};

#[tokio::test]
async fn only_one_background_task_and_configuration_are_allowed_and_closing_page_does_not_stop_it()
{
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
    let memory = memory(vec![root(), video("3", "ABC-123.mp4")]);
    let page = memory.fork(RuntimeCaller::Page);
    let spy = Arc::new(SpyHost::new(memory));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let input = StartRequest {
        request_id: random_id(),
        directory_id: "2".into(),
        retry_of: None,
    };
    let result = app.start(input.clone()).await.unwrap();
    assert_eq!(app.start(input).await.unwrap().id, result.id);
    assert!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None
        })
        .await
        .is_err()
    );
    let settings = app.db.settings().unwrap().view;
    assert!(
        app.configure(tgdrive_media_scraper::model::ConfigureRequest {
            revision: settings.revision,
            backend_url: fake.url.clone(),
            token: None,
            overwrite_nfo: true,
            overwrite_poster: false
        })
        .await
        .is_err()
    );
    page.close_page_session().unwrap();
    assert!(app.db.active_run().unwrap().is_some());
    gate.notify_one();
    app.wait_idle().await;
    assert_eq!(app.db.run(&result.id).unwrap().counts.done, 1);
    assert!(spy.keepalives.load(Ordering::SeqCst) >= 1);
    app.shutdown().await;
}
#[tokio::test]
async fn stopping_a_source_request_cancels_it_without_trying_later_sources() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let wait = gate.clone();
    let fake=Fake::new(move |uri| {
        if uri.starts_with("/v1/movies/search") { Reply::json(200,json!({"data":[{"provider":"First","id":"ABC-123","number":"ABC-123"},{"provider":"Second","id":"ABC-123","number":"ABC-123"}]})) }
        else { let mut reply=standard(uri,&[]); if uri.starts_with("/v1/movies/First/") { reply.gate=Some(wait.clone()); } reply }
    }).await;
    let (app, host) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    let job = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    for _ in 0..1000 {
        if fake.count("/v1/movies/First/") > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    app.stop(&job.id).await.unwrap();
    app.wait_idle().await;
    assert_eq!(fake.count("/v1/movies/Second/"), 0);
    assert_eq!(app.db.run(&job.id).unwrap().state, "cancelled");
    assert_eq!(node(&host, "/影片/ABC-123.mp4").await.id, "3");
    app.shutdown().await;
}
#[tokio::test]
async fn stop_waits_for_inflight_commit_receipt_and_does_not_begin_the_next_step() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *spy.block_mutation.lock().unwrap() = Some((first_commit(), entered.clone(), release.clone()));
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let job = app
        .start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None,
        })
        .await
        .unwrap();
    entered.notified().await;
    assert_eq!(app.stop(&job.id).await.unwrap().state, "stopping");
    assert!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None
        })
        .await
        .is_err()
    );
    release.notify_one();
    app.wait_idle().await;
    assert_eq!(app.db.run(&job.id).unwrap().state, "cancelled");
    let item = app.db.items(&job.id, -1, 100).unwrap().remove(0);
    let steps = app.db.steps(&item.id).unwrap();
    assert!(
        steps
            .iter()
            .any(|s| s.role == "nfo" && s.state == "done" && s.receipt.is_some())
    );
    assert!(!steps.iter().any(|s| s.role == "poster"));
    app.shutdown().await;
}
#[tokio::test]
async fn lost_committed_reply_is_confirmed_by_receipt_not_replayed() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
    ])));
    *spy.fail_after.lock().unwrap() = Some(first_commit());
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let result = run(&app, None).await;
    assert_eq!(result.counts.done, 1);
    let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
    let nfo = app
        .db
        .steps(&item.id)
        .unwrap()
        .into_iter()
        .find(|s| s.role == "nfo")
        .unwrap();
    assert!(nfo.receipt.is_some());
    assert_eq!(
        spy.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.starts_with("upload:"))
            .count(),
        2
    );
    app.shutdown().await;
}
#[tokio::test]
async fn unknown_commit_stops_the_batch_and_retry_uses_upload_state_before_filling_missing_poster()
{
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
        video("4", "DEF-456.mp4"),
    ])));
    *spy.fail_after.lock().unwrap() = Some(first_commit());
    spy.hide_receipts.store(true, Ordering::SeqCst);
    let app = application(
        spy.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        "run-1",
    );
    configure(&app, &fake, true, true).await;
    let result = run(&app, None).await;
    assert_eq!(result.state, "interrupted");
    assert_eq!(node(spy.as_ref(), "/影片/DEF-456.mp4").await.id, "4");
    let nfo = node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await;
    let second = run(&app, Some(result.id.clone())).await;
    assert_eq!(second.counts.done, 2);
    assert_eq!(app.db.run_options(&second.id).unwrap(), (false, false));
    let same = node(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await;
    assert_eq!(same.id, nfo.id);
    assert_eq!(same.content_version, nfo.content_version);
    app.shutdown().await;
}
#[tokio::test]
async fn absence_of_receipt_is_not_failure_and_a_new_backend_round_fences_old_operations() {
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
    assert_eq!(original.state, "interrupted");
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mp4").await.id, "3");
    let attempts = spy
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.starts_with("mutate:"))
        .count();
    let retry = run(&app, Some(original.id.clone())).await;
    assert_eq!(retry.state, "interrupted");
    assert_eq!(
        spy.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.starts_with("mutate:"))
            .count(),
        attempts
    );
    assert_eq!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None
        })
        .await
        .unwrap_err()
        .code(),
        writes::NEEDS_VERIFICATION
    );
    app.shutdown().await;
    spy.memory.restart().unwrap();
    let restarted = Arc::new(SpyHost::new(spy.memory.fork(RuntimeCaller::Backend)));
    let next = application(
        restarted,
        rusqlite::Connection::open(&path).unwrap(),
        "run-2",
    );
    assert!(next.db.active_run().unwrap().is_none());
    assert_eq!(fake.count("/v1/movies/search"), 1);
    let result = run(&next, Some(original.id)).await;
    assert_eq!(result.counts.done, 1);
    next.shutdown().await;
}
#[tokio::test]
async fn backend_restart_marks_active_run_interrupted_and_never_resumes_automatically() {
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
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite3");
    let host = memory(vec![root(), video("3", "ABC-123.mp4")]);
    let app = application(
        Arc::new(host.clone()),
        rusqlite::Connection::open(&path).unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let job = app
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
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    app.shutdown().await;
    let count = fake.count("/v1/movies/search");
    host.restart().unwrap();
    let backend = host.fork(RuntimeCaller::Backend);
    let next = application(
        Arc::new(backend.clone()),
        rusqlite::Connection::open(&path).unwrap(),
        "run-2",
    );
    assert!(next.db.active_run().unwrap().is_none());
    assert!(matches!(
        next.db.run(&job.id).unwrap().state.as_str(),
        "interrupted" | "cancelled"
    ));
    assert_eq!(fake.count("/v1/movies/search"), count);
    assert_eq!(node(&backend, "/影片/ABC-123.mp4").await.id, "3");
    next.shutdown().await;
}
#[tokio::test]
async fn overwrite_uses_the_actual_uppercase_name_and_content_changes_win_the_commit_race() {
    let fake = Fake::normal().await;
    for changed in [false, true] {
        let spy = Arc::new(SpyHost::new(memory(vec![
            root(),
            seed("5", "2", "ABC-123", NodeKind::Directory, b""),
            seed("3", "5", "ABC-123.mp4", NodeKind::File, b"video"),
            seed(
                "4",
                "5",
                "ABC-123.NFO",
                NodeKind::File,
                b"<movie><num>ABC-123</num><title>old</title></movie>",
            ),
        ])));
        if changed {
            let once = AtomicBool::new(false);
            *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |request, host| {
                if request
                    .operations
                    .iter()
                    .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
                    && !once.swap(true, Ordering::SeqCst)
                {
                    host.change_node(
                        "4".into(),
                        None,
                        None,
                        Some(b"<movie><num>ABC-123</num><title>manual</title></movie>".to_vec()),
                        None,
                    )
                    .unwrap();
                }
                Ok(())
            }));
        }
        let app = application(
            spy.clone(),
            rusqlite::Connection::open_in_memory().unwrap(),
            "run-1",
        );
        configure(&app, &fake, true, false).await;
        let result = run(&app, None).await;
        assert_eq!(
            node(spy.as_ref(), "/影片/ABC-123/ABC-123.NFO").await.id,
            "4"
        );
        let xml =
            String::from_utf8(content(spy.as_ref(), "/影片/ABC-123/ABC-123.NFO").await).unwrap();
        if changed {
            assert_eq!(result.counts.skipped, 1);
            assert!(xml.contains("manual"));
        } else {
            assert_eq!(result.counts.done, 1);
            assert!(xml.contains("ABC-123 合成影片"));
        }
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
}
#[tokio::test]
async fn scope_revocation_before_move_stops_all_later_steps() {
    let fake = Fake::normal().await;
    let spy = Arc::new(SpyHost::new(memory(vec![
        root(),
        video("3", "ABC-123.mp4"),
        video("4", "DEF-456.mp4"),
    ])));
    let once = AtomicBool::new(false);
    *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |_, host| {
        if !once.swap(true, Ordering::SeqCst) {
            host.set_scope(DirectoryScope::None).unwrap();
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
    assert_eq!(result.state, "failed");
    assert_eq!(fake.count("/v1/movies/search?q=DEF-456"), 0);
    spy.memory
        .set_scope(DirectoryScope::All {
            access: AccessLevel::ReadWrite,
        })
        .unwrap();
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mp4").await.id, "3");
    app.shutdown().await;
}
#[tokio::test]
async fn actor_images_are_committed_before_nfo_references_and_rescrape_keeps_old_portraits() {
    let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
    let (app, host) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
    let first = run(&app, None).await;
    assert_eq!(first.counts.done, 1);
    let item = app.db.items(&first.id, -1, 100).unwrap().remove(0);
    assert_eq!(item.actors.len(), 1);
    assert!(!item.actors[0].data.thumb.is_empty());
    let old = item.actors[0].data.thumb.clone();
    assert!(item.actors_summary.contains("1/1"));
    let image = content(&host, &format!("/影片/ABC-123/{old}")).await;
    assert!(image.len() <= 128 * 1024);
    let xml = String::from_utf8(content(&host, "/影片/ABC-123/ABC-123.nfo").await).unwrap();
    assert!(xml.contains(&old));
    assert!(xml.contains("完整人物简介"));
    configure(&app, &fake, true, false).await;
    let second = run(&app, None).await;
    assert_eq!(second.counts.done, 1);
    let new = app.db.items(&second.id, -1, 100).unwrap().remove(0).actors[0]
        .data
        .thumb
        .clone();
    assert_ne!(old, new);
    assert_eq!(content(&host, &format!("/影片/ABC-123/{old}")).await, image);
    app.shutdown().await;
}
#[tokio::test]
async fn missing_or_failed_actor_image_preserves_name_and_finishes_movie_without_a_broken_reference()
 {
    for status in [404, 503] {
        let fake = Fake::new(move |uri| {
            if uri.starts_with("/v1/images/primary/Actors/") {
                Reply::json(status, json!({}))
            } else {
                standard(uri, &["演员甲"])
            }
        })
        .await;
        let (app, host) = configured(vec![root(), video("3", "ABC-123.mp4")], &fake).await;
        let result = run(&app, None).await;
        assert_eq!(result.counts.done, 1);
        let item = app.db.items(&result.id, -1, 100).unwrap().remove(0);
        assert_eq!(item.actors[0].data.name, "演员甲");
        assert!(item.actors[0].data.thumb.is_empty());
        let xml = String::from_utf8(content(&host, "/影片/ABC-123/ABC-123.nfo").await).unwrap();
        assert!(xml.contains("<name>演员甲</name>"));
        assert!(!xml.contains("<thumb>"));
        app.shutdown().await;
    }
}
#[tokio::test]
async fn rejected_actor_commit_is_optional_but_uncertain_actor_commit_stops_before_nfo() {
    for uncertain in [false, true] {
        let fake = Fake::new(|uri| standard(uri, &["演员甲"])).await;
        let spy = Arc::new(SpyHost::new(memory(vec![
            root(),
            video("3", "ABC-123.mp4"),
        ])));
        if uncertain {
            *spy.fail_before.lock().unwrap() = Some(first_commit());
            spy.hide_receipts.store(true, Ordering::SeqCst);
        } else {
            let once = AtomicBool::new(false);
            *spy.before_mutate.lock().unwrap() = Some(Arc::new(move |request, _| {
                if request
                    .operations
                    .iter()
                    .any(|op| matches!(op, FileOperation::CommitUpload { .. }))
                    && !once.swap(true, Ordering::SeqCst)
                {
                    return Err(tgdrive_backend_sdk::Error::api(
                        "quota_exceeded",
                        "合成头像上传拒绝",
                    ));
                }
                Ok(())
            }));
        }
        let app = application(
            spy.clone(),
            rusqlite::Connection::open_in_memory().unwrap(),
            "run-1",
        );
        configure(&app, &fake, false, false).await;
        let result = run(&app, None).await;
        if uncertain {
            assert_eq!(result.state, "interrupted");
            assert!(
                spy.stat(NodeReference::Path {
                    path: "/影片/ABC-123/ABC-123.nfo".into(),
                    content_version: None
                })
                .await
                .is_err()
            );
        } else {
            assert_eq!(result.counts.done, 1);
            assert!(
                !String::from_utf8(content(spy.as_ref(), "/影片/ABC-123/ABC-123.nfo").await)
                    .unwrap()
                    .contains("<thumb>")
            );
        }
        app.shutdown().await;
    }
}
#[tokio::test]
async fn thirty_day_pruning_only_removes_records_and_settings_token_stays_in_private_sqlite() {
    let fake = Fake::normal().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite3");
    let host = memory(vec![root(), video("3", "没有番号.mp4")]);
    let app = application(
        Arc::new(host.clone()),
        rusqlite::Connection::open(&path).unwrap(),
        "run-1",
    );
    configure(&app, &fake, false, false).await;
    let settings = app.db.settings().unwrap().view;
    let view = app
        .configure(tgdrive_media_scraper::model::ConfigureRequest {
            revision: settings.revision,
            backend_url: fake.url.clone(),
            token: Some("synthetic-private-token".into()),
            overwrite_nfo: false,
            overwrite_poster: false,
        })
        .await
        .unwrap();
    assert!(view.token_configured);
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("synthetic-private-token")
    );
    let first = run(&app, None).await;
    app.db
        .with(|db| {
            db.execute(
                "UPDATE runs SET updated_at=?1 WHERE id=?2",
                rusqlite::params![
                    tgdrive_media_scraper::model::now() - 31 * 86400 * 1000,
                    first.id
                ],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let second = run(&app, None).await;
    assert!(app.db.run(&first.id).is_err());
    assert!(app.db.run(&second.id).is_ok());
    assert_eq!(node(&host, "/影片/没有番号.mp4").await.id, "3");
    app.shutdown().await;
    let next = application(
        Arc::new(host),
        rusqlite::Connection::open(&path).unwrap(),
        "run-2",
    );
    assert_eq!(
        next.db.settings().unwrap().token.as_deref(),
        Some("synthetic-private-token")
    );
    next.shutdown().await;
}
#[tokio::test]
async fn closing_sqlite_prevents_all_file_writes_instead_of_continuing_without_a_journal() {
    let fake = Fake::normal().await;
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
    app.db.close();
    assert!(
        app.start(StartRequest {
            request_id: random_id(),
            directory_id: "2".into(),
            retry_of: None
        })
        .await
        .is_err()
    );
    assert!(spy.events.lock().unwrap().is_empty());
    assert_eq!(node(spy.as_ref(), "/影片/ABC-123.mp4").await.id, "3");
    app.shutdown().await;
}
