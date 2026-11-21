//! 真实 FFprobe/FFmpeg 与内存宿主票据的隔离回归；不连接真实宿主或 Telegram。
mod common;
#[path = "common/local_host.rs"]
mod local_host;
use common::*;
use local_host::LocalHost;
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
    let e = app.db.entry("3").unwrap().unwrap();
    let lease = host
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    let token = app.service.login(app.service.epoch(), lease).unwrap();
    let cancel = app.service.authenticate(&token).unwrap().cancel;
    let mut jobs = Vec::new();
    for _ in 0..2 {
        let (app, e, cancel) = (app.clone(), e.clone(), cancel.clone());
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
        media::probe(&app, &e, &CancellationToken::new())
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
    assert_eq!(app.probe_slots.available_permits(), 2);
    assert_eq!(host.active(), 0);
    let began = Instant::now();
    assert!(
        media::probe(&app, &e, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        began.elapsed() >= Duration::from_secs(10) && began.elapsed() < Duration::from_secs(12)
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
