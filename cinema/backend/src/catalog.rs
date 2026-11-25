//! 页面采用键集分页；飞牛的页码协议只遍历排序索引键，正文仅加载本页。
use crate::{
    Application,
    database::SqlResult,
    model::{VIDEO_EXTENSIONS, guid},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::error_code;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Query {
    pub ancestor: String,
    pub q: String,
    pub types: Vec<String>,
    pub favorite: bool,
    pub history: bool,
    pub person: String,
    pub extensions: Vec<String>,
    pub raw_files: bool,
    pub sort_column: String,
    pub descending: bool,
    pub limit: usize,
    pub cursor: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub revision: String,
    pub query: String,
    pub guid: String,
    #[serde(skip)]
    pub title: String,
    #[serde(skip)]
    pub timestamp: i64,
}
pub struct Page {
    pub ids: Vec<String>,
    pub total: i64,
    pub next_cursor: Option<String>,
}
impl Query {
    pub fn from_fntv(value: &serde_json::Value, limit: usize) -> Result<(Self, usize)> {
        let string = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        let page = value["page"].as_u64().unwrap_or(1);
        let size = value["page_size"].as_u64().unwrap_or(50) as usize;
        if !(1..=10000).contains(&page) || size == 0 || size > limit {
            return Err(Error::api(error_code::INVALID_REQUEST, "列表分页超出上限"));
        }
        let sort_column = string("sort_column");
        let descending = if sort_column == "create_time" {
            !string("sort_type").eq_ignore_ascii_case("ASC")
        } else {
            matches!(sort_column.as_str(), "sort_title" | "title")
                && string("sort_type").eq_ignore_ascii_case("DESC")
        };
        Ok((
            Self {
                ancestor: string("ancestor_guid"),
                q: string("q"),
                types: value["tags"]["type"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(|s| s.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                sort_column,
                descending,
                limit: size,
                ..Default::default()
            },
            (page as usize - 1) * size,
        ))
    }
}
pub fn list(app: &Application, query: &Query, skip: usize) -> Result<Page> {
    if query.limit == 0
        || query.limit > 512
        || query.q.len() > 255
        || query.ancestor.len() > 128
        || query.person.len() > 128
        || query.types.len() > 8
        || query.extensions.len() > VIDEO_EXTENSIONS.len()
        || query
            .extensions
            .iter()
            .any(|extension| !VIDEO_EXTENSIONS.contains(&extension.as_str()))
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "影视查询参数无效"));
    }
    let revision = app.db.settings()?.index_revision;
    let mut fingerprint = query.clone();
    fingerprint.cursor = None;
    let hash = guid(&[&serde_json::to_string(&fingerprint)?]);
    let cursor = if let Some(cursor) = &query.cursor {
        if cursor.len() > 4096 {
            return Err(Error::api(error_code::INVALID_CURSOR, "影视分页游标过长"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| Error::api(error_code::INVALID_CURSOR, "影视分页游标无效"))?;
        let mut value: Cursor = tgdrive_backend_sdk::decode_json(&bytes)?;
        if value.revision != revision || value.query != hash {
            return Err(Error::api(
                error_code::INVALID_CURSOR,
                "媒体库已更新，请从首页重新加载",
            ));
        }
        let anchor = app
            .db
            .catalog(&value.guid)?
            .ok_or_else(|| Error::api(error_code::INVALID_CURSOR, "影视分页锚点不存在"))?;
        value.title = anchor.title;
        value.timestamp = if query.history {
            app.db.recent_at(&value.guid)?
        } else {
            anchor.added_at
        };
        Some(value)
    } else {
        None
    };
    let mut conditions = vec!["1=1".to_owned()];
    let mut parameters = Vec::new();
    if query.raw_files {
        conditions.push("c.kind NOT IN ('TV','Season')".into());
    }
    if query.ancestor.is_empty() {
        if !query.raw_files && !query.favorite && !query.history && !query.person.is_empty() {
            conditions.push("c.kind!='Season' AND c.kind!='Episode'".into());
        } else if !query.raw_files && !query.favorite && !query.history {
            conditions.push("c.kind NOT IN ('Season','Episode')".into());
        }
    } else if query.raw_files
        && app
            .db
            .libraries()?
            .iter()
            .any(|library| library.id == query.ancestor)
    {
        // 页面的视频视图包含电视剧库中的单集，不能沿用外部客户端的剧／季聚合筛选。
        conditions.push(
            "EXISTS(SELECT 1 FROM catalog_libraries cl WHERE cl.guid=c.guid AND cl.library_id=?)"
                .into(),
        );
        parameters.push(SqlValue::Text(query.ancestor.clone()));
    } else {
        conditions.push("(c.guid=? OR c.parent_guid=? OR (c.kind NOT IN ('Season','Episode') AND EXISTS(SELECT 1 FROM catalog_libraries cl WHERE cl.guid=c.guid AND cl.library_id=?)))".into());
        parameters.extend(
            [&query.ancestor, &query.ancestor, &query.ancestor].map(|s| SqlValue::Text(s.clone())),
        );
    }
    if !query.q.is_empty() {
        if query.raw_files {
            conditions.push("(instr(c.folded_title,?)>0 OR EXISTS(SELECT 1 FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN nodes n ON n.id=e.node_id WHERE l.item_guid=c.guid AND instr(lower(json_extract(n.document,'$.name')),?)>0))".into());
            parameters.extend([
                SqlValue::Text(query.q.to_lowercase()),
                SqlValue::Text(query.q.to_ascii_lowercase()),
            ]);
        } else {
            conditions.push("instr(c.folded_title,?)>0".into());
            parameters.push(SqlValue::Text(query.q.to_lowercase()));
        }
    }
    if !query.types.is_empty() {
        let mut types = query.types.clone();
        if types.iter().any(|s| s == "TV") {
            types.push("Video".into());
        }
        conditions.push(format!("c.kind IN ({})", vec!["?"; types.len()].join(",")));
        parameters.extend(types.into_iter().map(SqlValue::Text));
    }
    if query.favorite {
        conditions
            .push("EXISTS(SELECT 1 FROM flags f WHERE f.target=c.guid AND f.favorite=1)".into());
    }
    if query.history {
        conditions.push("EXISTS(SELECT 1 FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN progress p ON p.media_guid=e.media_guid WHERE l.item_guid=c.guid AND p.updated_at>0)".into());
    }
    if !query.person.is_empty() {
        conditions.push("(EXISTS(SELECT 1 FROM person_records p WHERE p.node_id=c.representative AND c.kind!='TV' AND p.person_id=?) OR (c.kind='TV' AND EXISTS(SELECT 1 FROM entries e JOIN person_records p ON p.node_id=e.node_id WHERE e.show_guid=c.guid AND p.person_id=?)))".into());
        parameters.extend([
            SqlValue::Text(query.person.clone()),
            SqlValue::Text(query.person.clone()),
        ]);
    }
    if !query.extensions.is_empty() {
        conditions.push(format!("EXISTS(SELECT 1 FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN nodes n ON n.id=e.node_id WHERE l.item_guid=c.guid AND n.extension IN ({}))", vec!["?"; query.extensions.len()].join(",")));
        parameters.extend(query.extensions.iter().cloned().map(SqlValue::Text));
    }
    let filter = conditions.join(" AND ");
    let added = query.sort_column == "create_time" || query.history;
    let timestamp = if query.history {
        "(SELECT max(p.updated_at) FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN progress p ON p.media_guid=e.media_guid WHERE l.item_guid=c.guid)"
    } else {
        "c.added_at"
    };
    let primary = if added { timestamp } else { "c.title" };
    let descending = query.descending || query.history;
    let order = if descending { "DESC" } else { "ASC" };
    let mut seek = String::new();
    if let Some(cursor) = &cursor {
        let compare = if descending { "<" } else { ">" };
        if added {
            seek = format!(
                " AND ({timestamp} {compare} ? OR ({timestamp}=? AND (c.title>? OR (c.title=? AND c.guid>?))))"
            );
            parameters.extend([
                SqlValue::Integer(cursor.timestamp),
                SqlValue::Integer(cursor.timestamp),
                SqlValue::Text(cursor.title.clone()),
                SqlValue::Text(cursor.title.clone()),
                SqlValue::Text(cursor.guid.clone()),
            ]);
        } else {
            seek = format!(" AND (c.title {compare} ? OR (c.title=? AND c.guid>?))");
            parameters.extend([
                SqlValue::Text(cursor.title.clone()),
                SqlValue::Text(cursor.title.clone()),
                SqlValue::Text(cursor.guid.clone()),
            ]);
        }
    }
    let sort = format!("{primary} {order},c.title ASC,c.guid ASC");
    let sql = format!(
        "SELECT c.guid,c.title,{timestamp} FROM catalog c WHERE {filter}{seek} ORDER BY {sort}"
    );
    let count_parameters = parameters[..parameters.len()
        - cursor
            .as_ref()
            .map(|_| if added { 5 } else { 3 })
            .unwrap_or(0)]
        .to_vec();
    app.db.with(|db| {
        let total = db
            .query_row(
                &format!("SELECT count(*) FROM catalog c WHERE {filter}"),
                params_from_iter(count_parameters),
                |r| r.get::<_, i64>(0),
            )
            .app()?;
        let mut statement = db.prepare(&sql).app()?;
        let mut rows = statement.query(params_from_iter(parameters)).app()?;
        // 飞牛的页码不改变宿主查询协议；跳过的只有固定大小排序键，不解码完整影视资料。
        for _ in 0..skip {
            if rows.next().app()?.is_none() {
                return Ok(Page {
                    ids: Vec::new(),
                    total,
                    next_cursor: None,
                });
            }
        }
        let mut ids = Vec::new();
        let mut last = None;
        while ids.len() < query.limit {
            let Some(row) = rows.next().app()? else {
                break;
            };
            let id: String = row.get(0).app()?;
            last = Some(Cursor {
                revision: revision.clone(),
                query: hash.clone(),
                guid: id.clone(),
                title: row.get(1).app()?,
                timestamp: row.get(2).app()?,
            });
            ids.push(id);
        }
        let next_cursor = if rows.next().app()?.is_some() {
            last.map(|c| serde_json::to_vec(&c).map(|bytes| URL_SAFE_NO_PAD.encode(bytes)))
                .transpose()?
        } else {
            None
        };
        Ok(Page {
            ids,
            total,
            next_cursor,
        })
    })
}
