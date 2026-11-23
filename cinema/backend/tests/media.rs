//! 真实 FFprobe/FFmpeg 与内存宿主票据的隔离回归；不连接真实宿主或 Telegram。
mod common;
#[path = "common/local_host.rs"]
mod local_host;
use common::*;
use local_host::LocalHost;
use serde_json::json;
use std::{
    os::unix::fs::PermissionsExt,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tgdrive_backend_sdk::HostClient;
use tgdrive_cinema::{Application, covers, media, model::Library};
use tgdrive_contract::files::*;
use tokio_util::sync::CancellationToken;

fn program(name: &str) -> String {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|path| path.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("媒体测试需要 {name}"))
        .to_string_lossy()
        .into()
}

fn delayed_probe(directory: &std::path::Path) -> String {
    let delayed = directory.join("delayed-ffprobe");
    std::fs::write(
        &delayed,
        format!(
            "#!/bin/sh\nif [ \"$1\" != '-version' ]; then /bin/sleep 0.3; fi\nexec '{}' \"$@\"\n",
            program("ffprobe")
        ),
    )
    .unwrap();
    std::fs::set_permissions(&delayed, std::fs::Permissions::from_mode(0o700)).unwrap();
    delayed.to_string_lossy().into()
}

async fn wait_for_probe_cleanup(app: &Application, host: &LocalHost) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while app.probe_slots.available_permits() != 2 || host.active() != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

fn slow_probe_with_pid(directory: &std::path::Path) -> (String, std::path::PathBuf) {
    let script = directory.join("slow-ffprobe");
    let pid = directory.join("probe.pid");
    let literal = format!("'{}'", pid.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\nprintf '%s' \"$$\" > {literal}\nexec /bin/sleep 60\n"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    (script.to_string_lossy().into(), pid)
}

async fn probe_pid(path: &std::path::Path) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(pid) = std::fs::read_to_string(path)
                && !pid.is_empty()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

fn assert_probe_process_exited(pid: &str) {
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .output()
            .unwrap()
            .status
            .success()
    );
}
fn video(filter: &str, seconds: &str, wrapper: &str) -> Vec<u8> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(format!("synthetic.{wrapper}"));
    let mut command = std::process::Command::new(program("ffmpeg"));
    command.args([
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        filter,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:a",
        "-t",
        seconds,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
    ]);
    if wrapper == "mp4" {
        command.args(["-movflags", "+faststart"]);
    }
    let status = command.arg(&path).status().unwrap();
    assert!(status.success());
    std::fs::read(path).unwrap()
}

fn remux(bytes: &[u8], flags: &str) -> Vec<u8> {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.mp4");
    let output = directory.path().join("output.mp4");
    std::fs::write(&input, bytes).unwrap();
    let status = std::process::Command::new(program("ffmpeg"))
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(&input)
        .args(["-map", "0", "-c", "copy", "-movflags", flags])
        .arg(&output)
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::read(output).unwrap()
}

fn tail_index(bytes: Vec<u8>) -> Vec<u8> {
    let mut cursor = 0;
    loop {
        let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        assert!(size >= 8 && cursor + size <= bytes.len());
        if &bytes[cursor + 4..cursor + 8] == b"moov" {
            assert_eq!(cursor + size, bytes.len());
            let mut output = bytes[..cursor].to_vec();
            let padding = 12 * 1024 * 1024_u32;
            output.extend_from_slice(&padding.to_be_bytes());
            output.extend_from_slice(b"free");
            output.resize(output.len() + padding as usize - 8, 0);
            output.extend_from_slice(&bytes[cursor..]);
            return output;
        }
        cursor += size;
    }
}

/// 高帧率短片循环拷贝成长片：样本表按帧数增长，得到真实长片才有的大索引。
fn long_index(tail: bool) -> Vec<u8> {
    let directory = tempfile::tempdir().unwrap();
    let unit = directory.path().join("unit.mp4");
    let output = directory.path().join("long.mp4");
    let status = std::process::Command::new(program("ffmpeg"))
        .args(["-v", "error", "-nostdin", "-f", "lavfi", "-i"])
        .arg("testsrc2=size=32x32:rate=240")
        .args(["-t", "20", "-c:v", "libx264", "-preset", "ultrafast"])
        .args(["-bf", "2", "-threads", "1", "-pix_fmt", "yuv420p"])
        .arg(&unit)
        .status()
        .unwrap();
    assert!(status.success());
    let status = std::process::Command::new(program("ffmpeg"))
        .args(["-v", "error", "-nostdin", "-stream_loop", "249", "-i"])
        .arg(&unit)
        .args(["-map", "0", "-c", "copy", "-movflags"])
        .arg(if tail { "0" } else { "+faststart" })
        .arg(&output)
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::read(output).unwrap()
}

fn index_size(bytes: &[u8]) -> usize {
    let mut cursor = 0;
    while cursor + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        assert!(size >= 8);
        if &bytes[cursor + 4..cursor + 8] == b"moov" {
            return size;
        }
        cursor += size;
    }
    panic!("合成视频缺少索引");
}

#[tokio::test]
async fn long_videos_with_index_beyond_eight_mebibytes_probe_at_head_and_tail() {
    for (name, tail) in [("long-head.mp4", false), ("long-tail.mp4", true)] {
        let bytes = long_index(tail);
        let index = index_size(&bytes);
        assert!(index > 8 * 1024 * 1024, "{name}: 索引仅 {index} 字节");
        let (app, host) = application(&bytes, name, None).await;
        let entry = app.db.entry("3").unwrap().unwrap();
        let info = media::probe(&app, &entry, &CancellationToken::new())
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "{name}: {error}; 读取 {} 字节，{} 次请求",
                    host.reads.load(Ordering::Relaxed),
                    host.requests.load(Ordering::Relaxed)
                )
            });
        assert!(
            (4999.0..5001.0).contains(&info.duration),
            "{name}: {}",
            info.duration
        );
        assert!(info.video().is_some());
        let read = host.reads.load(Ordering::Relaxed);
        assert!(
            read > index as u64 && read <= media::BYTE_LIMIT,
            "{name}: {read}"
        );
        assert_eq!(host.active(), 0);
        app.shutdown().await;
    }
}

#[tokio::test]
async fn valid_tail_index_fragmented_mp4_and_transport_streams_probe_with_bounded_input() {
    let original = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    for (name, bytes) in [
        ("tail.mp4", tail_index(remux(&original, "0"))),
        (
            "fragmented.mp4",
            remux(&original, "frag_keyframe+empty_moov+default_base_moof"),
        ),
        (
            "transport.ts",
            video("testsrc2=size=160x90:rate=25", "1", "ts"),
        ),
    ] {
        let (app, host) = application(&bytes, name, None).await;
        let entry = app.db.entry("3").unwrap().unwrap();
        let info = media::probe(&app, &entry, &CancellationToken::new())
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "{name}: {error}; 读取 {} 字节，{} 次请求",
                    host.reads.load(Ordering::Relaxed),
                    host.requests.load(Ordering::Relaxed)
                )
            });
        assert!(
            (0.9..1.2).contains(&info.duration),
            "{name}: {}",
            info.duration
        );
        assert!(info.video().is_some());
        assert!(host.reads.load(Ordering::Relaxed) <= media::BYTE_LIMIT);
        assert_eq!(host.active(), 0);
        app.shutdown().await;
    }
}

#[tokio::test]
async fn concurrent_first_playback_requests_share_one_probe_and_all_return_playable_tracks() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    let (app, host) = application(&bytes, "first.mp4", Some(delayed_probe(directory.path()))).await;
    let revision = app.db.settings().unwrap().revision;
    app.configure_account(&revision, "synthetic", "Synthetic-Only-Account")
        .await
        .unwrap();
    let revision = app.db.settings().unwrap().revision;
    app.start_service(&revision).await.unwrap();
    let token = login(&app).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    let list_path = format!("/v/api/v1/stream/list/{}", entry.media_guid);
    let (info, stream, tracks) = tokio::join!(
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/play/info",
            Some(&token),
            json!({"item_guid":entry.guid}),
            &[]
        ),
        wire(
            &app,
            false,
            "POST",
            "/v/api/v1/stream",
            Some(&token),
            json!({"media_guid":entry.media_guid}),
            &[]
        ),
        wire(&app, false, "GET", &list_path, Some(&token), json!({}), &[]),
    );
    let (info_status, info) = body(info).await;
    let (stream_status, stream) = body(stream).await;
    let (track_status, tracks) = body(tracks).await;
    assert_eq!(
        [info_status, stream_status, track_status],
        [200, 200, 200],
        "{info}; {stream}; {tracks}"
    );
    assert_eq!(
        info["data"]["video_guid"],
        tracks["data"]["video_streams"][0]["guid"]
    );
    assert_eq!(stream["data"]["audio_streams"].as_array().unwrap().len(), 2);
    assert_eq!(host.local_urls.load(Ordering::Relaxed), 1);
    assert_eq!(host.active(), 0);
    app.shutdown().await;
}

#[tokio::test]
async fn cancelling_one_request_does_not_cancel_another_request_for_the_same_video() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    let (app, host) =
        application(&bytes, "shared.mp4", Some(delayed_probe(directory.path()))).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    let cancel_first = CancellationToken::new();
    let cancel_second = CancellationToken::new();
    let mut first = Box::pin(media::probe(&app, &entry, &cancel_first));
    let mut second = Box::pin(media::probe(&app, &entry, &cancel_second));
    tokio::select! { biased;
        _=&mut first=>panic!("延迟探测尚未完成"),
        _=&mut second=>panic!("延迟探测尚未完成"),
        _=tokio::time::sleep(Duration::from_millis(50))=>{},
    }
    cancel_first.cancel();
    let (first, second) = tokio::join!(first, second);
    assert!(matches!(first, Err(tgdrive_backend_sdk::Error::Cancelled)));
    assert!(second.unwrap().video().is_some());
    assert_eq!(host.local_urls.load(Ordering::Relaxed), 1);
    wait_for_probe_cleanup(&app, &host).await;
    app.shutdown().await;
}

#[tokio::test]
async fn dropping_one_http_request_keeps_the_shared_probe_alive_for_remaining_requests() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    let (app, host) =
        application(&bytes, "shared.mp4", Some(delayed_probe(directory.path()))).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    let cancel = CancellationToken::new();
    let mut first = Box::pin(media::probe(&app, &entry, &cancel));
    let mut second = Box::pin(media::probe(&app, &entry, &cancel));
    tokio::select! { biased;
        _=&mut first=>panic!("延迟探测尚未完成"),
        _=&mut second=>panic!("延迟探测尚未完成"),
        _=tokio::time::sleep(Duration::from_millis(50))=>{},
    }
    drop(first);
    assert!(second.await.unwrap().video().is_some());
    assert_eq!(host.local_urls.load(Ordering::Relaxed), 1);
    wait_for_probe_cleanup(&app, &host).await;
    app.shutdown().await;
}

#[tokio::test]
async fn dropping_the_last_request_reaps_the_probe_and_a_new_request_can_retry() {
    let directory = tempfile::tempdir().unwrap();
    let (script, marker) = slow_probe_with_pid(directory.path());
    let bytes = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    let (app, host) = application(&bytes, "retry.mp4", Some(script.clone())).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    let pending_app = app.clone();
    let pending_entry = entry.clone();
    let request = tokio::spawn(async move {
        media::probe(&pending_app, &pending_entry, &CancellationToken::new()).await
    });
    let pid = probe_pid(&marker).await;
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    wait_for_probe_cleanup(&app, &host).await;
    assert_probe_process_exited(&pid);
    std::fs::write(
        script,
        format!("#!/bin/sh\nexec '{}' \"$@\"\n", program("ffprobe")),
    )
    .unwrap();
    let info = media::probe(&app, &entry, &CancellationToken::new())
        .await
        .unwrap();
    assert!(info.video().is_some());
    assert_eq!(host.local_urls.load(Ordering::Relaxed), 2);
    app.shutdown().await;
}

#[tokio::test]
async fn application_shutdown_reaps_shared_probes_before_closing_the_database() {
    let directory = tempfile::tempdir().unwrap();
    let (script, marker) = slow_probe_with_pid(directory.path());
    let (app, host) = application(b"synthetic", "stop.mp4", Some(script)).await;
    let entry = app.db.entry("3").unwrap().unwrap();
    let pending_app = app.clone();
    let request =
        tokio::spawn(
            async move { media::probe(&pending_app, &entry, &CancellationToken::new()).await },
        );
    let pid = probe_pid(&marker).await;
    app.shutdown().await;
    assert!(matches!(
        request.await.unwrap(),
        Err(tgdrive_backend_sdk::Error::Cancelled)
    ));
    assert_eq!(host.active(), 0);
    assert_eq!(app.probe_slots.available_permits(), 2);
    assert_probe_process_exited(&pid);
}

async fn application(
    bytes: &[u8],
    name: &str,
    ffprobe: Option<String>,
) -> (Arc<Application>, Arc<LocalHost>) {
    let (_, memory) = memory(vec![root(), seed("3", "2", name, NodeKind::File, bytes)]);
    let host = Arc::new(LocalHost::new(memory));
    let app = Application::new(
        host.clone(),
        rusqlite::Connection::open_in_memory().unwrap(),
        ffprobe.unwrap_or_else(|| program("ffprobe")),
        program("ffmpeg"),
    )
    .unwrap();
    let revision = app.db.settings().unwrap().revision;
    app.configure_libraries(
        &revision,
        vec![Library {
            id: LIBRARY.into(),
            name: "真实媒体合成库".into(),
            kind: "movie".into(),
            root_id: "2".into(),
        }],
    )
    .await
    .unwrap();
    app.synchronize(true).await.unwrap();
    (Arc::new(app), host)
}
fn png(color: [u8; 3]) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(160, 90, image::Rgb(color));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
#[tokio::test]
async fn real_mp4_mkv_probe_tracks_and_cache_use_bounded_local_input() {
    for wrapper in ["mp4", "mkv"] {
        let bytes = video("testsrc2=size=160x90:rate=25", "1", wrapper);
        let (app, host) = application(&bytes, &format!("video.{wrapper}"), None).await;
        let e = app.db.entry("3").unwrap().unwrap();
        let info = media::probe(&app, &e, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(info.wrapper, wrapper);
        assert!((0.9..1.2).contains(&info.duration));
        assert_eq!(
            info.streams
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .count(),
            2
        );
        let used = host.reads.load(Ordering::Relaxed);
        assert!(used > 0 && used <= media::BYTE_LIMIT);
        media::probe(&app, &e, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(host.reads.load(Ordering::Relaxed), used);
        assert_eq!(host.active(), 0);
        app.shutdown().await;
    }
}
#[tokio::test]
async fn frames_skip_black_intro_preserve_display_aspect_and_handle_single_frame() {
    for (filter, seconds, aspect) in [
        (
            "color=c=red:size=160x90:rate=25,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,2)'",
            "6",
            16.0 / 9.0,
        ),
        (
            "color=c=red:size=160x90:rate=25,setsar=2/1",
            "1",
            32.0 / 9.0,
        ),
        ("color=c=red:size=160x90:rate=25", "0.04", 16.0 / 9.0),
    ] {
        let bytes = video(filter, seconds, "mp4");
        let (app, host) = application(&bytes, "video.mp4", None).await;
        let e = app.db.entry("3").unwrap().unwrap();
        let jpeg = media::frame(&app, &e, &CancellationToken::new())
            .await
            .unwrap();
        assert!(jpeg.len() <= media::IMAGE_LIMIT);
        let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert!(image.width() <= 640 && image.height() <= 640);
        assert!((image.width() as f64 / image.height() as f64 - aspect).abs() < 0.02);
        let p = image.get_pixel(20, 20);
        assert!(p[0] > 200 && p[1] < 40);
        assert!(host.reads.load(Ordering::Relaxed) <= media::BYTE_LIMIT);
        assert_eq!(host.active(), 0);
        app.shutdown().await;
    }
}
#[tokio::test]
async fn pure_large_video_gets_bounded_frame_and_black_video_is_terminal() {
    let mut bytes = video("testsrc2=size=160x90:rate=25", "1", "mp4");
    let extra = 12 * 1024 * 1024_u32;
    bytes.extend_from_slice(&extra.to_be_bytes());
    bytes.extend_from_slice(b"free");
    bytes.resize(bytes.len() + extra as usize - 8, 0);
    let (app, host) = application(&bytes, "large.mp4", None).await;
    let e = app.db.entry("3").unwrap().unwrap();
    let jpeg = media::frame(&app, &e, &CancellationToken::new())
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{error}; 读取 {} 字节，{} 次请求",
                host.reads.load(Ordering::Relaxed),
                host.requests.load(Ordering::Relaxed)
            )
        });
    assert!(jpeg.len() <= media::IMAGE_LIMIT);
    assert!(host.reads.load(Ordering::Relaxed) <= media::BYTE_LIMIT);
    app.shutdown().await;
    let bytes = video("color=c=black:size=160x90:rate=25", "1", "mp4");
    let (app, host) = application(&bytes, "black.mp4", None).await;
    covers::schedule(&app, false).unwrap();
    assert!(covers::process_next(&app).await.unwrap());
    let e = app.db.entry("3").unwrap().unwrap();
    let state = app
        .db
        .get::<covers::Record>("cover_states", &e.media_guid)
        .unwrap()
        .unwrap();
    assert_eq!(state.state, "failed");
    assert_eq!(state.next_retry, 0);
    assert!(!covers::process_next(&app).await.unwrap());
    assert_eq!(host.active(), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn invalid_specific_image_falls_back_to_original_and_thumbnail_needs_no_video() {
    let (app, host, _) = configured(
        vec![
            root(),
            seed("3", "2", "clip.mp4", NodeKind::File, b"not-video"),
            seed("4", "2", "clip-poster.jpg", NodeKind::File, b"broken"),
            seed("5", "2", "poster.png", NodeKind::File, &png([20, 210, 30])),
        ],
        "movie",
    )
    .await;
    covers::schedule(&app, false).unwrap();
    covers::process_next(&app).await.unwrap();
    let e = app.db.entry("3").unwrap().unwrap();
    let state = app
        .db
        .get::<covers::Record>("cover_states", &e.media_guid)
        .unwrap()
        .unwrap();
    assert_eq!(state.kind, "sidecar");
    let image = host
        .cache_get(e.cover.unwrap(), Default::default())
        .await
        .unwrap();
    assert_eq!(
        tgdrive_backend_sdk::collect_bytes(image.body, 2 * 1024 * 1024)
            .await
            .unwrap()
            .as_ref(),
        png([20, 210, 30])
    );
    let mut video = seed("3", "2", "thumb.mp4", NodeKind::File, b"not-a-video");
    video.thumbnail = Some(png([220, 20, 30]));
    let (app, _, _) = configured(vec![root(), video], "movie").await;
    covers::schedule(&app, false).unwrap();
    covers::process_next(&app).await.unwrap();
    let e = app.db.entry("3").unwrap().unwrap();
    assert_eq!(
        app.db
            .get::<covers::Record>("cover_states", &e.media_guid)
            .unwrap()
            .unwrap()
            .kind,
        "thumbnail"
    );
}
#[tokio::test]
async fn probe_has_zero_wait_queue_cancel_reaps_children_and_deadline_is_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("slow-probe");
    std::fs::write(&path, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (app, host) = application(b"fake", "video.mp4", Some(path.to_string_lossy().into())).await;
    for (id, name) in [("4", "second.mp4"), ("5", "third.mp4")] {
        host.memory
            .add_node(seed(id, "2", name, NodeKind::File, b"fake"))
            .unwrap();
    }
    app.synchronize(true).await.unwrap();
    let e = app.db.entry("3").unwrap().unwrap();
    let other = app.db.entry("4").unwrap().unwrap();
    let third = app.db.entry("5").unwrap().unwrap();
    let lease = host
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    let token = app.service.login(app.service.epoch(), lease).unwrap();
    let cancel = app.service.authenticate(&token).unwrap().cancel;
    let mut jobs = Vec::new();
    for e in [e.clone(), other] {
        let (app, cancel) = (app.clone(), cancel.clone());
        jobs.push(tokio::spawn(async move {
            media::probe(&app, &e, &cancel).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while app.probe_slots.available_permits() > 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let began = Instant::now();
    assert!(
        media::probe(&app, &third, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(began.elapsed() < Duration::from_millis(500));
    app.revoke_sessions().await.unwrap();
    for job in jobs {
        assert!(
            tokio::time::timeout(Duration::from_secs(2), job)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
    wait_for_probe_cleanup(&app, &host).await;
    assert_eq!(app.probe_slots.available_permits(), 2);
    assert_eq!(host.active(), 0);
    let began = Instant::now();
    assert!(
        media::probe(&app, &e, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        began.elapsed() >= media::PROBE_BUDGET
            && began.elapsed() < media::PROBE_BUDGET + Duration::from_secs(2)
    );
    assert_eq!(host.active(), 0);
    app.shutdown().await;
}
#[tokio::test]
async fn frame_positions_and_decode_limits_are_explicit() {
    assert_eq!(media::positions(0.04, 0.04), vec![0.0]);
    let black = image::RgbImage::from_pixel(40, 40, image::Rgb([0, 0, 0]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
        .encode_image(&black)
        .unwrap();
    assert!(media::encode_frame(jpeg).await.unwrap().is_none());
    assert!(
        media::validate_image(b"<script>not-image</script>".to_vec())
            .await
            .is_err()
    );
}
