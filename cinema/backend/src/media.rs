//! FFprobe/FFmpeg 只使用宿主本机限时地址，应用控制共享预算、超时和子进程输出。
use crate::{
    Application,
    model::{Entry, MediaInfo},
};
use image::ImageEncoder;
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use tgdrive_backend_sdk::{Error, HostClient, Result};
use tgdrive_contract::{ByteCount, error_code, files::*};
use tokio::sync::watch;
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

/// 长片 MP4 的索引随时长增长，三小时 60 帧影片约 16 MiB，探测必须整段读完才能得到时长与轨道。
pub const BYTE_LIMIT: u64 = 64 * 1024 * 1024;
pub const IMAGE_LIMIT: usize = 256 * 1024;
/// FFprobe 自身的执行预算；截帧仍用 10 秒。
pub const PROBE_BUDGET: Duration = Duration::from_secs(30);
const FRAME_BUDGET: Duration = Duration::from_secs(10);
const PROBE_TASK_BUDGET: Duration = Duration::from_secs(40);
/// 本机地址与租约要覆盖探测任务总预算，结束时显式撤销。
const INPUT_TTL_SECONDS: u16 = 45;

#[derive(Clone)]
enum ProbeFailure {
    Cancelled,
    Api(u16, tgdrive_contract::ApiError),
    Other(String),
}
impl ProbeFailure {
    fn from_error(error: Error) -> Self {
        match error {
            Error::Cancelled => Self::Cancelled,
            Error::Api { status, error } => Self::Api(status, error),
            error => Self::Other(error.code().into()),
        }
    }
    fn error(&self) -> Error {
        match self {
            Self::Cancelled => Error::Cancelled,
            Self::Api(status, error) => Error::Api {
                status: *status,
                error: error.clone(),
            },
            Self::Other(code) => Error::api(code, "媒体探测未完成，请稍后重试"),
        }
    }
}
type ProbeResult = std::result::Result<MediaInfo, ProbeFailure>;
#[derive(Default)]
struct FlightState {
    requests: usize,
    closed: bool,
    finished: bool,
}
pub(crate) struct ProbeFlight {
    result: watch::Sender<Option<Arc<ProbeResult>>>,
    state: std::sync::Mutex<FlightState>,
    cancel: CancellationToken,
}
impl ProbeFlight {
    fn new(cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            result: watch::channel(None).0,
            state: std::sync::Mutex::default(),
            cancel,
        })
    }
    fn subscribe(self: &Arc<Self>) -> Option<ProbeRequest> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return None;
        }
        state.requests += 1;
        Some(ProbeRequest {
            flight: self.clone(),
            result: self.result.subscribe(),
        })
    }
    fn finish(&self, result: Result<MediaInfo>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finished = true;
        self.result
            .send_replace(Some(Arc::new(result.map_err(ProbeFailure::from_error))));
    }
}
struct ProbeRequest {
    flight: Arc<ProbeFlight>,
    result: watch::Receiver<Option<Arc<ProbeResult>>>,
}
impl ProbeRequest {
    async fn wait(mut self, app: &Application, cancel: &CancellationToken) -> Result<MediaInfo> {
        let read = async {
            loop {
                let ready = self.result.borrow_and_update().clone();
                if let Some(ready) = ready {
                    return ready
                        .as_ref()
                        .as_ref()
                        .cloned()
                        .map_err(ProbeFailure::error);
                }
                self.result.changed().await.map_err(|_| {
                    Error::api(error_code::BACKEND_UNAVAILABLE, "媒体探测任务已结束")
                })?;
            }
        };
        tokio::select! { biased;
            _=cancel.cancelled()=>Err(Error::Cancelled),
            _=app.shutdown_token().cancelled()=>Err(Error::Cancelled),
            result=tokio::time::timeout(PROBE_TASK_BUDGET,read)=>result.unwrap_or_else(|_|Err(Error::api(error_code::REQUEST_TIMEOUT,"媒体探测等待超过 40 秒总预算"))),
        }
    }
}
impl Drop for ProbeRequest {
    fn drop(&mut self) {
        let mut state = self.flight.state.lock().unwrap_or_else(|e| e.into_inner());
        state.requests -= 1;
        if state.requests == 0 && !state.finished {
            state.closed = true;
            self.flight.cancel.cancel();
        }
    }
}
struct ProbeOwner {
    app: Arc<Application>,
    key: String,
    flight: Arc<ProbeFlight>,
}
impl Drop for ProbeOwner {
    fn drop(&mut self) {
        let mut pending = self
            .app
            .pending_probes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if pending
            .get(&self.key)
            .is_some_and(|flight| Arc::ptr_eq(flight, &self.flight))
        {
            pending.remove(&self.key);
        }
        drop(pending);
        let missing = self.flight.result.borrow().is_none();
        if missing {
            self.flight
                .finish(Err(if self.app.shutdown_token().is_cancelled() {
                    Error::Cancelled
                } else {
                    Error::api(
                        error_code::BACKEND_UNAVAILABLE,
                        "媒体探测任务已中断，请重试",
                    )
                }));
        }
    }
}
struct Input {
    host: Arc<dyn HostClient>,
    id: String,
    lease: String,
    url: String,
    closed: bool,
}
impl Input {
    async fn open(app: &Application, entry: &Entry) -> Result<Self> {
        let lease = app
            .host
            .create_read_lease(CreateReadLeaseRequest {
                ttl_seconds: u32::from(INPUT_TTL_SECONDS),
            })
            .await?;
        let local = match app
            .host
            .local_url(LocalFileUrlRequest {
                file: entry.file(),
                ttl_seconds: Some(INPUT_TTL_SECONDS),
                byte_budget: Some(ByteCount(BYTE_LIMIT)),
                request_budget: Some(32),
                lease_id: Some(lease.id.clone()),
            })
            .await
        {
            Ok(local) => local,
            Err(error) => {
                let _ = app.host.revoke_read_lease(lease.id).await;
                return Err(error);
            }
        };
        Ok(Self {
            host: app.host.clone(),
            id: local.id,
            lease: lease.id,
            url: local.url,
            closed: false,
        })
    }
    async fn close(&mut self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.revoke_local_url(self.id.clone()),
        )
        .await;
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.revoke_read_lease(self.lease.clone()),
        )
        .await;
        self.closed = true;
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        let host = self.host.clone();
        let id = self.id.clone();
        let lease = self.lease.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), host.revoke_local_url(id)).await;
                let _ = tokio::time::timeout(Duration::from_secs(2), host.revoke_read_lease(lease))
                    .await;
            });
        }
    }
}
pub fn limits() -> Value {
    json!({"probe_bytes":BYTE_LIMIT,"probe_seconds":PROBE_BUDGET.as_secs(),"probe_task_seconds":PROBE_TASK_BUDGET.as_secs(),"probe_concurrency":2,"probe_queue":0,"probe_output_bytes":128*1024,"probe_packets":64,"nfo_bytes":crate::nfo::MAX_BYTES,"poster_bytes":2*1024*1024,"subtitle_bytes":512*1024,"frame_pixels":16*1024*1024,"frame_edge":640,"frame_image_bytes":IMAGE_LIMIT})
}
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}
pub async fn available(program: &str) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(2),command(program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status()).await,Ok(Ok(s))if s.success())
}
pub fn cached_sync(app: &Application, entry: &Entry) -> Result<Option<MediaInfo>> {
    Ok(app
        .db
        .get::<MediaInfo>("probes", &entry.media_guid)?
        .filter(|info| info.valid(entry)))
}
pub async fn cached(app: &Application, entry: &Entry) -> Result<Option<MediaInfo>> {
    cached_sync(app, entry)
}
pub async fn probe(
    app: &Arc<Application>,
    entry: &Entry,
    cancel: &CancellationToken,
) -> Result<MediaInfo> {
    if cancel.is_cancelled() || app.shutdown_token().is_cancelled() {
        return Err(Error::Cancelled);
    }
    crate::index::authorized(app, &entry.file()).await?;
    if let Some(info) = cached(app, entry).await? {
        return Ok(info);
    }
    app.service.pause_background();
    // 同文件及内容版本的起播接口共用任务，只有不同媒体才占用新的探测名额。
    let (request, owner) = {
        let mut pending = app.pending_probes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = pending
            .get(&entry.media_guid)
            .and_then(ProbeFlight::subscribe)
        {
            (request, None)
        } else {
            let slot =
                app.probe_slots.clone().try_acquire_owned().map_err(|_| {
                    Error::api(error_code::RATE_LIMITED, "媒体探测正忙，请稍后重试")
                })?;
            let flight = ProbeFlight::new(app.shutdown_token().child_token());
            let request = flight.subscribe().expect("新探测任务可以接受请求");
            pending.insert(entry.media_guid.clone(), flight.clone());
            (
                request,
                Some((
                    ProbeOwner {
                        app: app.clone(),
                        key: entry.media_guid.clone(),
                        flight,
                    },
                    slot,
                )),
            )
        }
    };
    if let Some((owner, slot)) = owner {
        let entry = entry.clone();
        let mut jobs = app.probe_jobs.lock().unwrap_or_else(|e| e.into_inner());
        while jobs.try_join_next().is_some() {}
        if app.shutdown_token().is_cancelled() {
            owner.flight.finish(Err(Error::Cancelled));
        } else {
            jobs.spawn(async move {
                let _slot = slot;
                let result = tokio::time::timeout(
                    PROBE_TASK_BUDGET,
                    probe_once(&owner.app, &entry, &owner.flight.cancel),
                )
                .await
                .unwrap_or_else(|_| {
                    Err(Error::api(
                        error_code::REQUEST_TIMEOUT,
                        "媒体探测任务超过 40 秒总预算",
                    ))
                });
                owner.flight.finish(result);
            });
        }
    }
    let info = request.wait(app, cancel).await?;
    crate::index::authorized(app, &entry.file()).await?;
    if cancel.is_cancelled() || app.shutdown_token().is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(info)
}

async fn probe_once(
    app: &Application,
    entry: &Entry,
    cancel: &CancellationToken,
) -> Result<MediaInfo> {
    if cancel.is_cancelled() || app.shutdown_token().is_cancelled() {
        return Err(Error::Cancelled);
    }
    crate::index::authorized(app, &entry.file()).await?;
    if let Some(info) = cached(app, entry).await? {
        return Ok(info);
    }
    let mut input = Input::open(app, entry).await?;
    let result = run_probe(&app.ffprobe_path, &input.url, entry, cancel).await;
    input.close().await;
    let info = result?;
    crate::index::authorized(app, &entry.file()).await?;
    if cancel.is_cancelled() || app.shutdown_token().is_cancelled() {
        return Err(Error::Cancelled);
    }
    if !info.valid(entry) || serde_json::to_vec(&info)?.len() > 32 * 1024 {
        return Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "媒体信息无效或超过持久化预算",
        ));
    }
    app.db.put_probe(entry, &info)?;
    Ok(info)
}
pub async fn run_probe(
    program: &str,
    input: &str,
    entry: &Entry,
    cancel: &CancellationToken,
) -> Result<MediaInfo> {
    let mut child = command(program);
    child
        .args([
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "http,tcp",
            "-format_whitelist",
            "mov,matroska,avi,mpegts,flv,asf,ogg",
            "-probesize",
            "8388608",
            "-analyzeduration",
            "250000",
            "-rw_timeout",
            "5000000",
            "-show_format",
            "-show_streams",
            "-read_intervals",
            "%+#64",
            "-of",
            "json",
        ])
        .arg(input);
    let bytes = run(child, 128 * 1024, PROBE_BUDGET, Some(cancel)).await?;
    let value: Value = tgdrive_contract::validation::parse_unique_json(&bytes)?;
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "预算内未读到真实视频时长"))?;
    let streams = value["streams"]
        .as_array()
        .filter(|s| s.len() <= 64)
        .ok_or_else(|| Error::api(error_code::PAYLOAD_TOO_LARGE, "媒体轨道数无效或超过 64 条"))?;
    let fields = [
        "index",
        "codec_name",
        "codec_type",
        "profile",
        "width",
        "height",
        "coded_width",
        "coded_height",
        "display_aspect_ratio",
        "pix_fmt",
        "level",
        "color_range",
        "color_space",
        "color_transfer",
        "color_primaries",
        "refs",
        "r_frame_rate",
        "avg_frame_rate",
        "bits_per_raw_sample",
        "bit_rate",
        "field_order",
        "sample_rate",
        "channels",
        "channel_layout",
        "tags",
        "disposition",
        "side_data_list",
    ];
    let streams = streams
        .iter()
        .map(|s| {
            let mut object = serde_json::Map::new();
            for field in fields {
                if let Some(value) = s.get(field) {
                    object.insert(field.into(), value.clone());
                }
            }
            Value::Object(object)
        })
        .collect();
    let format = value["format"]["format_name"].as_str().unwrap_or_default();
    let wrapper = if format.contains("matroska") {
        "mkv"
    } else if format.contains("mov") {
        "mp4"
    } else {
        format.split(',').next().unwrap_or_default()
    };
    Ok(MediaInfo {
        version: entry.version.clone(),
        wrapper: wrapper.into(),
        duration,
        streams,
        policy_version: 1,
    })
}
async fn run(
    mut command: Command,
    limit: usize,
    budget: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<u8>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            Error::api(
                error_code::CAPABILITY_UNAVAILABLE,
                "无法启动上下文指定的媒体组件",
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or(Error::Protocol("媒体输出管道缺失"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(Error::Protocol("媒体错误管道缺失"))?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let result = {
        let read_output = async {
            stdout
                .take(limit as u64 + 1)
                .read_to_end(&mut output)
                .await?;
            if output.len() > limit {
                return Err(Error::api(
                    error_code::PAYLOAD_TOO_LARGE,
                    "媒体组件输出超过预算",
                ));
            }
            Ok::<_, Error>(())
        };
        let read_errors = async {
            stderr.take(8193).read_to_end(&mut errors).await?;
            if errors.len() > 8192 {
                return Err(Error::api(
                    error_code::PAYLOAD_TOO_LARGE,
                    "媒体组件错误输出超过预算",
                ));
            }
            Ok::<_, Error>(())
        };
        let wait = async { child.wait().await.map_err(Error::from) };
        let stopped = async {
            match cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! { biased;
            _ = stopped => Err(Error::Cancelled),
            result = tokio::time::timeout(budget, async {
                tokio::try_join!(read_output, read_errors, wait)
            }) => result.unwrap_or_else(|_| Err(Error::api(error_code::REQUEST_TIMEOUT, "媒体组件执行超过时间预算"))),
        }
    };
    if result.is_err() {
        // 取消、超时和输出失败先终止并等待退出，任务结束时子进程已经回收。
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    let (_, _, status) = result?;
    if !status.success() {
        let errors = String::from_utf8_lossy(&errors).to_ascii_lowercase();
        let transient = [
            "timed out",
            "input/output error",
            "connection reset",
            "connection refused",
            "server returned 5",
            "http error 5",
        ]
        .iter()
        .any(|p| errors.contains(p));
        return Err(Error::api(
            if transient {
                error_code::UPSTREAM_UNAVAILABLE
            } else {
                error_code::INVALID_REQUEST
            },
            "媒体组件未能在预算内解析文件",
        ));
    }
    Ok(output)
}
pub async fn frame(
    app: &Application,
    entry: &Entry,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let mut input = Input::open(app, entry).await?;
    let result = tokio::select! {
        _=cancel.cancelled()=>Err(Error::Cancelled),
        _=app.shutdown_token().cancelled()=>Err(Error::Cancelled),
        result=tokio::time::timeout(FRAME_BUDGET,frame_inner(app,entry,&input.url))=>result.unwrap_or_else(|_|Err(Error::api(error_code::REQUEST_TIMEOUT,"封面截帧超过 10 秒预算"))),
    };
    input.close().await;
    result
}
async fn frame_inner(app: &Application, entry: &Entry, input: &str) -> Result<Vec<u8>> {
    let info = match cached(app, entry).await? {
        Some(info) => info,
        None => run_probe(&app.ffprobe_path, input, entry, app.shutdown_token()).await?,
    };
    let video = info
        .video()
        .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "文件没有可取帧的视频轨道"))?;
    let width = video["width"].as_u64().unwrap_or(0);
    let height = video["height"].as_u64().unwrap_or(0);
    if width == 0 || height == 0 || width.saturating_mul(height) > 16 * 1024 * 1024 {
        return Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "视频尺寸超过封面解码预算",
        ));
    }
    let aspect = video["display_aspect_ratio"]
        .as_str()
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(width as f64 / height as f64);
    let (width, height) = if aspect >= 1.0 {
        (640, (640.0 / aspect).round().clamp(1.0, 640.0) as u32)
    } else {
        ((640.0 * aspect).round().clamp(1.0, 640.0) as u32, 640)
    };
    let index = video["index"]
        .as_u64()
        .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "视频轨道身份缺失"))?;
    let interval = video["avg_frame_rate"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .and_then(|(a, b)| Some(b.parse::<f64>().ok()? / a.parse::<f64>().ok()?))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0 / 25.0);
    let mut failure = None;
    for position in positions(info.duration, interval) {
        let mut child = command(&app.ffmpeg_path);
        child
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-threads",
                "1",
                "-filter_threads",
                "1",
                "-max_alloc",
                "67108864",
                "-protocol_whitelist",
                "http,tcp",
                "-format_whitelist",
                "mov,matroska,avi,mpegts,flv,asf,ogg",
                "-probesize",
                "8388608",
                "-analyzeduration",
                "250000",
                "-rw_timeout",
                "5000000",
                "-ss",
            ])
            .arg(format!("{position:.6}"))
            .arg("-i")
            .arg(input)
            .arg("-map")
            .arg(format!("0:{index}"))
            .args(["-an", "-sn", "-dn", "-frames:v", "1", "-vf"])
            .arg(format!("scale={width}:{height},setsar=1"))
            .args([
                "-threads",
                "1",
                "-c:v",
                "mjpeg",
                "-q:v",
                "3",
                "-f",
                "image2pipe",
                "pipe:1",
            ]);
        match run(child, 1024 * 1024, FRAME_BUDGET, None).await {
            Ok(frame) => {
                if let Some(jpeg) = encode_frame(frame).await? {
                    return Ok(jpeg);
                }
            }
            Err(error) => {
                if matches!(
                    error.code(),
                    error_code::UPSTREAM_UNAVAILABLE | error_code::QUOTA_EXCEEDED
                ) {
                    return Err(error);
                }
                failure = Some(error);
            }
        }
    }
    Err(failure
        .unwrap_or_else(|| Error::api(error_code::INVALID_REQUEST, "预算内没有可用的非黑视频画面")))
}
pub fn positions(duration: f64, interval: f64) -> Vec<f64> {
    let last = (duration - interval).max(0.0);
    let mut result = Vec::new();
    for (target, proportion) in [(1.0_f64, 0.1), (3.0, 0.4), (5.0, 0.8)] {
        let p = target.min(duration * proportion).min(last);
        if !result
            .iter()
            .any(|previous: &f64| (*previous - p).abs() < 0.001)
        {
            result.push(p);
        }
    }
    result
}
pub async fn validate_image(bytes: Vec<u8>) -> Result<(String, Vec<u8>)> {
    tokio::task::spawn_blocking(move || {
        let format = image::guess_format(&bytes)
            .map_err(|_| Error::api(error_code::INVALID_REQUEST, "封面不是可识别图片"))?;
        let mime = match format {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::WebP => "image/webp",
            _ => {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "封面只支持 JPEG、PNG、WebP",
                ));
            }
        };
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| Error::api(error_code::INVALID_REQUEST, "图片损坏或超过解码预算"))?;
        if u64::from(image.width()) * u64::from(image.height()) > 16 * 1024 * 1024 {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "图片像素超过预算",
            ));
        }
        Ok((mime.into(), bytes))
    })
    .await
    .map_err(|_| Error::Protocol("图片解码任务失败"))?
}
pub async fn encode_frame(bytes: Vec<u8>) -> Result<Option<Vec<u8>>> {
    tokio::task::spawn_blocking(move || {
        let mut reader =
            image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Jpeg);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(640);
        limits.max_image_height = Some(640);
        limits.max_alloc = Some(4 * 1024 * 1024);
        reader.limits(limits);
        let rgb = reader
            .decode()
            .map_err(|_| Error::api(error_code::INVALID_REQUEST, "截帧不是预算内的 JPEG"))?
            .to_rgb8();
        let bright = rgb
            .pixels()
            .filter(|p| {
                (u32::from(p[0]) * 54 + u32::from(p[1]) * 183 + u32::from(p[2]) * 19) / 256 > 16
            })
            .count();
        if bright * 100 < rgb.width() as usize * rgb.height() as usize * 2 {
            return Ok(None);
        }
        for quality in [85, 70, 50] {
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|_| Error::api(error_code::INVALID_REQUEST, "封面 JPEG 编码失败"))?;
            if jpeg.len() <= IMAGE_LIMIT {
                return Ok(Some(jpeg));
            }
        }
        Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "封面 JPEG 超过 256 KiB",
        ))
    })
    .await
    .map_err(|_| Error::Protocol("截帧编码任务失败"))?
}
