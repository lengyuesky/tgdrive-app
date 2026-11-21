//! 封面先发布条目，再单并发补图；所有二进制只放宿主可再生缓存。
use crate::{Application, database::SqlResult, index, media, model::*};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tgdrive_backend_sdk::{
    Error, HttpResponse, ReadOptions, Result, byte_stream, bytes_body, collect_bytes, empty_body,
    http::{HeaderMap, Method},
    stream_body,
};
use tgdrive_contract::{
    data::CachePutMetadata, error_code, files::*, validation::resolve_single_range,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub fingerprint: String,
    pub state: String,
    pub cache_key: Option<String>,
    pub kind: String,
    pub source: Option<Source>,
    pub attempts: u8,
    pub next_retry: i64,
    pub error: String,
}
fn source_fingerprint(entry: &Entry) -> String {
    guid(&[
        "cinema-cover-1",
        &entry.media_guid,
        &entry
            .posters
            .iter()
            .map(|source| source.guid("poster"))
            .collect::<Vec<_>>()
            .join(":"),
    ])
}
pub fn fingerprint(entry: &Entry) -> String {
    guid(&[
        &source_fingerprint(entry),
        if entry.has_thumbnail {
            &entry.thumbnail_revision
        } else {
            ""
        },
    ])
}
/// 只有实际采用附件缩略图的结果受节点修订影响；海报和截帧按内容与候选来源复用。
pub fn fingerprint_for(entry: &Entry, kind: &str) -> String {
    match kind {
        "sidecar" => source_fingerprint(entry),
        "frame" => guid(&[
            &source_fingerprint(entry),
            if entry.has_thumbnail {
                "thumbnail"
            } else {
                "no-thumbnail"
            },
        ]),
        _ => fingerprint(entry),
    }
}
fn queued(entry: &Entry) -> Record {
    Record {
        fingerprint: fingerprint(entry),
        state: "queued".into(),
        cache_key: None,
        kind: String::new(),
        source: None,
        attempts: 0,
        next_retry: 0,
        error: String::new(),
    }
}
fn save(app: &Application, entry: &Entry, record: &Record) -> Result<()> {
    app.db.with(|db|{db.execute("INSERT INTO cover_states(media_guid,fingerprint,state,cache_key,next_retry,document) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(media_guid) DO UPDATE SET fingerprint=excluded.fingerprint,state=excluded.state,cache_key=excluded.cache_key,next_retry=excluded.next_retry,document=excluded.document",params![entry.media_guid,record.fingerprint,record.state,record.cache_key,record.next_retry,serde_json::to_string(record)?]).app()?;Ok(())})
}
pub fn schedule(app: &Application, manual: bool) -> Result<()> {
    let mut after = String::new();
    loop {
        let ids = app.db.entry_ids(&after, 200)?;
        if ids.is_empty() {
            break;
        }
        for id in ids {
            after = id.clone();
            let Some(entry) = app.db.entry(&id)? else {
                continue;
            };
            let previous = app.db.get::<Record>("cover_states", &entry.media_guid)?;
            if previous.as_ref().is_none_or(|p| {
                p.fingerprint != fingerprint_for(&entry, &p.kind) || manual && p.state == "failed"
            }) {
                save(app, &entry, &queued(&entry))?;
            }
        }
    }
    app.cover_wake.notify_one();
    Ok(())
}
pub async fn source_current(app: &Application, entry: &Entry, source: &Source) -> Result<FileNode> {
    let video = index::authorized(app, &entry.file()).await?;
    let file = index::authorized(app, &source.file()).await?;
    if video.parent_id != file.parent_id {
        return Err(Error::api(error_code::NOT_FOUND, "封面已移出视频目录"));
    }
    Ok(file)
}
async fn read_sidecar(app: &Application, entry: &Entry, source: &Source) -> Result<Vec<u8>> {
    let file = source_current(app, entry, source).await?;
    if file.size.0 == 0 || file.size.0 > POSTER_LIMIT {
        return Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "同目录海报超过读取上限",
        ));
    }
    let response = app
        .host
        .bytes(
            source.file(),
            ReadOptions {
                range: Some(format!("bytes=0-{}", file.size.0 - 1)),
                ..Default::default()
            },
        )
        .await?;
    if response.status != 206 {
        return Err(Error::Protocol("海报读取未精确满足 Range"));
    }
    let bytes = collect_bytes(response.body, POSTER_LIMIT).await?;
    if bytes.len() as u64 != file.size.0 {
        return Err(Error::Protocol("海报读取不完整"));
    }
    Ok(bytes.to_vec())
}
async fn store_image(
    app: &Application,
    entry: &Entry,
    source: Option<Source>,
    kind: &str,
    image: (String, Vec<u8>),
    cancel: &CancellationToken,
) -> Result<Record> {
    index::authorized(app, &entry.file()).await?;
    if let Some(source) = &source {
        source_current(app, entry, source).await?;
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let key = guid(&[
        "cinema-cover-image-1",
        &entry.media_guid,
        kind,
        &source
            .as_ref()
            .map(|s| s.guid("poster"))
            .unwrap_or_else(|| fingerprint_for(entry, kind)),
    ]);
    let mut sources = vec![entry.file()];
    if let Some(source) = &source {
        sources.push(source.file());
    }
    app.host
        .cache_put(
            key.clone(),
            byte_stream(image.1),
            image.0,
            CachePutMetadata {
                metadata: json!({"media_guid":entry.media_guid,"kind":kind}),
                sources,
            },
        )
        .await?;
    index::authorized(app, &entry.file()).await?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let latest = app
        .db
        .entry(&entry.node_id)?
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "封面条目已离库"))?;
    if fingerprint_for(&latest, kind) != fingerprint_for(entry, kind) {
        return Err(Error::Cancelled);
    }
    let mut record = queued(entry);
    record.fingerprint = fingerprint_for(entry, kind);
    record.state = "ready".into();
    record.cache_key = Some(key);
    record.kind = kind.into();
    record.source = source;
    Ok(record)
}
pub async fn process(
    app: &Application,
    entry: &Entry,
    cancel: &CancellationToken,
) -> Result<Record> {
    index::authorized(app, &entry.file()).await?;
    let fetch = async {
        let mut transient = None;
        for source in &entry.posters {
            match read_sidecar(app, entry, source).await {
                Ok(bytes) => {
                    if let Ok(image) = media::validate_image(bytes).await {
                        return store_image(
                            app,
                            entry,
                            Some(source.clone()),
                            "sidecar",
                            image,
                            cancel,
                        )
                        .await;
                    }
                }
                Err(error) => {
                    if matches!(
                        error.code(),
                        error_code::SCOPE_DENIED
                            | error_code::APP_CHANGED
                            | error_code::APP_DISABLED
                    ) {
                        return Err(error);
                    }
                    if matches!(
                        error.code(),
                        error_code::UPSTREAM_UNAVAILABLE | error_code::STORAGE_UNAVAILABLE
                    ) {
                        transient = Some(error);
                    }
                }
            }
        }
        if entry.has_thumbnail {
            let ticket = app
                .host
                .media_url(MediaUrlRequest {
                    file: entry.file(),
                    representation: FileRepresentation::Thumbnail,
                    disposition: Disposition::Inline,
                    filename: None,
                    content_type: None,
                    ttl_seconds: Some(15),
                    lease_id: None,
                })
                .await;
            match ticket {
                Ok(ticket) => match app
                    .host
                    .ticket_bytes(ticket.url, ReadOptions::default())
                    .await
                {
                    Ok(response) => {
                        let bytes = collect_bytes(response.body, SUBTITLE_LIMIT).await?;
                        if let Ok(image) = media::validate_image(bytes.to_vec()).await {
                            return store_image(app, entry, None, "thumbnail", image, cancel).await;
                        }
                    }
                    Err(error) => transient = Some(error),
                },
                Err(error) => {
                    if matches!(
                        error.code(),
                        error_code::SCOPE_DENIED
                            | error_code::APP_CHANGED
                            | error_code::APP_DISABLED
                    ) {
                        return Err(error);
                    }
                    transient = Some(error);
                }
            }
        }
        let frame = media::frame(app, entry, cancel).await;
        match frame {
            Ok(bytes) => {
                store_image(
                    app,
                    entry,
                    None,
                    "frame",
                    ("image/jpeg".into(), bytes),
                    cancel,
                )
                .await
            }
            Err(error) => Err(transient.unwrap_or(error)),
        }
    };
    tokio::select! {_=cancel.cancelled()=>Err(Error::Cancelled),_=app.shutdown_token().cancelled()=>Err(Error::Cancelled),result=tokio::time::timeout(std::time::Duration::from_secs(10),fetch)=>result.unwrap_or_else(|_|Err(Error::api(error_code::REQUEST_TIMEOUT,"封面读取超过 10 秒预算")))}
}
pub async fn process_next(app: &Application) -> Result<bool> {
    let next=app.db.with(|db|db.query_row("SELECT e.node_id FROM cover_states c JOIN entries e ON e.media_guid=c.media_guid WHERE c.state='queued' OR (c.state='failed' AND c.next_retry>0 AND c.next_retry<=?1) ORDER BY c.next_retry,c.media_guid LIMIT 1",[now()],|r|r.get::<_,String>(0)).optional().app())?;
    let Some(id) = next else {
        return Ok(false);
    };
    let Some(entry) = app.db.entry(&id)? else {
        return Ok(false);
    };
    let Some(cancel) = app.service.background() else {
        return Ok(false);
    };
    let mut previous = app
        .db
        .get::<Record>("cover_states", &entry.media_guid)?
        .unwrap_or_else(|| queued(&entry));
    let result = process(app, &entry, &cancel).await;
    if cancel.is_cancelled() || app.shutdown_token().is_cancelled() {
        return Ok(false);
    }
    match result {
        Ok(record) => save(app, &entry, &record)?,
        Err(error) => {
            previous.state = "failed".into();
            previous.error = match error {
                Error::Api { ref error, .. } => error.message.clone(),
                _ => "封面生成未完成".into(),
            };
            let transient = matches!(
                error.code(),
                error_code::UPSTREAM_UNAVAILABLE
                    | error_code::STORAGE_UNAVAILABLE
                    | error_code::REQUEST_TIMEOUT
            );
            previous.next_retry = if transient {
                [300_000, 1_800_000]
                    .get(previous.attempts as usize)
                    .map(|delay| now() + delay)
                    .unwrap_or(0)
            } else {
                0
            };
            previous.attempts = previous.attempts.saturating_add(1);
            save(app, &entry, &previous)?;
        }
    }
    Ok(true)
}
/// 只在页面确实需要此图片时核对缓存命中；被淘汰的图片重新排队，不为了常驻图片反复全库生成。
pub async fn page_key(app: &Application, entry: &Entry) -> Result<Option<String>> {
    index::authorized(app, &entry.file()).await?;
    let record = app
        .db
        .get::<Record>("cover_states", &entry.media_guid)?
        .filter(|record| {
            record.state == "ready" && record.fingerprint == fingerprint_for(entry, &record.kind)
        });
    let Some(record) = record else {
        return Ok(None);
    };
    if let Some(source) = &record.source {
        source_current(app, entry, source).await?;
    }
    let Some(key) = record.cache_key else {
        return Ok(None);
    };
    match app
        .host
        .cache_get(
            key.clone(),
            ReadOptions {
                head: true,
                ..Default::default()
            },
        )
        .await
    {
        Ok(_) => Ok(Some(key)),
        Err(error) if error.code() == error_code::NOT_FOUND => {
            save(app, entry, &queued(entry))?;
            app.cover_wake.notify_one();
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
pub fn status(app: &Application) -> Result<Value> {
    app.db.with(|db| {
        let (mut ready, mut pending, mut failed, mut retrying) = (0, 0, 0, 0);
        let mut errors = Vec::new();
        let mut statement = db.prepare("SELECT c.state,c.next_retry,c.document,e.title FROM cover_states c JOIN entries e ON e.media_guid=c.media_guid").app()?;
        let mut rows = statement.query([]).app()?;
        while let Some(row) = rows.next().app()? {
            let state: String = row.get(0).app()?;
            let retry: i64 = row.get(1).app()?;
            match state.as_str() {
                "ready" => ready += 1,
                "failed" => {
                    failed += 1;
                    if retry > 0 { retrying += 1; }
                    if errors.len() < 12 {
                        let record: Record = serde_json::from_str(&row.get::<_,String>(2).app()?)?;
                        errors.push(json!({"title":row.get::<_,String>(3).app()?,"reason":record.error,"retry_at":retry}));
                    }
                },
                _ => pending += 1,
            }
        }
        Ok(json!({"ready":ready,"pending":pending,"failed":failed,"retrying":retrying,"errors":errors}))
    })
}
pub async fn response(
    app: std::sync::Arc<Application>,
    entry: Entry,
    reference: &str,
    headers: &HeaderMap,
    method: &Method,
    session: crate::service::Session,
) -> Result<HttpResponse> {
    let mut record = app
        .db
        .get::<Record>("cover_states", &entry.media_guid)?
        .filter(|r| {
            r.state == "ready"
                && r.fingerprint == fingerprint_for(&entry, &r.kind)
                && r.cache_key.as_deref() == Some(reference)
        })
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "视频封面尚未就绪"))?;
    index::authorized(&app, &entry.file()).await?;
    if let Some(source) = &record.source {
        source_current(&app, &entry, source).await?;
    }
    let response = match app
        .host
        .cache_get(reference.into(), ReadOptions::default())
        .await
    {
        Ok(r) => r,
        Err(error) if error.code() == error_code::NOT_FOUND => {
            record.state = "queued".into();
            record.cache_key = None;
            save(&app, &entry, &record)?;
            app.cover_wake.notify_one();
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    let mime = response
        .headers
        .get("Content-Type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_owned();
    let etag = response
        .headers
        .get("ETag")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = collect_bytes(response.body, POSTER_LIMIT).await?;
    if session.cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut builder = tgdrive_backend_sdk::http::Response::builder()
        .header("Content-Type", mime)
        .header("ETag", &etag)
        .header("Cache-Control", "no-store");
    if headers
        .get("If-None-Match")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| {
            h.split(',')
                .any(|part| part.trim() == "*" || part.trim().trim_start_matches("W/") == etag)
        })
    {
        return builder
            .status(304)
            .body(empty_body())
            .map_err(|_| Error::Protocol("图片响应头无效"));
    }
    let range = if headers
        .get("If-Range")
        .is_some_and(|h| h.to_str().ok() != Some(&etag))
    {
        None
    } else {
        headers.get("Range").and_then(|h| h.to_str().ok())
    };
    let range = match resolve_single_range(range, bytes.len() as u64) {
        Ok(range) => range,
        Err(_) => {
            return builder
                .status(416)
                .header("Content-Range", format!("bytes */{}", bytes.len()))
                .body(empty_body())
                .map_err(|_| Error::Protocol("图片范围响应无效"));
        }
    };
    builder = builder
        .status(if range.partial { 206 } else { 200 })
        .header("Content-Length", range.length)
        .header("Accept-Ranges", "bytes");
    if range.partial {
        builder = builder.header(
            "Content-Range",
            format!(
                "bytes {}-{}/{}",
                range.start,
                range.start + range.length - 1,
                bytes.len()
            ),
        );
    }
    let body = if *method == Method::HEAD {
        empty_body()
    } else {
        let selected = bytes.slice(range.start as usize..(range.start + range.length) as usize);
        let source = record.source.clone();
        stream_body(Box::pin(futures_util::stream::try_unfold(
            (selected, 0usize),
            move |(bytes, offset)| {
                let app = app.clone();
                let entry = entry.clone();
                let source = source.clone();
                let cancel = session.cancel.clone();
                async move {
                    if offset == bytes.len() {
                        return Ok(None);
                    }
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    index::authorized(&app, &entry.file()).await?;
                    if let Some(source) = &source {
                        source_current(&app, &entry, source).await?;
                    }
                    let end = (offset + 64 * 1024).min(bytes.len());
                    Ok(Some((bytes.slice(offset..end), (bytes, end))))
                }
            },
        )))
    };
    builder
        .body(body)
        .map_err(|_| Error::Protocol("图片响应无效"))
}
pub fn plain_image(bytes: Vec<u8>, mime: &str) -> Result<HttpResponse> {
    tgdrive_backend_sdk::http::Response::builder()
        .header("Content-Type", mime)
        .body(bytes_body(bytes))
        .map_err(|_| Error::Protocol("图片响应头无效"))
}
