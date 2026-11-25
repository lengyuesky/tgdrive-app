//! 人物只从当前授权且仍与作品关联的资料汇总；头像和简介分别取最近有效来源。
use crate::{
    Application,
    catalog::{self, Query},
    database::SqlResult,
    index,
    model::{Actor, Entry, guid, parent, stem},
    nfo, wire,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use tgdrive_backend_sdk::{
    Error, HttpResponse, ReadOptions, Result, collect_bytes, empty_body, http::Method, stream_body,
};

pub fn identity(actor: &Actor) -> String {
    let data = &actor.data;
    let provider = data.provider.trim();
    let id = data.id.trim();
    if !provider.is_empty()
        && !id.is_empty()
        && !provider.eq_ignore_ascii_case("gfriends")
        && id != data.name.trim()
    {
        guid(&["fntv-person-id-1", &provider.to_ascii_lowercase(), id])
    } else {
        guid(&["fntv-person-name-1", data.name.trim()])
    }
}
async fn valid(app: &Application, entry: &Entry, actor: &mut Actor, is_show: bool) -> Result<bool> {
    let video = index::authorized(app, &entry.file()).await?;
    let metadata = match index::authorized(app, &actor.metadata.file()).await {
        Ok(node) => node,
        Err(error)
            if matches!(
                error.code(),
                tgdrive_contract::error_code::NOT_FOUND
                    | tgdrive_contract::error_code::CONTENT_CHANGED
                    | tgdrive_contract::error_code::SCOPE_DENIED
            ) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let associated = if is_show {
        metadata.name.eq_ignore_ascii_case("tvshow.nfo")
            && metadata
                .parent_id
                .as_ref()
                .is_some_and(|parent| guid(&["show", parent]) == entry.show_guid)
    } else {
        metadata.parent_id == video.parent_id
            && (metadata
                .name
                .eq_ignore_ascii_case(&format!("{}.nfo", stem(&video.name)))
                || metadata
                    .name
                    .eq_ignore_ascii_case(if entry.kind == "Movie" {
                        "movie.nfo"
                    } else {
                        "episodedetails.nfo"
                    }))
    };
    if !associated {
        return Ok(false);
    }
    if let Some(portrait) = &actor.portrait {
        let expected = nfo::local_actor_path(parent(&metadata.path), &actor.data.thumb);
        match index::authorized(app, &portrait.file()).await {
            Ok(node)
                if node.size.0 > 0
                    && node.size.0 <= 2 * 1024 * 1024
                    && expected.as_deref() == Some(node.path.as_str()) => {}
            _ => actor.portrait = None,
        }
    }
    Ok(true)
}
async fn records(app: &Application, id: &str) -> Result<Vec<Actor>> {
    let raw=app.db.with(|db|{let mut s=db.prepare("SELECT min(p.node_id),p.is_show,a.document FROM person_records p JOIN actor_records a ON a.key=p.document WHERE p.person_id=?1 GROUP BY p.document,p.is_show ORDER BY min(p.node_id),p.is_show").app()?;s.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,String>(2)?))).app()?.collect::<rusqlite::Result<Vec<_>>>().app()})?;
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for (node, is_show, raw) in raw {
        let Some(entry) = app.db.entry(&node)? else {
            continue;
        };
        let mut actor: Actor = serde_json::from_str(&raw)?;
        let key = (
            actor.metadata.id.clone(),
            actor.metadata.version.clone(),
            actor.data.name.clone(),
            actor.data.thumb.clone(),
            actor.data.biography.clone(),
        );
        if !seen.insert(key) {
            continue;
        }
        if valid(app, &entry, &mut actor, is_show).await? {
            rows.push(actor);
        }
    }
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.metadata.id.len().cmp(&a.metadata.id.len()))
            .then_with(|| b.metadata.id.cmp(&a.metadata.id))
    });
    Ok(rows)
}
fn profile(id: &str, records: &[Actor]) -> String {
    let keys = records
        .iter()
        .filter_map(|a| a.portrait.as_ref())
        .map(|s| s.guid("person-image"))
        .collect::<Vec<_>>();
    if keys.is_empty() {
        String::new()
    } else {
        format!(
            "/tgdrive-person/{}",
            guid(&["fntv-person-profile-1", id, &keys.join(":")])
        )
    }
}
fn remember_image(app: &Application, id: &str, path: &str) -> Result<()> {
    if let Some(key) = path.strip_prefix("/tgdrive-person/") {
        app.db.with(|db|{db.execute("INSERT INTO person_images(key,person_id) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET person_id=excluded.person_id",params![key,id]).app()?;Ok(())})?;
    }
    Ok(())
}
async fn cast_actors(app: &Application, reference: &str) -> Result<Vec<Actor>> {
    if let Some(mut entry) = app.db.representative_entry(reference, "")? {
        let show = entry.actors.is_empty();
        let mut rows = if show {
            std::mem::take(&mut entry.show_actors)
        } else {
            std::mem::take(&mut entry.actors)
        };
        let mut result = Vec::new();
        for mut actor in rows.drain(..) {
            if valid(app, &entry, &mut actor, show).await? {
                result.push(actor);
            }
        }
        return Ok(result);
    }
    let mut entries = app.db.entries_for_group(reference)?;
    if entries.is_empty() {
        return Err(Error::api(
            tgdrive_contract::error_code::NOT_FOUND,
            "影视人物关联不存在",
        ));
    }
    for entry in &mut entries {
        let mut kept = Vec::new();
        for mut actor in std::mem::take(&mut entry.show_actors) {
            if valid(app, entry, &mut actor, true).await? {
                kept.push(actor);
            }
        }
        entry.show_actors = kept;
    }
    if let Some(entry) = entries.iter_mut().find(|e| !e.show_actors.is_empty()) {
        return Ok(std::mem::take(&mut entry.show_actors));
    }
    let mut rows = Vec::new();
    for mut entry in entries {
        for mut actor in std::mem::take(&mut entry.actors) {
            if valid(app, &entry, &mut actor, false).await? {
                rows.push(actor);
            }
        }
    }
    Ok(rows)
}
pub async fn cast(app: &Application, reference: &str, value: &Value) -> Result<Value> {
    let mut actors = cast_actors(app, reference).await?;
    actors.sort_by_key(|a| a.data.order.unwrap_or(u32::MAX));
    let unranked = actors
        .iter()
        .filter_map(|a| a.data.order)
        .max()
        .map(|n| u64::from(n) + 1)
        .unwrap_or(0);
    let mut list: Vec<Value> = Vec::new();
    let mut positions = HashMap::<String, usize>::new();
    for actor in actors {
        let id = identity(&actor);
        if let Some(index) = positions.get(&id).copied() {
            let current = list[index]["role"].as_str().unwrap_or_default();
            let role = actor.data.role.trim();
            if !role.is_empty() && !current.split(" / ").any(|s| s == role) {
                list[index]["role"] = json!(if current.is_empty() {
                    role.into()
                } else {
                    format!("{current} / {role}")
                });
            }
            continue;
        }
        let people = records(app, &id).await?;
        let Some(latest) = people.first() else {
            continue;
        };
        let path = profile(&id, &people);
        remember_image(app, &id, &path)?;
        let data = &latest.data;
        let numeric = |provider: &str| {
            if data.provider.eq_ignore_ascii_case(provider) {
                data.id.parse::<u64>().unwrap_or(0)
            } else {
                0
            }
        };
        let biography = people
            .iter()
            .find(|a| !a.data.biography.is_empty())
            .map(|a| a.data.biography.as_str())
            .unwrap_or("");
        let row = json!({"item_guid":reference,"person_guid":id,"name":actor.data.name,"original_name":data.name,"role":actor.data.role,"order":actor.data.order.map(u64::from).unwrap_or(unranked+list.len()as u64),"job":"Actor","department":"Acting","known_for_department":"Acting","profile_path":path,"biography":biography,"also_know_as":"","trim_id":"","imdb_id":if data.provider.eq_ignore_ascii_case("imdb"){data.id.as_str()}else{""},"tmdb_id":numeric("tmdb"),"douban_id":numeric("douban"),"lan":"","gender":0});
        positions.insert(id, list.len());
        list.push(row);
    }
    let total = list.len();
    let page = value["page"].as_u64().unwrap_or(1);
    let size = value["page_size"].as_u64().unwrap_or(total.max(1) as u64);
    if page == 0 || page > 10000 || size == 0 || size > 100000 {
        return Err(Error::api(
            tgdrive_contract::error_code::INVALID_REQUEST,
            "演员分页无效",
        ));
    }
    Ok(
        json!({"list":list.into_iter().skip(((page-1)*size)as usize).take(size as usize).collect::<Vec<_>>(),"total":total}),
    )
}
pub async fn works(app: &Application, value: &Value) -> Result<Value> {
    let id = value["person_guid"].as_str().unwrap_or_default();
    if records(app, id).await?.is_empty() {
        return Err(Error::api(
            tgdrive_contract::error_code::NOT_FOUND,
            "影视人物不存在",
        ));
    }
    let (query, skip) = Query::from_fntv(value, 512)?;
    let mut query = Query {
        person: id.into(),
        ..query
    };
    if !matches!(
        query.sort_column.as_str(),
        "create_time" | "sort_title" | "title"
    ) {
        query.sort_column = "create_time".into();
        query.descending = true;
    }
    if value["job"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && !s.eq_ignore_ascii_case("actor"))
    {
        return Ok(json!({"list":[],"total":0}));
    }
    let page = catalog::list(app, &query, skip)?;
    let list = page
        .ids
        .iter()
        .map(|id| {
            wire::catalog_item(app, id)?.ok_or_else(|| {
                Error::api(tgdrive_contract::error_code::NOT_FOUND, "人物作品不可用")
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"mdb_name":"","mdb_category":"","top_dir":"","dir":"","total":page.total,"jump_list":[],"list":list}),
    )
}
pub async fn detail(app: &Application, id: &str) -> Result<Value> {
    let people = records(app, id).await?;
    let latest = people
        .first()
        .ok_or_else(|| Error::api(tgdrive_contract::error_code::NOT_FOUND, "影视人物不存在"))?;
    let path = profile(id, &people);
    remember_image(app, id, &path)?;
    let works = works(
        app,
        &json!({"person_guid":id,"sort_column":"create_time","sort_type":"DESC","page_size":50}),
    )
    .await?;
    Ok(
        json!({"guid":id,"name":latest.data.name,"original_name":latest.data.name,"profile":path,"biography":people.iter().find(|a|!a.data.biography.is_empty()).map(|a|a.data.biography.as_str()).unwrap_or(""),"is_favorite":0,"actor_item_list":works["list"],"actor_item_total":works["total"],"director_item_list":[]}),
    )
}
pub async fn image(
    app: std::sync::Arc<Application>,
    reference: &str,
    method: &Method,
    session: crate::service::Session,
) -> Result<HttpResponse> {
    let id = app
        .db
        .with(|db| {
            db.query_row(
                "SELECT person_id FROM person_images WHERE key=?1",
                [reference],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()
        })?
        .ok_or_else(|| Error::api(tgdrive_contract::error_code::NOT_FOUND, "人物图片不存在"))?;
    let people = records(&app, &id).await?;
    if profile(&id, &people) != format!("/tgdrive-person/{reference}") {
        return Err(Error::api(
            tgdrive_contract::error_code::NOT_FOUND,
            "人物图片资料已改变",
        ));
    }
    for actor in people {
        let Some(source) = actor.portrait else {
            continue;
        };
        let response = app
            .host
            .bytes(source.file(), ReadOptions::default())
            .await?;
        let bytes = collect_bytes(response.body, 2 * 1024 * 1024).await?;
        let Ok((mime, bytes)) = crate::media::validate_image(bytes.to_vec()).await else {
            continue;
        };
        let body = if *method == Method::HEAD {
            empty_body()
        } else {
            let app = app.clone();
            let id = id.clone();
            let version = source.version.clone();
            let node = source.id.clone();
            let cancel = session.cancel.clone();
            stream_body(Box::pin(futures_util::stream::try_unfold(
                (bytes, 0usize),
                move |(bytes, offset)| {
                    let app = app.clone();
                    let id = id.clone();
                    let node = node.clone();
                    let version = version.clone();
                    let cancel = cancel.clone();
                    async move {
                        if offset == bytes.len() {
                            return Ok(None);
                        }
                        if cancel.is_cancelled() {
                            return Err(Error::Cancelled);
                        }
                        if !records(&app, &id).await?.iter().any(|a| {
                            a.portrait
                                .as_ref()
                                .is_some_and(|p| p.id == node && p.version == version)
                        }) {
                            return Err(Error::Cancelled);
                        }
                        let end = (offset + 64 * 1024).min(bytes.len());
                        Ok(Some((
                            bytes::Bytes::copy_from_slice(&bytes[offset..end]),
                            (bytes, end),
                        )))
                    }
                },
            )))
        };
        return tgdrive_backend_sdk::http::Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "no-store")
            .header("Content-Length", source.size)
            .body(body)
            .map_err(|_| Error::Protocol("人物图片响应无效"));
    }
    Err(Error::api(
        tgdrive_contract::error_code::NOT_FOUND,
        "人物图片没有可用来源",
    ))
}
