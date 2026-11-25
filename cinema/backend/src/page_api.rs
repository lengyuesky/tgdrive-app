//! 主人页面专用业务接口；外部客户端永远不能进入这些路由。
use crate::{
    Application,
    catalog::{self, Query},
    covers,
    database::SqlResult,
    index, media,
    model::*,
    wire,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::Arc;
use tgdrive_backend_sdk::{Error, HttpResponse, Result, http::Method, json_response};
use tgdrive_contract::{error_code, files::*};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn missing() -> Error {
    Error::api(error_code::NOT_FOUND, "主人页面接口不存在")
}
async fn node(app: &Application, reference: NodeReference) -> Result<FileNode> {
    let node = app.host.stat(reference).await?;
    // 新建媒体库时，主人可以核对尚未入库但已获宿主授权的目录；这不授予新目录权限。
    if node.kind == NodeKind::Directory {
        return Ok(node);
    }
    for library in app.db.libraries()? {
        if let Ok(root) = app
            .host
            .stat(NodeReference::Id {
                id: library.root_id,
                content_version: None,
            })
            .await
            && within(&node.path, &root.path)
        {
            return Ok(node);
        }
    }
    Err(Error::api(error_code::NOT_FOUND, "内容不在影视媒体库中"))
}
fn entry(app: &Application, id: &str) -> Result<Entry> {
    app.db
        .entry(id)?
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视视频不存在"))
}
fn record(app: &Application, key: &str) -> Result<Value> {
    if let Some(id) = key.strip_prefix("progress:") {
        let e = entry(app, id)?;
        let p = app.db.get::<Progress>("progress", &e.media_guid)?;
        let revision = app.db.with(|db| {
            db.query_row(
                "SELECT revision FROM progress WHERE media_guid=?1",
                [&e.media_guid],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()
        })?;
        // 番号电影的完成状态属于版本；其余电影和电视剧沿用原有的已看标记语义。
        let completed = if e.kind == "Movie" && !e.number.trim().is_empty() {
            p.as_ref().is_some_and(|progress| progress.completed)
        } else {
            wire::watched(app, &e)?
        };
        let Some(p) = p else {
            return Ok(Value::Null);
        };
        let info = media::cached_sync(app, &e)?;
        let audio = p.page_audio.or_else(|| {
            info.as_ref().and_then(|info| {
                let (_, audios, _) = wire::streams(&e, info);
                audios
                    .iter()
                    .position(|stream| stream["guid"] == p.audio_guid)
                    .map(|index| index as u32)
            })
        });
        let subtitle = p
            .page_subtitle
            .or_else(|| {
                e.subtitles
                    .iter()
                    .find(|source| source.guid("subtitle") == p.subtitle_guid)
                    .map(|source| format!("file:{}", source.id))
            })
            .unwrap_or_default();
        return Ok(
            json!({"key":key,"revision":revision,"value":{"file":app.db.node(&e.node_id)?,"seconds":p.ts,"duration":p.duration,"completed":completed,"audio":audio,"subtitle":subtitle}}),
        );
    }
    if let Some(id) = key.strip_prefix("favorite:") {
        let e = entry(app, id)?;
        let (favorite, _) = app.db.flags(&e.guid)?;
        if !favorite {
            return Ok(Value::Null);
        }
        let revision = app.db.with(|db| {
            db.query_row(
                "SELECT revision FROM flags WHERE target=?1",
                [&e.guid],
                |r| r.get::<_, String>(0),
            )
            .app()
        })?;
        return Ok(
            json!({"key":key,"revision":revision,"value":{"file":app.db.node(&e.node_id)?}}),
        );
    }
    if key == "preferences" || key.starts_with("series:") {
        return app.db.preference_record(key);
    }
    Err(Error::api(
        error_code::INVALID_REQUEST,
        "影视业务记录键无效",
    ))
}
pub async fn request(
    app: Arc<Application>,
    method: &Method,
    path: &str,
    value: &Value,
) -> Result<HttpResponse> {
    match (method.as_str(), path) {
        ("GET", "/owner/revision") => {
            return json_response(200, &json!({"revision":app.db.data_revision()?}));
        }
        ("GET", "/owner/config") => return json_response(200, &app.configuration().await?),
        ("PUT", "/owner/account") => {
            app.configure_account(
                text(value, "revision"),
                text(value, "username"),
                text(value, "password"),
            )
            .await?;
            return json_response(200, &app.configuration().await?);
        }
        ("PUT", "/owner/libraries") => {
            let libraries: Vec<Library> = serde_json::from_value(value["libraries"].clone())?;
            app.configure_libraries(text(value, "revision"), libraries)
                .await?;
            app.index_wake.notify_one();
            return json_response(200, &app.configuration().await?);
        }
        ("POST", "/owner/service/start") => {
            app.start_service(text(value, "revision")).await?;
            return json_response(200, &app.configuration().await?);
        }
        ("POST", "/owner/service/stop") => {
            app.stop_service(text(value, "revision")).await?;
            return json_response(200, &app.configuration().await?);
        }
        ("GET", "/owner/status") => {
            return json_response(
                200,
                &json!({"running":app.db.settings()?.running,"index":index::state(&app)?,"covers":covers::status(&app)?,"limits":media::limits()}),
            );
        }
        ("POST", "/owner/index/refresh") => {
            app.synchronize(true).await?;
            covers::schedule(&app, true)?;
            return json_response(200, &index::state(&app)?);
        }
        _ => {}
    }
    // 列表与读操作先核对持久变更，事件仅负责唤醒，不能成为撤权的唯一依据。
    if !matches!(path, "/owner/files/stat" | "/owner/play/quit") {
        index::synchronize_read(&app).await?;
    }
    match (method.as_str(), path) {
        ("POST", "/owner/catalog") => {
            let query: Query = serde_json::from_value(value.clone())?;
            let page = catalog::list(&app, &query, 0)?;
            let mut items = Vec::new();
            let mut descriptions = serde_json::Map::new();
            for id in &page.ids {
                let e = entry(&app, id)?;
                let node = index::authorized(&app, &e.file()).await?;
                descriptions.insert(e.node_id.clone(),json!({"title":e.title,"year":e.year,"number":e.number,"kind":if e.kind=="Movie"{"movie"}else if e.kind=="Episode"{"episodedetails"}else{"video"},"cover_key":e.cover}));
                items.push(node);
            }
            return json_response(
                200,
                &json!({"items":items,"descriptions":descriptions,"total":page.total,"next_cursor":page.next_cursor}),
            );
        }
        ("POST", "/owner/files/stat") => {
            let reference: NodeReference = serde_json::from_value(value.clone())?;
            return json_response(200, &node(&app, reference).await?);
        }
        ("POST", "/owner/files/list") => {
            return json_response(
                200,
                &crate::page_files::directory(
                    &app,
                    text(value, "path"),
                    text(value, "library_id"),
                    value["limit"].as_u64().unwrap_or(48) as usize,
                    value["cursor"].as_str(),
                )
                .await?,
            );
        }
        ("POST", "/owner/playlist") => {
            return json_response(
                200,
                &crate::page_files::playlist(
                    &app,
                    text(value, "id"),
                    text(value, "library_id"),
                    value["limit"].as_u64().unwrap_or(100) as usize,
                    value["cursor"].as_str(),
                )
                .await?,
            );
        }
        ("POST", "/owner/play/neighbor") => {
            return json_response(
                200,
                &json!({"file":crate::page_files::neighbor(&app,text(value,"id"),text(value,"library_id"),value["delta"].as_i64().unwrap_or(0)).await?}),
            );
        }
        ("POST", "/owner/versions") => {
            let id = text(value, "id");
            let library = text(value, "library_id");
            let representative = app
                .db
                .representative_entry(id, library)?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影片版本不存在"))?;
            let default = app
                .db
                .default_entry(&representative.guid, library)?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影片默认版本不存在"))?;
            let mut versions = Vec::new();
            for entry in app.db.versions(&representative.guid, library)? {
                let file = index::authorized(&app, &entry.file()).await?;
                versions.push(
                    json!({"media_guid":entry.media_guid,"name":entry.version_name,"file":file}),
                );
            }
            return json_response(
                200,
                &json!({"item_guid":representative.guid,"representative_media_guid":representative.media_guid,"default_media_guid":default.media_guid,"versions":versions}),
            );
        }
        ("POST", "/owner/description") => {
            let e = entry(&app, text(value, "id"))?;
            let representative = app
                .db
                .representative_entry(text(value, "id"), text(value, "library_id"))?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视条目不存在"))?;
            index::authorized(&app, &e.file()).await?;
            index::authorized(&app, &representative.file()).await?;
            return json_response(
                200,
                &json!({"title":representative.title,"overview":representative.overview,"year":representative.year,"number":representative.number,"kind":if representative.kind=="Movie"{"movie"}else if representative.kind=="Episode"{"episodedetails"}else{"video"},"cover_key":representative.cover,"subtitles":e.subtitles}),
            );
        }
        ("POST", "/owner/media") => {
            let e = entry(&app, text(value, "id"))?;
            return json_response(200, &media::probe(&app, &e, app.shutdown_token()).await?);
        }
        ("POST", "/owner/cover") => {
            let e = app
                .db
                .representative_entry(text(value, "id"), text(value, "library_id"))?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视条目封面不存在"))?;
            return json_response(200, &json!({"key":covers::page_key(&app,&e).await?}));
        }
        ("POST", "/owner/flags/get") => {
            let e = app
                .db
                .default_entry(text(value, "id"), text(value, "library_id"))?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视观看标记不存在"))?;
            index::authorized(&app, &e.file()).await?;
            let revision: Option<String> = app.db.with(|db| {
                db.query_row(
                    "SELECT revision FROM flags WHERE target=?1",
                    [&e.guid],
                    |row| row.get(0),
                )
                .optional()
                .app()
            })?;
            return json_response(
                200,
                &json!({"watched":wire::watched(&app,&e)?,"revision":revision}),
            );
        }
        ("POST", "/owner/flags/watched") => {
            let e = entry(&app, text(value, "id"))?;
            index::authorized(&app, &e.file()).await?;
            let watched = value["watched"]
                .as_bool()
                .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "已看标记必须为布尔值"))?;
            app.db
                .set_watched_cas(&e.guid, watched, value["revision"].as_str())?;
            return json_response(200, &json!({"ok":true}));
        }
        ("POST", "/owner/history/clear") => {
            // 清空包含离库的保留历史，同时撤掉旧播放权威，避免在途上报立即复活已删除记录。
            app.db.with(|db| {
                db.execute_batch(
                    "BEGIN IMMEDIATE; DELETE FROM progress; DELETE FROM play_authority; COMMIT;",
                )
                .app()
            })?;
            return json_response(200, &json!({"ok":true}));
        }
        ("POST", "/owner/storage/get") => {
            let key = text(value, "key");
            if let Some(id) = key
                .strip_prefix("progress:")
                .or_else(|| key.strip_prefix("favorite:"))
            {
                let e = entry(&app, id)?;
                index::authorized(&app, &e.file()).await?;
            }
            return json_response(200, &record(&app, key)?);
        }
        ("POST", "/owner/storage/list") => {
            let prefix = text(value, "prefix");
            if !matches!(prefix, "progress:" | "favorite:") {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "影视列表记录类型无效",
                ));
            }
            let query = Query {
                history: prefix == "progress:",
                favorite: prefix == "favorite:",
                raw_files: true,
                ancestor: text(value, "library_id").into(),
                limit: value["limit"].as_u64().unwrap_or(48) as usize,
                cursor: value["cursor"].as_str().map(str::to_owned),
                sort_column: "create_time".into(),
                descending: true,
                ..Default::default()
            };
            let page = catalog::list(&app, &query, 0)?;
            let mut records = Vec::new();
            for id in page.ids {
                let e = if prefix == "progress:" {
                    app.db
                        .default_entry(&id, text(value, "library_id"))?
                        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影片观看记录不存在"))?
                } else {
                    entry(&app, &id)?
                };
                let node = index::authorized(&app, &e.file()).await?;
                let key = if prefix == "favorite:" {
                    &e.guid
                } else {
                    &e.node_id
                };
                let mut r = record(&app, &format!("{prefix}{key}"))?;
                if !r.is_null() {
                    r["value"]["file"] = serde_json::to_value(node)?;
                    if e.kind == "Movie" && !e.number.trim().is_empty() {
                        // 全局记录保留番号条目所属的库，不能因重叠根而切到另一个库的同号条目。
                        r["library_id"] = json!(e.libraries[0]);
                    }
                    records.push(r);
                }
            }
            return json_response(
                200,
                &json!({"records":records,"total":page.total,"next_cursor":page.next_cursor}),
            );
        }
        ("POST", "/owner/play/start") => {
            let e = entry(&app, text(value, "id"))?;
            index::authorized(&app, &e.file()).await?;
            let timestamp = now();
            let _ = media::probe(&app, &e, app.shutdown_token()).await?;
            let id = random_id();
            let mut plays = app.page_plays.lock().unwrap_or_else(|e| e.into_inner());
            plays.retain(|_, (_, _, expiry)| *expiry > timestamp);
            if plays.len() >= 128 {
                return Err(Error::api(error_code::QUOTA_EXCEEDED, "页面播放会话过多"));
            }
            let serial = app
                .db
                .activate_at(&e.media_guid, timestamp)?
                .ok_or_else(|| {
                    Error::api(error_code::STORAGE_CONFLICT, "另一个客户端已开始较新的播放")
                })?;
            app.service.pause_background();
            plays.insert(
                id.clone(),
                (e.media_guid, serial, timestamp + 6 * 60 * 60 * 1000),
            );
            return json_response(200, &json!({"play_id":id}));
        }
        ("POST", "/owner/play/quit") => {
            app.page_plays
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(text(value, "play_id"));
            return json_response(200, &json!({"ok":true}));
        }
        ("POST", "/owner/storage/set") => {
            let key = text(value, "key");
            let expected = value["revision"].as_str();
            let data = &value["value"];
            if let Some(id) = key.strip_prefix("progress:") {
                let e = entry(&app, id)?;
                let play = app
                    .page_plays
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(text(value, "play_id"))
                    .cloned()
                    .filter(|(media, _, expiry)| media == &e.media_guid && *expiry > now())
                    .ok_or_else(|| {
                        Error::api(
                            error_code::STORAGE_CONFLICT,
                            "页面播放会话已结束或失去进度权威",
                        )
                    })?;
                let info = media::probe(&app, &e, app.shutdown_token()).await?;
                let (_, audios, _) = wire::streams(&e, &info);
                let page_audio = data["audio"]
                    .as_u64()
                    .and_then(|index| u32::try_from(index).ok());
                if page_audio.is_some_and(|index| index as usize >= audios.len())
                    || data["subtitle"].as_str().is_some_and(|key| key.len() > 128)
                {
                    return Err(Error::api(
                        error_code::INVALID_REQUEST,
                        "页面选择的媒体轨道无效",
                    ));
                }
                let subtitle = data["subtitle"].as_str().unwrap_or_default();
                let subtitle_guid = e
                    .subtitles
                    .iter()
                    .find(|source| subtitle == format!("file:{}", source.id))
                    .map(|source| source.guid("subtitle"))
                    .unwrap_or_default();
                let seconds = data["seconds"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0 && *n <= info.duration + 2.0)
                    .ok_or_else(|| {
                        Error::api(error_code::INVALID_REQUEST, "页面观看位置超出真实时长")
                    })?;
                let p = Progress {
                    ts: seconds,
                    duration: info.duration,
                    completed: data["completed"].as_bool().unwrap_or(false),
                    updated_at: now(),
                    page_audio,
                    page_subtitle: data["subtitle"].as_str().map(str::to_owned),
                    audio_guid: page_audio
                        .and_then(|index| audios.get(index as usize))
                        .and_then(|stream| stream["guid"].as_str())
                        .unwrap_or_default()
                        .into(),
                    subtitle_guid,
                    direct_link_audio_index: page_audio.map(i64::from).unwrap_or(0),
                };
                if !app.db.save_progress(&e.media_guid, play.1, &p)? {
                    return Err(Error::api(
                        error_code::STORAGE_CONFLICT,
                        "另一播放会话已开始，旧页面进度未覆盖它",
                    ));
                }
            } else if let Some(id) = key.strip_prefix("favorite:") {
                let e = entry(&app, id)?;
                let current = record(&app, key)?;
                if current["revision"].as_str() != expected {
                    return Err(Error::api(error_code::STORAGE_CONFLICT, "收藏状态已改变"));
                }
                app.db.set_favorite_cas(&e.guid, true, expected)?;
            } else if key == "preferences" || key.starts_with("series:") {
                if key.len() > 128 || serde_json::to_vec(data)?.len() > 8192 {
                    return Err(Error::api(
                        error_code::PAYLOAD_TOO_LARGE,
                        "播放偏好超过预算",
                    ));
                }
                app.db.preference(key, data, expected)?;
            } else {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "影视业务记录键无效",
                ));
            }
            return json_response(200, &record(&app, key)?);
        }
        ("POST", "/owner/storage/delete") => {
            let key = text(value, "key");
            let current = record(&app, key)?;
            if current.is_null() || current["revision"].as_str() != value["revision"].as_str() {
                return Err(Error::api(error_code::STORAGE_CONFLICT, "影视记录已改变"));
            }
            if let Some(id) = key.strip_prefix("favorite:") {
                let e = entry(&app, id)?;
                app.db
                    .set_favorite_cas(&e.guid, false, value["revision"].as_str())?;
            } else if let Some(id) = key.strip_prefix("progress:") {
                let e = entry(&app, id)?;
                app.db.with(|db| {
                    if db
                        .execute(
                            "DELETE FROM progress WHERE media_guid=?1 AND revision=?2",
                            params![e.media_guid, text(value, "revision")],
                        )
                        .app()?
                        != 1
                    {
                        return Err(Error::api(error_code::STORAGE_CONFLICT, "观看记录已改变"));
                    }
                    Ok(())
                })?;
            } else {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "不能删除此播放记录",
                ));
            }
            return json_response(200, &json!({"ok":true}));
        }
        ("POST", "/owner/actors") => {
            return json_response(
                200,
                &crate::persons::cast(&app, text(value, "id"), value).await?,
            );
        }
        ("POST", "/owner/item") => {
            return json_response(
                200,
                &wire::catalog_item(&app, text(value, "id"))?.ok_or_else(missing)?,
            );
        }
        _ => {}
    }
    Err(missing())
}
