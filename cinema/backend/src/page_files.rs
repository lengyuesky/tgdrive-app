//! 页面目录与选集按自然名称键分页；连播查相邻键，不把整个目录搬到浏览器。
use crate::{
    Application,
    database::SqlResult,
    index,
    model::{guid, now, within},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{
    error_code,
    files::{FileNode, NodeKind, NodeReference},
};

#[derive(Serialize)]
pub struct Page {
    pub items: Vec<FileNode>,
    pub total: u64,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    revision: String,
    query: String,
    node_id: String,
    expires_at: i64,
}

/// 数字段只转换排序键，不转换为可能溢出的机器整数；原名和 ID 稳定破同值。
pub fn name_key(name: &str) -> String {
    let mut key = String::new();
    let mut chars = name.chars().peekable();
    while let Some(character) = chars.next() {
        if character.is_ascii_digit() {
            let mut digits = String::from(character);
            while chars.peek().is_some_and(char::is_ascii_digit) {
                digits.push(chars.next().unwrap());
            }
            let trimmed = digits.trim_start_matches('0');
            let digits = if trimmed.is_empty() { "0" } else { trimmed };
            key.push_str(&format!("\u{1}{:03}:{digits}\u{2}", digits.len()));
        } else {
            key.push(character.to_ascii_lowercase());
        }
    }
    key
}

async fn current(app: &Application, id: &str, library_id: &str) -> Result<FileNode> {
    let node = app
        .host
        .stat(NodeReference::Id {
            id: id.into(),
            content_version: None,
        })
        .await?;
    let libraries = app.db.libraries()?;
    for library in libraries {
        if !library_id.is_empty() && library.id != library_id {
            continue;
        }
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
    Err(Error::api(
        error_code::NOT_FOUND,
        "节点不在当前影视媒体库中",
    ))
}

pub async fn directory(
    app: &Application,
    path: &str,
    library_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Page> {
    let directory = app
        .host
        .stat(NodeReference::Path {
            path: path.into(),
            content_version: None,
        })
        .await?;
    let directory = current(app, &directory.id, library_id).await?;
    if directory.kind != NodeKind::Directory {
        return Err(Error::api(error_code::NOT_DIRECTORY, "影视目录不可用"));
    }
    list(app, &directory, library_id, false, limit, cursor).await
}

pub async fn playlist(
    app: &Application,
    id: &str,
    library_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Page> {
    let node = current(app, id, library_id).await?;
    if app.db.entry(id)?.is_none() || node.kind != NodeKind::File {
        return Err(Error::api(error_code::NOT_FOUND, "选集视频不可用"));
    }
    let parent = node.parent_id.ok_or(Error::Protocol("视频缺少父目录"))?;
    let directory = current(app, &parent, library_id).await?;
    list(app, &directory, library_id, true, limit, cursor).await
}

async fn list(
    app: &Application,
    directory: &FileNode,
    library_id: &str,
    videos_only: bool,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Page> {
    if !(1..=200).contains(&limit) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "影视目录每页需为 1 至 200 项",
        ));
    }
    let revision = app.db.settings()?.index_revision;
    let query = guid(&[
        &directory.id,
        &directory.revision,
        library_id,
        if videos_only { "playlist" } else { "directory" },
        &limit.to_string(),
    ]);
    let mut anchor = (String::new(), String::new());
    if let Some(cursor) = cursor {
        if cursor.len() > 4096 {
            return Err(Error::api(error_code::INVALID_CURSOR, "选集游标过长"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| Error::api(error_code::INVALID_CURSOR, "选集游标无效"))?;
        let cursor: Cursor = tgdrive_backend_sdk::decode_json(&bytes)?;
        if cursor.revision != revision || cursor.query != query || cursor.expires_at <= now() {
            return Err(Error::api(
                error_code::INVALID_CURSOR,
                "选集已更新，请重新加载首页",
            ));
        }
        anchor = app
            .db
            .with(|db| {
                db.query_row(
                    "SELECT name_key,id FROM nodes WHERE id=?1 AND parent_id=?2",
                    params![cursor.node_id, directory.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .app()
            })?
            .ok_or_else(|| Error::api(error_code::INVALID_CURSOR, "选集锚点已不存在"))?;
    }
    let video = "EXISTS(SELECT 1 FROM catalog c WHERE c.kind NOT IN ('TV','Season') AND c.representative=n.id AND (?2='' OR EXISTS(SELECT 1 FROM catalog_libraries cl WHERE cl.guid=c.guid AND cl.library_id=?2)))";
    let filter = if videos_only {
        video.to_owned()
    } else {
        format!("(n.kind='directory' OR {video})")
    };
    let membership = "(?2='' OR EXISTS(SELECT 1 FROM node_libraries l WHERE l.node_id=n.id AND l.library_id=?2))";
    let (total, mut ids) = app.db.with(|db| {
        let total: i64 = db.query_row(&format!("SELECT count(*) FROM nodes n WHERE n.parent_id=?1 AND {membership} AND {filter}"), params![directory.id,library_id], |row| row.get(0)).app()?;
        let mut statement = db.prepare(&format!("SELECT n.id FROM nodes n WHERE n.parent_id=?1 AND {membership} AND {filter} AND (n.name_key,n.id)>(?3,?4) ORDER BY n.name_key,n.id LIMIT ?5")).app()?;
        let ids = statement.query_map(params![directory.id,library_id,anchor.0,anchor.1,limit as i64+1], |row| row.get::<_,String>(0)).app()?.collect::<rusqlite::Result<Vec<_>>>().app()?;
        Ok((total, ids))
    })?;
    let more = ids.len() > limit;
    if more {
        ids.pop();
    }
    let mut items = Vec::with_capacity(ids.len());
    for id in &ids {
        let node = current(app, id, library_id).await?;
        if node.parent_id.as_deref() != Some(directory.id.as_str()) {
            return Err(Error::api(
                error_code::NODE_CHANGED,
                "读取期间选集位置发生改变",
            ));
        }
        items.push(node);
    }
    let next_cursor = if more {
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
            revision,
            query,
            node_id: ids.last().unwrap().clone(),
            expires_at: now() + 3_600_000,
        })?))
    } else {
        None
    };
    Ok(Page {
        items,
        total: total as u64,
        next_cursor,
    })
}

pub async fn neighbor(
    app: &Application,
    id: &str,
    library_id: &str,
    delta: i64,
) -> Result<Option<FileNode>> {
    if !matches!(delta, -1 | 1) {
        return Err(Error::api(error_code::INVALID_REQUEST, "相邻选集方向无效"));
    }
    let node = current(app, id, library_id).await?;
    let entry = app
        .db
        .entry(id)?
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "选集视频不可用"))?;
    index::authorized(app, &entry.file()).await?;
    if entry.kind == "Movie" && !entry.number.trim().is_empty() {
        // 番号电影的分段和版本只能明确选择，不能通过相邻文件查询触发连播。
        return Ok(None);
    }
    let compare = if delta > 0 { ">" } else { "<" };
    let order = if delta > 0 { "ASC" } else { "DESC" };
    let next: Option<String> = app.db.with(|db| db.query_row(&format!("SELECT n.id FROM nodes n WHERE n.parent_id=?1 AND EXISTS(SELECT 1 FROM entries e WHERE e.node_id=n.id) AND (?2='' OR EXISTS(SELECT 1 FROM node_libraries l WHERE l.node_id=n.id AND l.library_id=?2)) AND (n.name_key,n.id){compare}(?3,?4) ORDER BY n.name_key {order},n.id {order} LIMIT 1"), params![node.parent_id,library_id,name_key(&node.name),node.id], |row| row.get(0)).optional().app())?;
    match next {
        Some(id) => Ok(Some(current(app, &id, library_id).await?)),
        None => Ok(None),
    }
}
