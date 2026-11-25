//! 飞牛影视兼容服务的外部协议，绝不把外部调用方解释为主人。
use crate::{
    Application,
    catalog::{self, Query},
    covers, index, media,
    model::*,
    persons,
    service::Session,
    wire,
};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::sync::Arc;
use tgdrive_backend_sdk::{
    Error, HttpResponse, Result, empty_body,
    http::{HeaderMap, Method},
    json_response, stream_response,
};
use tgdrive_contract::{
    error_code,
    files::*,
    runtime::{ForwardContext, ForwardEntry},
};

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn envelope(value: Value) -> Result<HttpResponse> {
    json_response(200, &json!({"code":0,"msg":"","data":value}))
}
pub fn token(headers: &HeaderMap, entry: ForwardEntry) -> Option<String> {
    if headers.get_all("Authorization").iter().count() > 1 {
        return None;
    }
    if let Some(value) = headers
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .filter(|s| s.len() <= 135)
    {
        return Some(value.strip_prefix("Bearer ").unwrap_or(value).into());
    }
    if entry != ForwardEntry::Root {
        return None;
    }
    headers
        .get("Cookie")
        .and_then(|h| h.to_str().ok())
        .filter(|s| s.len() <= 4096)
        .and_then(|s| {
            s.split(';')
                .map(str::trim)
                .find_map(|part| part.strip_prefix("Trim-MC-token="))
        })
        .map(str::to_owned)
}
pub async fn request(
    app: Arc<Application>,
    context: &ForwardContext,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    value: &Value,
) -> Result<HttpResponse> {
    let result = inner(app, context, method, path, headers, value).await;
    match result {
        Ok(mut response) => {
            response
                .headers_mut()
                .insert("Cache-Control", "no-store".parse().unwrap());
            Ok(response)
        }
        Err(error) => error_response(&error),
    }
}
pub fn error_response(error: &Error) -> Result<HttpResponse> {
    let status = match error.code() {
        error_code::SCOPE_DENIED
        | error_code::APP_CHANGED
        | error_code::APP_DISABLED
        | error_code::SESSION_EXPIRED => 401,
        _ => tgdrive_contract::error_http_status(error.code()).unwrap_or(500),
    };
    let message = match error {
        Error::Api { error, .. } => error.message.as_str(),
        _ => "影视请求未完成",
    };
    let mut response = json_response(status, &json!({"code":status,"msg":message,"data":null}))?;
    response
        .headers_mut()
        .insert("Cache-Control", "no-store".parse().unwrap());
    Ok(response)
}
async fn inner(
    app: Arc<Application>,
    context: &ForwardContext,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    value: &Value,
) -> Result<HttpResponse> {
    if path.starts_with("/owner/") {
        return Err(Error::api(
            error_code::NOT_FOUND,
            "主人页面接口不属于对外服务",
        ));
    }
    let settings = app.db.settings()?;
    if !settings.running {
        return Err(Error::api(
            error_code::UNAUTHORIZED,
            "飞牛影视兼容服务尚未启动",
        ));
    }
    let read = matches!(*method, Method::GET | Method::HEAD);
    if read {
        match path {
            "/trimcon" => return envelope(json!({})),
            "/v/api/v1/sys/version" => {
                return envelope(json!({"version":"0.9.7","mediasrvVersion":"0.8.35"}));
            }
            "/v/api/v1/sys/config" => return envelope(json!({"initialized":true})),
            _ => {}
        }
    }
    if path == "/v/api/v2/user/loginByPassword" {
        if *method != Method::POST {
            return Err(Error::api(
                error_code::METHOD_NOT_ALLOWED,
                "影视登录需要 POST",
            ));
        }
        return login(&app, value).await;
    }
    let token = token(headers, context.entry)
        .ok_or_else(|| Error::api(error_code::UNAUTHORIZED, "请先登录影视连接账号"))?;
    let session = app.service.authenticate(&token)?;
    let byte_request = path.starts_with("/v/api/v1/media/range/")
        || path.starts_with("/v/api/v1/subtitle/dl/")
        || path.starts_with("/v/api/v1/sys/img/")
        || path.starts_with("/tgdrive-poster/")
        || path.starts_with("/tgdrive-person/");
    if !byte_request {
        index::synchronize_read(&app).await?;
    }
    if session.cancel.is_cancelled() {
        return Err(Error::api(error_code::UNAUTHORIZED, "影视登录会话已撤销"));
    }
    if read {
        return read_request(app, method, path, headers, &token, session).await;
    }
    if !value.is_object() {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "影视请求正文必须为对象",
        ));
    }
    if *method != Method::POST
        && !(matches!(*method, Method::PUT | Method::DELETE)
            && matches!(path, "/v/api/v1/item/favorite" | "/v/api/v1/item/watched"))
    {
        return Err(Error::api(
            error_code::METHOD_NOT_ALLOWED,
            "不支持的影视协议方法",
        ));
    }
    post_request(app, method, path, &token, session, value).await
}
async fn login(app: &Application, value: &Value) -> Result<HttpResponse> {
    for lease in app.service.expired() {
        app.host.revoke_read_lease(lease).await?;
    }
    app.service.login_budget()?;
    let _slot = app
        .login_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::api(error_code::RATE_LIMITED, "影视登录正忙，请稍后重试"))?;
    let settings = app.db.settings()?;
    let epoch = app.service.epoch();
    let candidate = string(value, "password");
    if string(value, "username") != settings.username
        || candidate.len() != 64
        || !candidate.bytes().all(|b| b.is_ascii_hexdigit())
        || settings.verifier.is_empty()
    {
        return Err(Error::api(
            error_code::UNAUTHORIZED,
            "影视连接账号或密码无效",
        ));
    }
    let configured = app.configuration().await?;
    if !configured["libraries"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(|l| l["authorized"] == true))
    {
        return Err(Error::api(
            error_code::UNAUTHORIZED,
            "没有可访问的影视媒体库",
        ));
    }
    let verifier = settings.verifier.clone();
    let candidate = candidate.to_ascii_lowercase();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&verifier).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(candidate.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::Protocol("影视密码校验失败"))?;
    if !valid {
        return Err(Error::api(
            error_code::UNAUTHORIZED,
            "影视连接账号或密码无效",
        ));
    }
    let latest = app.db.settings()?;
    if latest.revision != settings.revision || !latest.running || app.service.epoch() != epoch {
        return Err(Error::api(
            error_code::UNAUTHORIZED,
            "影视配置已改变，请重新登录",
        ));
    }
    let lease = app
        .host
        .create_read_lease(CreateReadLeaseRequest {
            ttl_seconds: 6 * 60 * 60,
        })
        .await?;
    let token = match app.service.login(epoch, lease.clone()) {
        Ok(token) => token,
        Err(error) => {
            let _ = app.host.revoke_read_lease(lease.id).await;
            return Err(error);
        }
    };
    envelope(json!({"token":token}))
}
async fn library(app: &Application, reference: &str) -> Result<Option<Value>> {
    let config = app.configuration().await?;
    let found = config["libraries"].as_array().and_then(|l| {
        l.iter()
            .find(|l| l["id"] == reference && l["authorized"] == true)
    });
    Ok(found.map(|library|{
        let posters=app.db.with(|db|{use crate::database::SqlResult;let mut s=db.prepare("SELECT c.cache_key FROM cover_states c JOIN entries e ON e.media_guid=c.media_guid JOIN catalog i ON i.representative=e.node_id AND i.kind NOT IN ('TV','Season') JOIN catalog_libraries l ON l.guid=i.guid WHERE l.library_id=?1 AND c.state='ready' ORDER BY e.season,e.episode,i.guid LIMIT 4").app()?;s.query_map([reference],|r|r.get::<_,String>(0)).app()?.collect::<rusqlite::Result<Vec<_>>>().app()}).unwrap_or_default();
        json!({"guid":reference,"title":library["name"],"category":if library["kind"]=="movie"{"Movie"}else{"TV"},"view_type":0,"posters":posters.iter().map(|key|format!("/tgdrive-poster/{key}")).collect::<Vec<_>>()})
    }))
}
fn required_entry(app: &Application, reference: &str, groups: bool) -> Result<Entry> {
    if let Some(entry) = app.db.entry(reference)? {
        return Ok(entry);
    }
    if groups
        && let Some(catalog) = app.db.catalog(reference)?
        && matches!(catalog.kind.as_str(), "TV" | "Season")
        && let Some(entry) = app.db.entry(&catalog.representative)?
    {
        return Ok(entry);
    }
    Err(Error::api(error_code::NOT_FOUND, "影视播放目标不存在"))
}
async fn read_request(
    app: Arc<Application>,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    _token: &str,
    session: Session,
) -> Result<HttpResponse> {
    match path {
        "/v/api/v1/user/info" => {
            let username = app.db.settings()?.username;
            return envelope(
                json!({"guid":guid(&["user",&username]),"username":username,"is_admin":0}),
            );
        }
        "/v/api/v1/mediadb/list" => {
            let mut rows = Vec::new();
            for l in app.db.libraries()? {
                if let Some(info) = library(&app, &l.id).await? {
                    rows.push(info);
                }
            }
            return envelope(json!(rows));
        }
        "/v/api/v1/mediadb/sum" => {
            let mut value=app.db.with(|db|{use crate::database::SqlResult;let movies:i64=db.query_row("SELECT count(*) FROM catalog WHERE kind='Movie'",[],|r|r.get(0)).app()?;let tv:i64=db.query_row("SELECT count(*) FROM catalog WHERE kind='TV'",[],|r|r.get(0)).app()?;let other:i64=db.query_row("SELECT count(*) FROM catalog WHERE kind='Video'",[],|r|r.get(0)).app()?;Ok(json!({"total":movies+tv+other,"movie":movies,"tv":tv,"live":0,"other":other,"Movie":movies,"TV":tv,"Video":other,"Directory":0}))})?;
            for l in app.db.libraries()? {
                let count = app.db.with(|db| {
                    use crate::database::SqlResult;
                    db.query_row(
                        "SELECT count(DISTINCT item_guid) FROM entry_libraries WHERE library_id=?1",
                        [&l.id],
                        |r| r.get::<_, i64>(0),
                    )
                    .app()
                })?;
                value[&l.id] = json!(count);
            }
            return envelope(value);
        }
        "/v/api/v1/play/list" => {
            let page = catalog::list(
                &app,
                &Query {
                    history: true,
                    raw_files: true,
                    limit: 100,
                    ..Default::default()
                },
                0,
            )?;
            let mut list = Vec::new();
            for id in page.ids {
                if let Some(mut row) = wire::catalog_item(&app, &id)? {
                    let e = app
                        .db
                        .default_entry(&id, "")?
                        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "最近播放的影片不存在"))?;
                    row["ts"] = json!(app.db.progress(&e)?.ts as u64);
                    list.push(row);
                }
            }
            return envelope(json!(list));
        }
        "/v/api/v1/tag/genres"
        | "/v/api/v1/tag/iso3166"
        | "/v/api/v1/tag/iso6392"
        | "/v/api/v1/tag/iso6391" => return envelope(json!([])),
        "/v/api/v1/tag/list" => {
            return envelope(
                json!({"genres":[],"resolutions":[],"color_range":[],"audio_type":[],"locate":[],"decades":[],"recognition_status":[]}),
            );
        }
        _ => {}
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/person/list/") {
        return envelope(persons::cast(&app, id, &json!({})).await?);
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/person/") {
        return envelope(persons::detail(&app, id).await?);
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/mdb/") {
        return envelope(
            library(&app, id)
                .await?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视媒体库不可用"))?,
        );
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/item/") {
        if let Some(info) = library(&app, id).await? {
            return envelope(
                json!({"guid":id,"title":info["title"],"type":"Directory","ancestor_guid":id,"ancestor_name":info["title"],"ancestor_category":info["category"],"parent_guid":"","grand_guid":"","can_play":0,"play_error":"","play_item_guid":"","media_guid":"","single_child_guid":"","file_name":"","duration":0,"logic_type":0,"is_favorite":0,"is_watched":0,"watched":0,"watched_ts":0,"poster":"","posters":"","vote_average":"0","poster_list":info["posters"],"tv_title":"","parent_title":"","genres":[],"overview":""}),
            );
        }
        return envelope(
            wire::catalog_item(&app, id)?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视条目不存在"))?,
        );
    }
    for (prefix, kind) in [
        ("/v/api/v1/season/list/", "Season"),
        ("/v/api/v1/episode/list/", "Episode"),
    ] {
        if let Some(id) = path.strip_prefix(prefix) {
            let mut entries = app.db.entries_for_group(id)?;
            entries.sort_by_key(|e| (e.season, e.episode));
            let mut rows = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for e in entries {
                let id = if kind == "Season" {
                    e.season_guid()
                } else {
                    e.guid.clone()
                };
                if seen.insert(id.clone())
                    && let Some(row) = wire::catalog_item(&app, &id)?
                {
                    rows.push(row);
                }
            }
            return envelope(json!(rows));
        }
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/stream/list/") {
        let representative = required_entry(&app, id, true)?;
        let entries = app.db.versions(&representative.guid, "")?;
        let (mut files, mut videos, mut audios, mut subtitles) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        // 文件列表与三类流都覆盖整个条目，各流的 media_guid 明确指向自己的文件。
        for entry in entries {
            let info = media::probe(&app, &entry, &session.cancel).await?;
            files.push(wire::file(&entry));
            let (video, audio, subtitle) = wire::streams(&entry, &info);
            videos.extend(video);
            audios.extend(audio);
            subtitles.extend(subtitle);
        }
        return envelope(
            json!({"files":files,"video_streams":videos,"audio_streams":audios,"subtitle_streams":subtitles}),
        );
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/media/range/") {
        app.service.pause_background();
        let entry = required_entry(&app, id, false)?;
        let node = index::authorized(&app, &entry.file()).await?;
        let token = _token;
        let correlation = app.service.correlation(token, &entry)?;
        if session.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        return stream_response(
            method,
            &StreamDirective {
                file: entry.file(),
                window: None,
                range: RangePolicy::Client,
                disposition: Disposition::Inline,
                filename: Some(node.name),
                content_type: Some(mime(&entry.filename).into()),
                cache: StreamCachePolicy::PrivateRevalidate,
                lease_id: Some(session.lease.id),
                correlation_id: Some(correlation),
            },
            node.size.0,
        );
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/subtitle/dl/") {
        let attachment = app.db.with(|db| {
            use crate::database::SqlResult;
            db.query_row("SELECT entry_id,document FROM attachments WHERE guid=?1 ORDER BY entry_id LIMIT 1", [id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().app()
        })?.ok_or_else(|| Error::api(error_code::NOT_FOUND,"影视字幕不存在"))?;
        let source = (
            required_entry(&app, &attachment.0, false)?,
            serde_json::from_str::<Source>(&attachment.1)?,
        );
        let video = index::authorized(&app, &source.0.file()).await?;
        let node = index::authorized(&app, &source.1.file()).await?;
        if node.parent_id != video.parent_id {
            return Err(Error::api(error_code::NOT_FOUND, "字幕已移出视频目录"));
        }
        if session.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        return stream_response(
            method,
            &StreamDirective {
                file: source.1.file(),
                window: None,
                range: RangePolicy::Client,
                disposition: Disposition::Inline,
                filename: Some(node.name),
                content_type: Some(
                    if extension(&source.1.name) == "srt" {
                        "application/x-subrip; charset=utf-8"
                    } else if extension(&source.1.name) == "vtt" {
                        "text/vtt; charset=utf-8"
                    } else {
                        "text/plain; charset=utf-8"
                    }
                    .into(),
                ),
                cache: StreamCachePolicy::NoStore,
                lease_id: Some(session.lease.id),
                correlation_id: None,
            },
            node.size.0,
        );
    }
    if let Some(id) = path
        .strip_prefix("/v/api/v1/sys/img/tgdrive-person/")
        .or_else(|| path.strip_prefix("/tgdrive-person/"))
    {
        return persons::image(app, id, method, session).await;
    }
    if let Some(id) = path
        .strip_prefix("/v/api/v1/sys/img/tgdrive-poster/")
        .or_else(|| path.strip_prefix("/tgdrive-poster/"))
    {
        let entry=app.db.with(|db|{use crate::database::SqlResult;db.query_row("SELECT e.node_id FROM entries e JOIN cover_states c ON c.media_guid=e.media_guid WHERE c.cache_key=?1",[id],|r|r.get::<_,String>(0)).optional().app()})?.and_then(|id|app.db.entry(&id).ok().flatten()).ok_or_else(||Error::api(error_code::NOT_FOUND,"影视封面不存在"))?;
        return covers::response(app, entry, id, headers, method, session).await;
    }
    Err(Error::api(error_code::NOT_FOUND, "影视协议接口不存在"))
}
async fn post_request(
    app: Arc<Application>,
    method: &Method,
    path: &str,
    token: &str,
    session: Session,
    value: &Value,
) -> Result<HttpResponse> {
    if path == "/v/api/v1/user/logout" {
        if let Some(lease) = app.service.logout(token) {
            app.host.revoke_read_lease(lease).await?;
        }
        return envelope(json!(true));
    }
    if path == "/v/api/v1/person/item/list" {
        return envelope(persons::works(&app, value).await?);
    }
    if let Some(id) = path.strip_prefix("/v/api/v1/person/list/") {
        return envelope(persons::cast(&app, id, value).await?);
    }
    if matches!(path, "/v/api/v1/user/getData" | "/v/api/v1/user/setData") {
        let key = string(value, "key");
        let library = string(value, "mdb_guid");
        if key.is_empty()
            || key.len() > 128
            || !library.is_empty() && !app.db.libraries()?.iter().any(|l| l.id == library)
        {
            return Err(Error::api(
                error_code::INVALID_REQUEST,
                "影视偏好键或媒体库无效",
            ));
        }
        let stored_key = format!("fntv:{}", guid(&[library, key]));
        if path.ends_with("getData") {
            let record = app.db.preference_record(&stored_key)?;
            return if record.is_null() {
                json_response(200, &json!({"code":-6,"msg":"","data":null}))
            } else {
                envelope(json!({"key":key,"mdb_guid":library,"value":record["value"]}))
            };
        }
        let preference = value["value"]
            .as_str()
            .filter(|s| s.len() <= 8192)
            .ok_or_else(|| {
                Error::api(
                    error_code::INVALID_REQUEST,
                    "影视偏好需为不超过 8 KiB 的字符串",
                )
            })?;
        let record = app.db.preference_record(&stored_key)?;
        app.db
            .preference(&stored_key, &preference, record["revision"].as_str())?;
        return envelope(json!(true));
    }
    if matches!(path, "/v/api/v1/item/list" | "/v/api/v1/favorite/list") {
        let (mut query, skip) = Query::from_fntv(value, 128)?;
        query.favorite = path.ends_with("favorite/list");
        let page = catalog::list(&app, &query, skip)?;
        let list = page
            .ids
            .iter()
            .filter_map(|id| wire::catalog_item(&app, id).transpose())
            .collect::<Result<Vec<_>>>()?;
        let library = app
            .db
            .libraries()?
            .into_iter()
            .find(|l| l.id == query.ancestor);
        let response = json!({"mdb_name":library.as_ref().map(|l|l.name.as_str()).unwrap_or(""),"mdb_category":library.as_ref().map(|l|if l.kind=="movie"{"Movie"}else{"TV"}).unwrap_or(""),"top_dir":"","dir":"","total":page.total,"jump_list":[],"list":list});
        if serde_json::to_vec(&response)?.len() > 8 * 1024 * 1024 {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "本页影视资料超过响应预算，请减少每页条数",
            ));
        }
        return envelope(response);
    }
    if path == "/v/api/v1/play/quit" {
        let link = string(value, "play_link");
        if link.len() > 128 {
            return Err(Error::api(error_code::INVALID_REQUEST, "播放关联标识过长"));
        }
        app.service.quit(token, link);
        return envelope(json!(true));
    }
    let reference = if !string(value, "media_guid").is_empty() {
        string(value, "media_guid")
    } else {
        string(value, "item_guid")
    };
    if matches!(path, "/v/api/v1/item/favorite" | "/v/api/v1/item/watched") {
        let favorite = path.ends_with("favorite");
        if favorite && !matches!(*method, Method::PUT | Method::DELETE) {
            return Err(Error::api(
                error_code::METHOD_NOT_ALLOWED,
                "收藏需要 PUT 或 DELETE",
            ));
        }
        let target = if let Some(entry) = app.db.entry(reference)? {
            entry.guid
        } else {
            app.db
                .catalog(reference)?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视标记目标不存在"))?
                .guid
        };
        if session.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        app.db
            .set_flag(&target, favorite, *method != Method::DELETE)?;
        return envelope(json!(true));
    }
    let entry = match app
        .db
        .select_entry(string(value, "item_guid"), string(value, "media_guid"))?
    {
        Some(entry) => entry,
        None if string(value, "media_guid").is_empty() && path == "/v/api/v1/play/info" => {
            required_entry(&app, string(value, "item_guid"), true)?
        }
        None => return Err(Error::api(error_code::NOT_FOUND, "影视播放版本不存在")),
    };
    let info = media::probe(&app, &entry, &session.cancel).await?;
    let (videos, audios, subtitles) = wire::streams(&entry, &info);
    match path {
        "/v/api/v1/play/info" => {
            let progress = app.db.progress(&entry)?;
            envelope(
                json!({"guid":entry.guid,"grand_guid":entry.show_guid,"parent_guid":if entry.kind=="Episode"{entry.season_guid()}else{entry.libraries[0].clone()},"type":entry.kind,"media_guid":entry.media_guid,"video_guid":videos.first().and_then(|v|v["guid"].as_str()).unwrap_or(""),"audio_guid":if progress.audio_guid.is_empty(){audios.first().and_then(|v|v["guid"].as_str()).unwrap_or("").to_owned()}else{progress.audio_guid},"subtitle_guid":progress.subtitle_guid,"direct_link_audio_index":progress.direct_link_audio_index,"ts":progress.ts as u64,"play_config":{"skip_opening":null,"skip_ending":null},"item":wire::item(&app,&entry,Some(&info))?}),
            )
        }
        "/v/api/v1/stream" => {
            validate_tracks(value, &videos, &audios, &subtitles)?;
            app.service.select(token, &entry.media_guid)?;
            envelope(
                json!({"file_stream":wire::file(&entry),"video_stream":videos.first(),"audio_streams":audios,"subtitle_streams":subtitles,"qualities":[{"bitrate":0,"resolution":"原画","progressive":false,"is_m3u8":false}],"direct_link_qualities":[],"cloud_storage_info":null}),
            )
        }
        "/v/api/v1/play/play" => {
            validate_tracks(value, &videos, &audios, &subtitles)?;
            app.service.select(token, &entry.media_guid)?;
            envelope(json!({"play_link":random_id()}))
        }
        "/v/api/v1/play/record" => {
            validate_tracks(value, &videos, &audios, &subtitles)?;
            let ts = value["ts"]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= info.duration + 2.0)
                .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "观看位置超出真实时长"))?;
            let link = string(value, "play_link");
            if link.is_empty()
                || link.len() > 128
                || string(value, "item_guid") != entry.guid
                || string(value, "media_guid") != entry.media_guid
            {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "观看记录与媒体身份不匹配",
                ));
            }
            let audio_index = value["direct_link_audio_index"].as_i64().unwrap_or(0);
            if audio_index < -1 || audio_index > audios.len() as i64 {
                return Err(Error::api(error_code::INVALID_REQUEST, "音轨序号无效"));
            }
            if let Some(serial) = app.service.bind_link(token, &entry.media_guid, link)? {
                let subtitle = string(value, "subtitle_guid");
                if session.cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let progress = Progress {
                    ts,
                    audio_guid: string(value, "audio_guid").into(),
                    subtitle_guid: if subtitle == "_no_display_" {
                        ""
                    } else {
                        subtitle
                    }
                    .into(),
                    direct_link_audio_index: audio_index,
                    updated_at: now(),
                    duration: info.duration,
                    completed: ts / info.duration >= 0.95,
                    page_audio: None,
                    page_subtitle: None,
                };
                app.db.save_progress(&entry.media_guid, serial, &progress)?;
            }
            envelope(json!(true))
        }
        _ => Err(Error::api(error_code::NOT_FOUND, "影视协议接口不存在")),
    }
}
fn validate_tracks(
    value: &Value,
    videos: &[Value],
    audios: &[Value],
    subtitles: &[Value],
) -> Result<()> {
    for (key, tracks) in [
        ("video_guid", videos),
        ("audio_guid", audios),
        ("subtitle_guid", subtitles),
    ] {
        let id = string(value, key);
        if !id.is_empty()
            && !(key == "subtitle_guid" && id == "_no_display_")
            && !tracks.iter().any(|v| v["guid"] == id)
        {
            return Err(Error::api(error_code::INVALID_REQUEST, "所选媒体轨道无效"));
        }
    }
    Ok(())
}
pub fn mime(name: &str) -> &'static str {
    match extension(name).as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "ts" | "m2ts" | "mts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}
pub fn empty() -> HttpResponse {
    tgdrive_backend_sdk::http::Response::builder()
        .status(204)
        .body(empty_body())
        .unwrap()
}
