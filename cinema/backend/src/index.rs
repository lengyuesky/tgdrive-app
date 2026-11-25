//! 通用查询和持久变更游标构建影视索引；没有视频数、文件数或 KV 大小截断。
use crate::{Application, database::SqlResult, model::*, nfo};
use rusqlite::{OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use tgdrive_backend_sdk::{Error, ReadOptions, Result, collect_bytes};
use tgdrive_contract::{error_code, files::*};

pub async fn synchronize(app: &Application, manual: bool) -> Result<()> {
    let _single = app.index_lock.lock().await;
    synchronize_locked(app, manual).await
}
pub(crate) type ReadSynchronization =
    tokio::sync::watch::Receiver<Option<std::result::Result<(), std::sync::Arc<Error>>>>;

pub async fn synchronize_read(app: &std::sync::Arc<Application>) -> Result<()> {
    // 常规后台与页面共享同一次索引核对，不排队或重放 HTTP 业务请求；手动重扫仍明确报忙。
    let mut receiver = {
        let mut current = app.read_sync.lock().await;
        if current
            .as_ref()
            .is_none_or(|receiver| receiver.borrow().is_some())
        {
            let (sender, receiver) = tokio::sync::watch::channel(None);
            let job = app.clone();
            tokio::spawn(async move {
                let work = async {
                    let _single = job.index_lock.try_lock().map_err(|_| {
                        Error::api(error_code::RATE_LIMITED, "影视索引正在整理，请稍后重试")
                    })?;
                    synchronize_locked(&job, false).await
                };
                let result = tokio::select! { _ = job.shutdown_token().cancelled() => Err(Error::Cancelled), result = work => result };
                let _ = sender.send(Some(result.map_err(std::sync::Arc::new)));
            });
            *current = Some(receiver);
        }
        current.as_ref().unwrap().clone()
    };
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result.map_err(|error| match error.as_ref() {
                Error::Api { status, error } => Error::Api {
                    status: *status,
                    error: error.clone(),
                },
                _ => Error::api(error.code(), "影视索引核对未完成，请重新读取"),
            });
        }
        receiver.changed().await.map_err(|_| Error::Cancelled)?;
    }
}
async fn synchronize_locked(app: &Application, manual: bool) -> Result<()> {
    app.shutdown_token()
        .is_cancelled()
        .then_some(())
        .map_or(Ok(()), |_| Err(Error::Cancelled))?;
    let settings = app.db.settings()?;
    let scope = app.host.scope().await?;
    if !settings.scope_revision.is_empty() && settings.scope_revision != scope.revision {
        app.revoke_sessions().await?;
    }
    let libraries = app.db.libraries()?;
    let mut roots = HashMap::new();
    for library in &libraries {
        match app
            .host
            .stat(NodeReference::Id {
                id: library.root_id.clone(),
                content_version: None,
            })
            .await
        {
            Ok(node) if node.kind == NodeKind::Directory => {
                roots.insert(library.id.clone(), node);
            }
            Ok(_) => {}
            Err(e) if matches!(e.code(), error_code::NOT_FOUND | error_code::SCOPE_DENIED) => {}
            Err(e) => return Err(e),
        }
    }
    let mut rebuild =
        manual || settings.scope_revision != scope.revision || settings.change_cursor.is_none();
    let mut affected = HashSet::new();
    let mut cursor = if rebuild {
        None
    } else {
        settings.change_cursor.clone()
    };
    if !matches!(scope.scope, DirectoryScope::None) {
        loop {
            let page = match app
                .host
                .changes(FileChangesRequest {
                    cursor: cursor.clone(),
                    limit: 500,
                })
                .await
            {
                Ok(page) => page,
                Err(e)
                    if cursor.is_some()
                        && matches!(
                            e.code(),
                            error_code::SCOPE_CHANGED
                                | error_code::CURSOR_EXPIRED
                                | error_code::INVALID_CURSOR
                                | error_code::APP_CHANGED
                        ) =>
                {
                    rebuild = true;
                    cursor = None;
                    continue;
                }
                Err(e) => return Err(e),
            };
            if page.scope_revision != scope.revision {
                return Err(Error::api(
                    error_code::SCOPE_CHANGED,
                    "扫描期间目录授权发生改变",
                ));
            }
            rebuild |= page.reset_required;
            for change in &page.changes {
                let (id, paths): (&str, Vec<&str>) = match change {
                    FileChange::Upsert { node } => (&node.id, vec![&node.path]),
                    FileChange::Removed { id } => (id, Vec::new()),
                    FileChange::SubtreeInvalidated {
                        id,
                        previous_path,
                        current,
                    } => (
                        id,
                        previous_path
                            .iter()
                            .map(String::as_str)
                            .chain(current.iter().map(|n| n.path.as_str()))
                            .collect(),
                    ),
                };
                let old = app.db.node(id)?;
                for library in &libraries {
                    let current = roots.get(&library.id);
                    let previous = app.db.node(&library.root_id)?;
                    let belongs = paths
                        .iter()
                        .copied()
                        .chain(old.iter().map(|n| n.path.as_str()))
                        .any(|path| {
                            current
                                .into_iter()
                                .chain(previous.iter())
                                .any(|root| within(path, &root.path) || within(&root.path, path))
                        });
                    if belongs || id == library.root_id {
                        affected.insert(library.id.clone());
                    }
                }
            }
            if page.has_more && cursor.as_deref() == Some(&page.next_cursor) {
                return Err(Error::Protocol("宿主变更游标未推进"));
            }
            cursor = Some(page.next_cursor);
            if !page.has_more {
                break;
            }
        }
    } else {
        rebuild = true;
        cursor = None;
    }
    if rebuild {
        affected.extend(libraries.iter().map(|l| l.id.clone()));
    }
    if affected.is_empty() {
        if let Some(cursor) = cursor {
            app.db.checkpoint(&scope.revision, &cursor)?;
        }
        return Ok(());
    }
    let selected: Vec<_> = libraries
        .iter()
        .filter(|l| affected.contains(&l.id))
        .cloned()
        .collect();
    app.set_index_status("scanning", "")?;
    app.db.begin_scan(&selected)?;
    let result = async {
        for library in &selected {
            let Some(root) = roots.get(&library.id) else {
                continue;
            };
            app.db.scan_nodes(&library.id, std::slice::from_ref(root))?;
            let mut next = None;
            let mut seen = HashSet::new();
            loop {
                app.check_background()?;
                let page = app
                    .host
                    .query(FileQuery {
                        roots: vec![root.id.clone()],
                        recursive: true,
                        filter: FileFilter {
                            kind: QueryKind::All,
                            ..Default::default()
                        },
                        sort: NodeSort::Id,
                        order: SortOrder::Asc,
                        limit: 500,
                        cursor: next,
                    })
                    .await?;
                if page.scope_revision != scope.revision {
                    return Err(Error::api(
                        error_code::SCOPE_CHANGED,
                        "索引扫描的目录授权不一致",
                    ));
                }
                // 以节点主键覆盖重复项，字节截页只看 next_cursor，不能按条数判断结束。
                app.db.scan_nodes(&library.id, &page.items)?;
                next = page.next_cursor;
                if let Some(value) = &next {
                    if !seen.insert(value.clone()) {
                        return Err(Error::Protocol("宿主查询游标未推进"));
                    }
                } else {
                    break;
                }
            }
            let mut after = String::new();
            let mut descriptions = HashMap::new();
            loop {
                let videos = app.db.scan_videos(&library.id, &after)?;
                if videos.is_empty() {
                    break;
                }
                for node in videos {
                    app.check_background()?;
                    after = node.id.clone();
                    let entry = build_entry(app, library, root, &node, &mut descriptions).await?;
                    app.db.scan_entry(&library.id, &entry)?;
                }
            }
        }
        let latest = app.host.scope().await?;
        if latest.revision != scope.revision {
            return Err(Error::api(
                error_code::SCOPE_CHANGED,
                "发布前目录授权发生改变",
            ));
        }
        app.check_background()?;
        app.db.publish(
            &settings.revision,
            &scope.revision,
            cursor.as_deref().unwrap_or(""),
        )?;
        app.set_index_status("ready", "")?;
        crate::covers::schedule(app, false)?;
        app.cover_wake.notify_one();
        Ok(())
    }
    .await;
    if result.is_err() {
        app.set_index_status("failed", "索引未完成，旧索引未被清空；请刷新重试")?;
    }
    result
}

async fn read_nfo(
    app: &Application,
    source: &Source,
    cache: &mut HashMap<String, Option<String>>,
) -> Result<Option<String>> {
    let key = source.guid("nfo");
    if let Some(value) = cache.get(&key) {
        return Ok(value.clone());
    }
    if source.size == 0 || source.size > nfo::MAX_BYTES as u64 {
        return Ok(None);
    }
    let result = async {
        let response = app
            .host
            .bytes(
                source.file(),
                ReadOptions {
                    range: Some(format!("bytes=0-{}", source.size - 1)),
                    ..Default::default()
                },
            )
            .await?;
        if response.status != 206 {
            return Err(Error::Protocol("影视描述读取未精确满足 Range"));
        }
        let bytes = collect_bytes(response.body, nfo::MAX_BYTES as u64).await?;
        if bytes.len() as u64 != source.size {
            return Err(Error::Protocol("影视描述读取不完整"));
        }
        let text = String::from_utf8(bytes.to_vec())
            .ok()
            .filter(|text| nfo::document(text).is_some());
        Ok::<_, Error>(text)
    };
    let value = tokio::select! {
        _=app.shutdown_token().cancelled()=>return Err(Error::Cancelled),
        result=tokio::time::timeout(std::time::Duration::from_secs(5),result)=>match result {
            Ok(Ok(value))=>value,
            Ok(Err(e)) if matches!(e.code(),error_code::SCOPE_DENIED|error_code::APP_CHANGED|error_code::APP_DISABLED|error_code::CONTENT_CHANGED)=>return Err(e),
            _=>None,
        }
    };
    // 单个工作批次最多缓存八份完整 NFO，长简介不会随媒体库规模积累到内存。
    if cache.len() >= 8 {
        cache.clear();
    }
    cache.insert(key, value.clone());
    Ok(value)
}
fn actors(
    app: &Application,
    library: &Library,
    text: &str,
    source: &Source,
    updated_at: i64,
) -> Result<Vec<Actor>> {
    nfo::actors(text)
        .into_iter()
        .map(|data| {
            let portrait = nfo::local_actor_path(parent(&source.path), &data.thumb)
                .map(|path| app.db.scan_path(&library.id, &path))
                .transpose()?
                .flatten()
                .filter(|node| {
                    node.kind == NodeKind::File
                        && node.size.0 > 0
                        && node.size.0 <= POSTER_LIMIT
                        && ["jpg", "jpeg", "png", "webp"].contains(&extension(&node.name).as_str())
                })
                .and_then(|n| Source::from_node(&n));
            Ok(Actor {
                data,
                metadata: source.clone(),
                updated_at,
                portrait,
            })
        })
        .collect()
}
async fn build_entry(
    app: &Application,
    library: &Library,
    root: &FileNode,
    node: &FileNode,
    cache: &mut HashMap<String, Option<String>>,
) -> Result<Entry> {
    let parent_id = node
        .parent_id
        .as_deref()
        .ok_or(Error::Protocol("视频缺少父目录"))?;
    let related = app.db.scan_related(&library.id, parent_id)?;
    let basename = stem(&node.name);
    let nfo_node = related
        .iter()
        .find(|n| n.name.eq_ignore_ascii_case(&format!("{basename}.nfo")))
        .or_else(|| {
            related.iter().find(|n| {
                n.name.eq_ignore_ascii_case(if library.kind == "movie" {
                    "movie.nfo"
                } else {
                    "episodedetails.nfo"
                })
            })
        });
    let metadata = nfo_node.and_then(Source::from_node);
    let posters: Vec<_> = nfo::poster_names(basename)
        .iter()
        .filter_map(|name| related.iter().find(|n| n.name.eq_ignore_ascii_case(name)))
        .filter(|n| n.size.0 > 0 && n.size.0 <= POSTER_LIMIT)
        .filter_map(Source::from_node)
        .collect();
    let subtitles: Vec<_> = related
        .iter()
        .filter(|n| {
            ["srt", "vtt", "ass", "ssa"].contains(&extension(&n.name).as_str())
                && (stem(&n.name).eq_ignore_ascii_case(basename)
                    || stem(&n.name)
                        .to_ascii_lowercase()
                        .starts_with(&format!("{}.", basename.to_ascii_lowercase())))
                && n.size.0 <= SUBTITLE_LIMIT
        })
        .take(32)
        .filter_map(Source::from_node)
        .collect();
    let version = node
        .content_version
        .clone()
        .ok_or(Error::Protocol("视频缺少内容版本"))?;
    let fingerprint = guid(&[
        &library.kind,
        &node.path,
        &node.name,
        metadata.as_ref().map(|m| m.version.as_str()).unwrap_or(""),
        &posters
            .iter()
            .map(|s| s.guid("poster"))
            .collect::<Vec<_>>()
            .join(":"),
        &subtitles
            .iter()
            .map(|s| s.guid("subtitle"))
            .collect::<Vec<_>>()
            .join(":"),
        if node.has_thumbnail {
            &node.revision
        } else {
            ""
        },
    ]);
    let mut entry = Entry {
        node_id: node.id.clone(),
        version: version.clone(),
        guid: guid(&["item", &node.id, &version]),
        media_guid: guid(&["media", &node.id, &version]),
        path: node.path.clone(),
        filename: node.name.clone(),
        size: node.size.0,
        timestamp: node.modified_at.0,
        added_at: node.created_at.0,
        title: basename.replace(['.', '_'], " "),
        version_name: basename.into(),
        overview: String::new(),
        year: String::new(),
        number: String::new(),
        kind: if library.kind == "movie" {
            "Movie"
        } else {
            "Video"
        }
        .into(),
        libraries: vec![library.id.clone()],
        season: 0,
        episode: 0,
        show_guid: String::new(),
        show_title: String::new(),
        metadata_version: fingerprint,
        metadata,
        posters,
        subtitles,
        actors: Vec::new(),
        show_actors: Vec::new(),
        show_nfo: None,
        has_thumbnail: node.has_thumbnail,
        thumbnail_revision: node.revision.clone(),
        cover: None,
    };
    let old = app.db.entry(&node.id)?;
    let reuse = old.as_ref().is_some_and(|old| {
        old.version == entry.version && old.metadata_version == entry.metadata_version
    });
    let mut recognized = if library.kind == "tv" {
        episode_name(&node.name)
    } else {
        None
    };
    if reuse {
        let old = old.unwrap();
        entry.title = old.title;
        entry.version_name = old.version_name;
        entry.overview = old.overview;
        entry.year = old.year;
        entry.number = old.number;
        entry.actors = old.actors;
        if old.kind == "Episode" {
            recognized = Some((old.show_title, old.season, old.episode));
        }
    } else if let Some(source) = &entry.metadata
        && let Some(text) = read_nfo(app, source, cache).await?
    {
        entry.actors = actors(app, library, &text, source, nfo_node.unwrap().modified_at.0)?;
        if let Some(title) = nfo::text(&text, "title") {
            if let Some((_, label)) = nfo::version_label(&title) {
                entry.version_name = label.into();
            }
            entry.title = title;
        }
        entry.overview = nfo::text(&text, "plot").unwrap_or_default();
        entry.number = nfo::number(&text).unwrap_or_default();
        entry.year = nfo::text(&text, "year")
            .filter(|y| y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or_default();
        if library.kind == "tv"
            && let (Some(season), Some(episode)) = (
                nfo::text(&text, "season").and_then(|s| s.parse::<u32>().ok()),
                nfo::text(&text, "episode")
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|n| *n > 0),
            )
        {
            recognized = Some((
                nfo::text(&text, "showtitle").unwrap_or_default(),
                season,
                episode,
            ));
        }
    }
    if let Some((title, season, episode)) = recognized {
        let parent_node = app
            .db
            .scan_node(&library.id, parent_id)?
            .ok_or(Error::Protocol("剧集父目录未出现在扫描中"))?;
        let parent_name = parent_node.name.to_ascii_lowercase();
        let season_folder = parent_name
            .strip_prefix("season")
            .or_else(|| parent_name.strip_prefix('s'))
            .map(str::trim)
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        // 媒体库根不会向上越过已授权的取材边界。
        let group = if season_folder && parent_node.id != root.id {
            parent_node.parent_id.as_deref().unwrap_or(parent_id)
        } else {
            parent_id
        };
        let group_node = app
            .db
            .scan_node(&library.id, group)?
            .unwrap_or_else(|| parent_node.clone());
        entry.kind = "Episode".into();
        entry.season = season;
        entry.episode = episode;
        entry.show_guid = guid(&["show", group]);
        entry.show_title = if title.is_empty() {
            group_node.name.clone()
        } else {
            title
        };
        let show_path = format!("{}/tvshow.nfo", group_node.path.trim_end_matches('/'));
        if let Some(show) = app.db.scan_path(&library.id, &show_path)?
            && let Some(source) = Source::from_node(&show)
        {
            if let Some(text) = read_nfo(app, &source, cache).await? {
                entry.show_actors = actors(app, library, &text, &source, show.modified_at.0)?;
            }
            entry.show_nfo = Some(source);
        }
    }
    if entry.metadata.is_some()
        && let Some(item_guid) = numbered_movie_guid(library, parent_id, &entry.number)
    {
        // 一个文件也先采用组身份，后来增删版本或改名不会让影片条目换号。
        entry.guid = item_guid;
        if let Some((title, _)) = nfo::version_label(&entry.title) {
            entry.title = title.into();
        }
    }
    // 即使描述内容复用，人物图像仍按本次扫描的最新路径和内容版本刷新。
    for actor in entry.actors.iter_mut().chain(entry.show_actors.iter_mut()) {
        actor.portrait = nfo::local_actor_path(parent(&actor.metadata.path), &actor.data.thumb)
            .map(|p| app.db.scan_path(&library.id, &p))
            .transpose()?
            .flatten()
            .filter(|n| n.size.0 > 0 && n.size.0 <= POSTER_LIMIT)
            .and_then(|n| Source::from_node(&n));
    }
    Ok(entry)
}

/// 只有当前宿主授权、当前内容版本和当前媒体库目录共同通过才能读取。
pub async fn authorized(app: &Application, file: &ContentRef) -> Result<FileNode> {
    let node = app
        .host
        .stat(NodeReference::Id {
            id: file.id.clone(),
            content_version: Some(file.content_version.clone()),
        })
        .await?;
    if node.kind != NodeKind::File {
        return Err(Error::api(error_code::IS_DIRECTORY, "影视内容不是文件"));
    }
    for library in app.db.libraries()? {
        if let Ok(root) = app
            .host
            .stat(NodeReference::Id {
                id: library.root_id,
                content_version: None,
            })
            .await
            && root.kind == NodeKind::Directory
            && within(&node.path, &root.path)
        {
            return Ok(node);
        }
    }
    Err(Error::api(error_code::NOT_FOUND, "文件已移出影视媒体库"))
}

pub fn state(app: &Application) -> Result<serde_json::Value> {
    app.db.with(|db| {
        let (count,): (i64,) = db
            .query_row(
                "SELECT count(*) FROM catalog WHERE kind NOT IN ('TV','Season')",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .app()?;
        let status: Option<String> = db
            .query_row(
                "SELECT document FROM preferences WHERE key='internal:index-status'",
                [],
                |r| r.get(0),
            )
            .optional()
            .app()?;
        let mut value = status
            .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
            .unwrap_or(serde_json::json!({"state":"idle","error":""}));
        value["entries"] = serde_json::json!(count);
        Ok(value)
    })
}
pub fn set_state(app: &Application, state: &str, error: &str) -> Result<()> {
    app.db.with(|db| {db.execute("INSERT INTO preferences(key,document,revision) VALUES('internal:index-status',?1,?2) ON CONFLICT(key) DO UPDATE SET document=excluded.document,revision=excluded.revision",params![serde_json::json!({"state":state,"error":error}).to_string(),random_id()]).app()?;Ok(())})
}
