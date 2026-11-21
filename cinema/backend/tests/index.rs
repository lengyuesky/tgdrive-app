//! 从旧影视索引、NFO、排序与文件身份回归迁入；宿主只由内存替身提供。
use std::sync::Arc;
use tgdrive_backend_sdk::HostClient;
use tgdrive_cinema::{
    Application,
    model::{Library, Progress},
};
use tgdrive_contract::{
    Timestamp,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

fn seed(id: &str, parent: &str, name: &str, kind: NodeKind, bytes: &[u8]) -> SeedNode {
    SeedNode {
        id: id.into(),
        parent_id: parent.into(),
        name: name.into(),
        kind,
        bytes: bytes.into(),
        thumbnail: None,
    }
}
fn application(nodes: Vec<SeedNode>) -> (Application, MemoryHost) {
    let host = MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "cinema".into(),
            name: "影视".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: false,
            ..Default::default()
        },
        scope: DirectoryScope::All {
            access: AccessLevel::ReadOnly,
        },
        nodes,
        caller: RuntimeCaller::Backend,
        now: Timestamp(1_700_000_000_000),
        has_backend: true,
    })
    .unwrap();
    let app = Application::new(
        Arc::new(host.clone()),
        rusqlite::Connection::open_in_memory().unwrap(),
        "/usr/bin/ffprobe".into(),
        "/usr/bin/ffmpeg".into(),
    )
    .unwrap();
    (app, host)
}
async fn library(app: &Application, kind: &str, root: &str) {
    let revision = app.db.settings().unwrap().revision;
    app.configure_libraries(
        &revision,
        vec![Library {
            id: "11111111111111111111111111111111".into(),
            name: "合成媒体库".into(),
            kind: kind.into(),
            root_id: root.into(),
        }],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
}

#[tokio::test]
async fn index_has_no_legacy_video_or_scan_file_truncation() {
    let mut nodes = vec![seed("2", "1", "影视", NodeKind::Directory, b"")];
    for i in 0..3105 {
        nodes.push(seed(
            &(i + 3).to_string(),
            "2",
            &format!("视频{i:05}.mp4"),
            NodeKind::File,
            b"synthetic",
        ));
    }
    for i in 0..20050 {
        nodes.push(seed(
            &(i + 4000).to_string(),
            "2",
            &format!("资料{i:05}.txt"),
            NodeKind::File,
            b"data",
        ));
    }
    nodes.push(seed(
        "9223372036854775807",
        "2",
        "最大节点.mp4",
        NodeKind::File,
        b"synthetic",
    ));
    let (app, _) = application(nodes);
    library(&app, "movie", "2").await;
    assert_eq!(tgdrive_cinema::index::state(&app).unwrap()["entries"], 3106);
    let entry = app.db.entry("9223372036854775807").unwrap().unwrap();
    assert_eq!(entry.node_id, "9223372036854775807");
}
#[tokio::test]
async fn exclusive_sidecars_precede_common_and_keep_long_nfo() {
    let plot = "完整长简介。".repeat(5000);
    let text = format!(
        "<movie><title>专属标题</title><plot><![CDATA[{plot}]]></plot><num>ABC-001</num><actor><name>演员</name><thumb>演员.jpg</thumb></actor></movie>"
    );
    let (app, _) = application(vec![
        seed("2", "1", "影视", NodeKind::Directory, b""),
        seed("3", "2", "版本A.mp4", NodeKind::File, b"synthetic"),
        seed("4", "2", "版本A.nfo", NodeKind::File, text.as_bytes()),
        seed(
            "5",
            "2",
            "movie.nfo",
            NodeKind::File,
            b"<movie><title>common</title></movie>",
        ),
        seed("6", "2", "版本A-poster.jpg", NodeKind::File, b"image"),
        seed("7", "2", "poster.jpg", NodeKind::File, b"common"),
        seed("8", "2", "版本A.zh.srt", NodeKind::File, b"subtitle"),
        seed("9", "2", "other.srt", NodeKind::File, b"unrelated"),
        seed("10", "2", "演员.jpg", NodeKind::File, b"portrait"),
    ]);
    library(&app, "movie", "2").await;
    let entry = app.db.entry("3").unwrap().unwrap();
    assert_eq!(entry.title, "专属标题");
    assert_eq!(entry.overview, plot);
    assert_eq!(entry.number, "ABC-001");
    assert_eq!(
        entry
            .posters
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["6", "7"]
    );
    assert_eq!(entry.subtitles.len(), 1);
    assert_eq!(entry.actors[0].portrait.as_ref().unwrap().id, "10");
}
#[tokio::test]
async fn tv_uses_reliable_season_episode_and_directory_identity() {
    let (app, _) = application(vec![
        seed("2", "1", "电视剧", NodeKind::Directory, b""),
        seed("3", "2", "Showname", NodeKind::Directory, b""),
        seed("4", "3", "Season 1", NodeKind::Directory, b""),
        seed("5", "4", "剧.S01E02.mp4", NodeKind::File, b"synthetic"),
        seed("6", "4", "剧.S01E01.mp4", NodeKind::File, b"synthetic"),
        seed("7", "2", "含糊视频.mp4", NodeKind::File, b"synthetic"),
        seed(
            "8",
            "3",
            "tvshow.nfo",
            NodeKind::File,
            "<tvshow><actor><name>剧级演员</name></actor></tvshow>".as_bytes(),
        ),
    ]);
    library(&app, "tv", "2").await;
    let first = app.db.entry("6").unwrap().unwrap();
    let second = app.db.entry("5").unwrap().unwrap();
    assert_eq!(first.kind, "Episode");
    assert_eq!(first.show_guid, second.show_guid);
    assert_eq!(first.show_actors[0].data.name, "剧级演员");
    assert_eq!(app.db.entry("7").unwrap().unwrap().kind, "Video");
    assert_eq!(
        app.db
            .entries_for_group(&first.show_guid)
            .unwrap()
            .iter()
            .map(|e| e.episode)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(
        app.db.catalog(&first.show_guid).unwrap().unwrap().episodes,
        2
    );
}
#[tokio::test]
async fn changes_rename_move_cover_and_reentry_keep_identity_not_path() {
    let (app, host) = application(vec![
        seed("2", "1", "影视", NodeKind::Directory, b""),
        seed("3", "2", "影片.mp4", NodeKind::File, b"first"),
        seed("4", "1", "库外", NodeKind::Directory, b""),
    ]);
    library(&app, "movie", "2").await;
    let first = app.db.entry("3").unwrap().unwrap();
    let serial = app.db.activate(&first.media_guid).unwrap();
    let p = Progress {
        ts: 207.75,
        updated_at: 1,
        duration: 300.0,
        ..Default::default()
    };
    assert!(app.db.save_progress(&first.media_guid, serial, &p).unwrap());
    host.change_node("3".into(), None, Some("改名.mp4".into()), None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    let renamed = app.db.entry("3").unwrap().unwrap();
    assert_eq!(renamed.guid, first.guid);
    assert_eq!(renamed.added_at, first.added_at);
    assert_eq!(app.db.progress(&renamed).unwrap().ts, 207.75);
    host.change_node("3".into(), Some("4".into()), None, None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    assert!(app.db.entry("3").unwrap().is_none());
    host.change_node("3".into(), Some("2".into()), None, None, None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    assert_eq!(
        app.db
            .progress(&app.db.entry("3").unwrap().unwrap())
            .unwrap()
            .ts,
        207.75
    );
    host.change_node("3".into(), None, None, Some(b"second".to_vec()), None)
        .unwrap();
    app.synchronize(false).await.unwrap();
    let replaced = app.db.entry("3").unwrap().unwrap();
    assert_ne!(first.media_guid, replaced.media_guid);
    assert_eq!(app.db.progress(&replaced).unwrap().ts, 0.0);
}
#[tokio::test]
async fn authorization_none_hides_index_without_deleting_progress() {
    let (app, host) = application(vec![
        seed("2", "1", "影视", NodeKind::Directory, b""),
        seed("3", "2", "影片.mp4", NodeKind::File, b"video"),
    ]);
    library(&app, "movie", "2").await;
    let e = app.db.entry("3").unwrap().unwrap();
    let serial = app.db.activate(&e.media_guid).unwrap();
    app.db
        .save_progress(
            &e.media_guid,
            serial,
            &Progress {
                ts: 30.0,
                ..Default::default()
            },
        )
        .unwrap();
    host.set_scope(DirectoryScope::None).unwrap();
    app.synchronize(false).await.unwrap();
    assert!(app.db.entry("3").unwrap().is_none());
    assert!(
        tgdrive_cinema::index::authorized(&app, &e.file())
            .await
            .is_err()
    );
    host.set_scope(DirectoryScope::All {
        access: AccessLevel::ReadOnly,
    })
    .unwrap();
    app.synchronize(false).await.unwrap();
    assert_eq!(
        app.db
            .progress(&app.db.entry("3").unwrap().unwrap())
            .unwrap()
            .ts,
        30.0
    );
}
#[tokio::test]
async fn settings_cas_and_failed_publish_do_not_erase_previous_index() {
    let (app, host) = application(vec![
        seed("2", "1", "影视", NodeKind::Directory, b""),
        seed("3", "2", "影片.mp4", NodeKind::File, b"video"),
    ]);
    library(&app, "movie", "2").await;
    let libs = app.db.libraries().unwrap();
    app.db.begin_scan(&libs).unwrap();
    let scope = host.scope().await.unwrap();
    assert!(app.db.publish("wrong", &scope.revision, "cursor").is_err());
    assert!(app.db.entry("3").unwrap().is_some());
    assert!(app.configure_libraries("wrong", libs).await.is_err());
}
