//! 一份私有 SQLite 管理索引和观看状态；扫描先暂存，成功后才原子发布。
use crate::model::{CatalogItem, Entry, Library, MediaInfo, Progress, random_id};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::Mutex;
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{error_code, files::FileNode};

pub fn database_error(_: rusqlite::Error) -> Error {
    Error::api(error_code::STORAGE_UNAVAILABLE, "影视数据库操作失败")
}
pub trait SqlResult<T> {
    fn app(self) -> Result<T>;
}
impl<T> SqlResult<T> for rusqlite::Result<T> {
    fn app(self) -> Result<T> {
        self.map_err(database_error)
    }
}
fn json<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value)
        .map_err(|_| Error::api(error_code::STORAGE_UNAVAILABLE, "影视数据损坏，请恢复备份"))
}

#[derive(Clone)]
pub struct Settings {
    pub revision: String,
    pub username: String,
    pub verifier: String,
    pub running: bool,
    pub scope_revision: String,
    pub change_cursor: Option<String>,
    pub index_revision: String,
}
pub struct Database {
    connection: Mutex<Option<Connection>>,
}
impl Database {
    pub fn new(mut connection: Connection) -> Result<Self> {
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .app()?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .app()?;
        if version > 2 {
            return Err(Error::api(
                error_code::STORAGE_UNAVAILABLE,
                "影视数据库版本较新，不能降级打开",
            ));
        }
        if version < 2 {
            // 数据版本不兼容时直接重建全部应用数据，不迁移或保留旧索引、设置和观看状态。
            let tables = {
                let mut statement = connection
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                    .app()?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .app()?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .app()?
            };
            connection
                .pragma_update(None, "foreign_keys", false)
                .app()?;
            let transaction = connection.transaction().app()?;
            for table in tables {
                transaction
                    .execute_batch(&format!("DROP TABLE \"{}\"", table.replace('"', "\"\"")))
                    .app()?;
            }
            transaction.commit().app()?;
        }
        connection.execute_batch(include_str!("schema.sql")).app()?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(id,revision,index_revision) VALUES(1,?1,?2)",
                params![random_id(), random_id()],
            )
            .app()?;
        // 扫描暂存和播放权威属于本轮工作；崩溃后不能续用半次扫描或旧播放会话。
        connection.execute_batch("DELETE FROM scan_nodes; DELETE FROM scan_entries; DELETE FROM scan_actor_refs; DELETE FROM scan_libraries; DELETE FROM play_authority;").app()?;
        Ok(Self {
            connection: Mutex::new(Some(connection)),
        })
    }
    pub fn bind_installation(&self, generation: &str, version: &str) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let (old_generation, old_version): (String,String) = tx.query_row("SELECT generation,app_version FROM settings WHERE id=1",[],|row|Ok((row.get(0)?,row.get(1)?))).app()?;
            let components = |value: &str| -> Option<Vec<u64>> { value.split('.').map(str::parse).collect::<std::result::Result<Vec<_>,_>>().ok() };
            let upgraded = matches!((components(&old_version),components(version)),(Some(old),Some(new)) if old.len()==3 && new.len()==3 && new>old);
            let retain_running = old_generation == generation || !old_generation.is_empty() && upgraded;
            // 普通重启保留主动启用状态；同版本重新安装、恢复或停用后重启必须重新启动服务。
            tx.execute("UPDATE settings SET generation=?1,app_version=?2,running=running AND ?3 WHERE id=1",params![generation,version,retain_running]).app()?;
            // 文件变更游标绑定安装 generation；升级保留业务数据，但必须从新 checkpoint 核对索引。
            if old_generation != generation {
                tx.execute("UPDATE settings SET scope_revision='',change_cursor=NULL WHERE id=1", []).app()?;
            }
            tx.commit().app()
        })
    }
    pub fn with<T>(&self, operation: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut connection = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        operation(
            connection
                .as_mut()
                .ok_or_else(|| Error::api(error_code::BACKEND_UNAVAILABLE, "影视应用正在停止"))?,
        )
    }
    pub fn close(&self) {
        if let Some(connection) = self
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let _ = connection.close();
        }
    }
    pub fn settings(&self) -> Result<Settings> {
        self.with(|db| db.query_row("SELECT revision,username,verifier,running,scope_revision,change_cursor,index_revision FROM settings WHERE id=1", [], |r| Ok(Settings { revision: r.get(0)?, username: r.get(1)?, verifier: r.get(2)?, running: r.get(3)?, scope_revision: r.get(4)?, change_cursor: r.get(5)?, index_revision: r.get(6)? })).app())
    }
    pub fn data_revision(&self) -> Result<String> {
        self.with(|db| {
            db.query_row(
                "SELECT revision,index_revision,data_revision FROM settings WHERE id=1",
                [],
                |row| {
                    let parts: (String, String, String) = (row.get(0)?, row.get(1)?, row.get(2)?);
                    Ok(crate::model::guid(&[&parts.0, &parts.1, &parts.2]))
                },
            )
            .app()
        })
    }
    pub fn libraries(&self) -> Result<Vec<Library>> {
        self.with(|db| {
            let mut statement = db
                .prepare("SELECT id,name,kind,root_id FROM libraries ORDER BY position,id")
                .app()?;
            statement
                .query_map([], |r| {
                    Ok(Library {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        root_id: r.get(3)?,
                    })
                })
                .app()?
                .collect::<rusqlite::Result<Vec<_>>>()
                .app()
        })
    }
    pub fn update_account(&self, expected: &str, username: &str, verifier: &str) -> Result<()> {
        self.with(|db| {
            if db.execute("UPDATE settings SET username=?1,verifier=?2,revision=?3 WHERE id=1 AND revision=?4", params![username, verifier, random_id(), expected]).app()? != 1 { return Err(Error::api(error_code::STORAGE_CONFLICT, "影视设置已改变，请重新读取")); }
            Ok(())
        })
    }
    pub fn set_running(&self, expected: &str, running: bool) -> Result<()> {
        self.with(|db| {
            if db
                .execute(
                    "UPDATE settings SET running=?1,revision=?2 WHERE id=1 AND revision=?3",
                    params![running, random_id(), expected],
                )
                .app()?
                != 1
            {
                return Err(Error::api(
                    error_code::STORAGE_CONFLICT,
                    "影视设置已改变，请重新读取",
                ));
            }
            Ok(())
        })
    }
    pub fn set_libraries(&self, expected: &str, libraries: &[Library]) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            if tx.execute("UPDATE settings SET revision=?1,scope_revision='',change_cursor=NULL WHERE id=1 AND revision=?2", params![random_id(), expected]).app()? != 1 { return Err(Error::api(error_code::STORAGE_CONFLICT, "影视设置已改变，请重新读取")); }
            tx.execute("DELETE FROM libraries", []).app()?;
            for (position, library) in libraries.iter().enumerate() { tx.execute("INSERT INTO libraries(id,name,kind,root_id,position) VALUES(?1,?2,?3,?4,?5)", params![library.id, library.name, library.kind, library.root_id, position as i64]).app()?; }
            tx.execute("DELETE FROM entry_libraries WHERE library_id NOT IN (SELECT id FROM libraries)", []).app()?;
            tx.execute("DELETE FROM node_libraries WHERE library_id NOT IN (SELECT id FROM libraries)", []).app()?;
            tx.execute("DELETE FROM entries WHERE node_id NOT IN (SELECT node_id FROM entry_libraries)", []).app()?;
            rebuild_catalog(&tx)?;
            tx.commit().app()
        })
    }
    pub fn checkpoint(&self, scope: &str, cursor: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "UPDATE settings SET scope_revision=?1,change_cursor=?2 WHERE id=1",
                params![scope, cursor],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn begin_scan(&self, libraries: &[Library]) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            tx.execute_batch(
                "DELETE FROM scan_nodes; DELETE FROM scan_entries; DELETE FROM scan_actor_refs; DELETE FROM scan_libraries;",
            )
            .app()?;
            for library in libraries {
                tx.execute("INSERT INTO scan_libraries(id) VALUES(?1)", [&library.id])
                    .app()?;
            }
            tx.commit().app()
        })
    }
    pub fn scan_nodes(&self, library: &str, nodes: &[FileNode]) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            for node in nodes { tx.execute("INSERT INTO scan_nodes(library_id,id,parent_id,path,kind,extension,name_key,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(library_id,id) DO UPDATE SET parent_id=excluded.parent_id,path=excluded.path,kind=excluded.kind,extension=excluded.extension,name_key=excluded.name_key,document=excluded.document", params![library, node.id, node.parent_id, node.path, if node.kind == tgdrive_contract::files::NodeKind::File { "file" } else { "directory" }, crate::model::extension(&node.name), crate::page_files::name_key(&node.name), serde_json::to_string(node)?]).app()?; }
            tx.commit().app()
        })
    }
    pub fn scan_videos(&self, library: &str, cursor: &str) -> Result<Vec<FileNode>> {
        self.with(|db| {
            let mut s = db.prepare("SELECT document FROM scan_nodes WHERE library_id=?1 AND id>?2 AND extension IN ('mp4','mkv','mov','m4v','webm','avi','ts','m2ts','mts','flv','wmv','ogv','3gp') ORDER BY id LIMIT 200").app()?;
            s.query_map(params![library, cursor], |r| r.get::<_, String>(0)).app()?.map(|r| json(&r.app()?)).collect()
        })
    }
    pub fn scan_node(&self, library: &str, id: &str) -> Result<Option<FileNode>> {
        self.scan_find(library, "id", id)
    }
    pub fn scan_path(&self, library: &str, path: &str) -> Result<Option<FileNode>> {
        self.scan_find(library, "path", path)
    }
    fn scan_find(&self, library: &str, column: &str, value: &str) -> Result<Option<FileNode>> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT document FROM scan_nodes WHERE library_id=?1 AND {column}=?2"),
                params![library, value],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()?
            .map(|raw| json(&raw))
            .transpose()
        })
    }
    pub fn scan_related(&self, library: &str, parent: &str) -> Result<Vec<FileNode>> {
        self.with(|db| {
            let mut s = db.prepare("SELECT document FROM scan_nodes WHERE library_id=?1 AND parent_id=?2 AND extension IN ('nfo','jpg','jpeg','png','webp','srt','vtt','ass','ssa') ORDER BY id").app()?;
            s.query_map(params![library, parent], |r| r.get::<_, String>(0)).app()?.map(|r| json(&r.app()?)).collect()
        })
    }
    pub fn scan_entry(&self, library: &str, entry: &Entry) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let mut compact = entry.clone();
            compact.actors.clear(); compact.show_actors.clear();
            tx.execute("INSERT INTO scan_entries(library_id,node_id,document) VALUES(?1,?2,?3)", params![library,entry.node_id,serde_json::to_string(&compact)?]).app()?;
            for (is_show, actors) in [(false,&entry.actors),(true,&entry.show_actors)] {
                for (position, actor) in actors.iter().enumerate() {
                    let key = crate::model::guid(&[&actor.metadata.guid("actor"),&position.to_string(),&actor.metadata.path,&actor.updated_at.to_string(),&actor.portrait.as_ref().map(|source|format!("{}:{}",source.guid("portrait"),source.path)).unwrap_or_default()]);
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM actor_records WHERE key=?1)",[&key],|row|row.get(0)).app()?;
                    if !exists { tx.execute("INSERT INTO actor_records(key,person_id,metadata_id,document) VALUES(?1,?2,?3,?4)",params![key,crate::persons::identity(actor),actor.metadata.id,serde_json::to_string(actor)?]).app()?; }
                    tx.execute("INSERT INTO scan_actor_refs(library_id,node_id,is_show,position,record_key) VALUES(?1,?2,?3,?4,?5)",params![library,entry.node_id,is_show,position as i64,key]).app()?;
                }
            }
            tx.commit().app()
        })
    }
    pub fn publish(&self, expected: &str, scope: &str, cursor: &str) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let revision: String = tx.query_row("SELECT revision FROM settings WHERE id=1", [], |r| r.get(0)).app()?;
            if revision != expected { return Err(Error::api(error_code::STORAGE_CONFLICT, "扫描期间影视设置发生改变")); }
            tx.execute_batch("DELETE FROM node_libraries WHERE library_id IN (SELECT id FROM scan_libraries); DELETE FROM entry_libraries WHERE library_id IN (SELECT id FROM scan_libraries); INSERT INTO node_libraries SELECT library_id,id FROM scan_nodes; INSERT INTO entry_libraries SELECT library_id,node_id,json_extract(document,'$.guid') FROM scan_entries;").app()?;
            tx.execute_batch("INSERT INTO nodes SELECT id,parent_id,path,kind,extension,name_key,document FROM scan_nodes WHERE library_id=(SELECT min(n.library_id) FROM scan_nodes n WHERE n.id=scan_nodes.id) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,path=excluded.path,kind=excluded.kind,extension=excluded.extension,name_key=excluded.name_key,document=excluded.document;").app()?;
            {
                let mut read = tx.prepare("SELECT document FROM scan_entries WHERE library_id=(SELECT min(e.library_id) FROM scan_entries e WHERE e.node_id=scan_entries.node_id) ORDER BY node_id").app()?;
                let mut records = read.query([]).app()?;
                while let Some(row) = records.next().app()? {
                    let raw: String = row.get(0).app()?;
                    let e: Entry = json(&raw)?;
                    tx.execute("INSERT INTO entries(node_id,guid,media_guid,kind,title,folded_title,added_at,modified_at,show_guid,season_guid,season,episode,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(node_id) DO UPDATE SET guid=excluded.guid,media_guid=excluded.media_guid,kind=excluded.kind,title=excluded.title,folded_title=excluded.folded_title,added_at=excluded.added_at,modified_at=excluded.modified_at,show_guid=excluded.show_guid,season_guid=excluded.season_guid,season=excluded.season,episode=excluded.episode,document=excluded.document", params![e.node_id,e.guid,e.media_guid,e.kind,e.title,e.title.to_lowercase(),e.added_at,e.timestamp,e.show_guid,e.season_guid(),e.season,e.episode,raw]).app()?;
                    tx.execute("DELETE FROM cover_states WHERE media_guid=?1 AND fingerprint!=CASE json_extract(document,'$.kind') WHEN 'sidecar' THEN ?2 WHEN 'frame' THEN ?3 ELSE ?4 END", params![e.media_guid,crate::covers::fingerprint_for(&e,"sidecar"),crate::covers::fingerprint_for(&e,"frame"),crate::covers::fingerprint(&e)]).app()?;
                    tx.execute("DELETE FROM attachments WHERE entry_id=?1", [&e.node_id]).app()?;
                    for source in &e.subtitles { tx.execute("INSERT INTO attachments(guid,entry_id,document) VALUES(?1,?2,?3)",params![source.guid("subtitle"),e.node_id,serde_json::to_string(source)?]).app()?; }
                    tx.execute("DELETE FROM person_records WHERE node_id=?1", [&e.node_id]).app()?;
                    tx.execute("INSERT INTO person_records(person_id,node_id,is_show,position,metadata_id,document) SELECT a.person_id,r.node_id,r.is_show,r.position,a.metadata_id,r.record_key FROM scan_actor_refs r JOIN actor_records a ON a.key=r.record_key WHERE r.node_id=?1 AND r.library_id=?2",params![e.node_id,e.libraries[0]]).app()?;
                }
            }
            tx.execute_batch("DELETE FROM entries WHERE node_id NOT IN (SELECT node_id FROM entry_libraries); DELETE FROM nodes WHERE id NOT IN (SELECT node_id FROM node_libraries); DELETE FROM person_records WHERE node_id NOT IN (SELECT node_id FROM entries); DELETE FROM attachments WHERE entry_id NOT IN (SELECT node_id FROM entries); DELETE FROM probes WHERE media_guid NOT IN (SELECT media_guid FROM entries); DELETE FROM cover_states WHERE media_guid NOT IN (SELECT media_guid FROM entries);").app()?;
            rebuild_catalog(&tx)?;
            tx.execute("UPDATE settings SET scope_revision=?1,change_cursor=?2,index_revision=?3 WHERE id=1", params![scope,cursor,random_id()]).app()?;
            tx.execute_batch("DELETE FROM scan_nodes; DELETE FROM scan_entries; DELETE FROM scan_actor_refs; DELETE FROM scan_libraries; DELETE FROM actor_records WHERE key NOT IN (SELECT document FROM person_records);").app()?;
            tx.commit().app()
        })
    }
    pub fn entry(&self, reference: &str) -> Result<Option<Entry>> {
        self.with(|db| {
            let record = db
                .query_row(
                    "SELECT e.document,COALESCE(c.guid,(SELECT l.item_guid FROM entry_libraries l WHERE l.node_id=e.node_id ORDER BY l.library_id LIMIT 1)) FROM entries e LEFT JOIN catalog c ON c.guid=?1 AND c.kind NOT IN ('TV','Season') AND c.representative=e.node_id WHERE e.node_id=?1 OR e.media_guid=?1 OR c.guid=?1 LIMIT 1",
                    [reference],
                    |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?)),
                )
                .optional()
                .app()?;
            let Some((raw, item_guid)) = record else {
                return Ok(None);
            };
            let mut entry: Entry = json(&raw)?;
            entry.guid = item_guid;
            let mut actors = db.prepare("SELECT p.is_show,a.document FROM person_records p JOIN actor_records a ON a.key=p.document WHERE p.node_id=?1 ORDER BY p.is_show,p.position").app()?;
            let rows = actors.query_map([&entry.node_id],|row|Ok((row.get::<_,bool>(0)?,row.get::<_,String>(1)?))).app()?;
            for row in rows { let (is_show,raw) = row.app()?; let actor = json(&raw)?; if is_show { entry.show_actors.push(actor); } else { entry.actors.push(actor); } }
            let mut s = db
                .prepare(
                    "SELECT DISTINCT library_id FROM entry_libraries WHERE item_guid=?1 ORDER BY library_id",
                )
                .app()?;
            entry.libraries = s
                .query_map([&entry.guid], |r| r.get(0))
                .app()?
                .collect::<rusqlite::Result<Vec<_>>>()
                .app()?;
            let key: Option<(String,String,String)> = db
                .query_row(
                    "SELECT fingerprint,cache_key,json_extract(document,'$.kind') FROM cover_states WHERE media_guid=?1 AND state='ready'",
                    [&entry.media_guid],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
                )
                .optional()
                .app()?;
            entry.cover = key.filter(|(fingerprint,_,kind)|fingerprint == &crate::covers::fingerprint_for(&entry,kind)).map(|(_,key,_)|key);
            Ok(Some(entry))
        })
    }
    pub fn item_guid(&self, reference: &str, library: &str) -> Result<Option<String>> {
        self.with(|db| {
            db.query_row(
                "SELECT l.item_guid FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id WHERE (l.item_guid=?1 OR e.node_id=?1 OR e.media_guid=?1) AND (?2='' OR l.library_id=?2) ORDER BY l.library_id,l.item_guid LIMIT 1",
                params![reference, library],
                |row| row.get(0),
            ).optional().app()
        })
    }
    pub fn representative_entry(&self, reference: &str, library: &str) -> Result<Option<Entry>> {
        match self.item_guid(reference, library)? {
            Some(item) => self.entry(&item),
            None => Ok(None),
        }
    }
    pub fn default_entry(&self, reference: &str, library: &str) -> Result<Option<Entry>> {
        let Some(item) = self.item_guid(reference, library)? else {
            return Ok(None);
        };
        let recent: Option<String> = self.with(|db| {
            db.query_row(
                "SELECT e.node_id FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN progress p ON p.media_guid=e.media_guid JOIN nodes n ON n.id=e.node_id WHERE l.item_guid=?1 AND p.updated_at>0 ORDER BY p.updated_at DESC,n.name_key,json_extract(n.document,'$.name'),e.node_id LIMIT 1",
                [&item], |row| row.get(0),
            ).optional().app()
        })?;
        let mut entry = self.entry(recent.as_deref().unwrap_or(&item))?;
        if let Some(entry) = &mut entry {
            entry.guid = item.clone();
            entry.libraries = self.item_libraries(&item)?;
        }
        Ok(entry)
    }
    fn item_libraries(&self, item: &str) -> Result<Vec<String>> {
        self.with(|db| {
            let mut statement = db.prepare("SELECT DISTINCT library_id FROM entry_libraries WHERE item_guid=?1 ORDER BY library_id").app()?;
            statement.query_map([item], |row| row.get(0)).app()?.collect::<rusqlite::Result<Vec<_>>>().app()
        })
    }
    pub fn versions(&self, reference: &str, library: &str) -> Result<Vec<Entry>> {
        let Some(item) = self.item_guid(reference, library)? else {
            return Ok(Vec::new());
        };
        let ids = self.with(|db| {
            let mut statement = db.prepare("SELECT DISTINCT node_id FROM entry_libraries WHERE item_guid=?1 ORDER BY node_id").app()?;
            statement.query_map([&item], |row| row.get::<_, String>(0)).app()?.collect::<rusqlite::Result<Vec<_>>>().app()
        })?;
        let libraries = self.item_libraries(&item)?;
        let mut versions = Vec::with_capacity(ids.len());
        for id in ids {
            let mut entry = self
                .entry(&id)?
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视版本不存在"))?;
            entry.guid = item.clone();
            entry.libraries = libraries.clone();
            versions.push(entry);
        }
        // 版本标签的数字采用自然排序；同标签再按原文件名和节点身份稳定破同值。
        versions.sort_by_key(|entry| {
            (
                crate::page_files::name_key(&entry.version_name),
                crate::page_files::name_key(&entry.filename),
                entry.filename.clone(),
                entry.node_id.clone(),
            )
        });
        Ok(versions)
    }
    pub fn select_entry(&self, item: &str, media: &str) -> Result<Option<Entry>> {
        if media.is_empty() {
            return self.default_entry(item, "");
        }
        let Some(mut entry) = self.entry(media)?.filter(|entry| entry.media_guid == media) else {
            return Ok(None);
        };
        if !item.is_empty() {
            let belongs = self.with(|db| db.query_row("SELECT EXISTS(SELECT 1 FROM entry_libraries WHERE node_id=?1 AND item_guid=?2)", params![entry.node_id,item], |row| row.get::<_,bool>(0)).app())?;
            if !belongs {
                let group = self.catalog(item)?;
                let tv_member = entry.kind == "Episode"
                    && group.is_some_and(|group| {
                        group.kind == "TV" && entry.show_guid == group.guid
                            || group.kind == "Season" && entry.season_guid() == group.guid
                    });
                if tv_member {
                    // 剧／季选择仍定位到原有单集身份，不把电视剧改成电影版本条目。
                    return Ok(Some(entry));
                }
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "媒体文件不属于请求的影片条目",
                ));
            }
            entry.guid = item.into();
            entry.libraries = self.item_libraries(item)?;
        }
        Ok(Some(entry))
    }
    pub fn recent_at(&self, item: &str) -> Result<i64> {
        self.with(|db| db.query_row("SELECT COALESCE(max(p.updated_at),0) FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN progress p ON p.media_guid=e.media_guid WHERE l.item_guid=?1",[item],|row|row.get(0)).app())
    }
    pub fn entries_for_group(&self, reference: &str) -> Result<Vec<Entry>> {
        let ids = self.with(|db| {
            let mut s = db.prepare("SELECT node_id FROM entries WHERE show_guid=?1 OR season_guid=?1 ORDER BY season,episode,guid").app()?;
            s.query_map([reference], |r| r.get::<_,String>(0)).app()?.collect::<rusqlite::Result<Vec<_>>>().app()
        })?;
        ids.iter()
            .map(|id| {
                self.entry(id)?
                    .ok_or_else(|| Error::api(error_code::NOT_FOUND, "影视条目不存在"))
            })
            .collect()
    }
    pub fn entry_ids(&self, after: &str, limit: usize) -> Result<Vec<String>> {
        self.with(|db| {
            let mut s = db
                .prepare("SELECT node_id FROM entries WHERE node_id>?1 ORDER BY node_id LIMIT ?2")
                .app()?;
            s.query_map(params![after, limit as i64], |r| r.get(0))
                .app()?
                .collect::<rusqlite::Result<Vec<_>>>()
                .app()
        })
    }
    pub fn node(&self, id: &str) -> Result<Option<FileNode>> {
        self.with(|db| {
            db.query_row("SELECT document FROM nodes WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .app()?
            .map(|r| json(&r))
            .transpose()
        })
    }
    pub fn catalog(&self, id: &str) -> Result<Option<CatalogItem>> {
        self.with(|db| {
            db.query_row("SELECT document FROM catalog WHERE guid=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .app()?
            .map(|r| json(&r))
            .transpose()
        })
    }
    pub fn get<T: DeserializeOwned>(&self, table: &str, key: &str) -> Result<Option<T>> {
        let column = match table {
            "preferences" => "key",
            "probes" | "progress" => "media_guid",
            "cover_states" => "media_guid",
            _ => return Err(Error::Protocol("影视数据表无效")),
        };
        self.with(|db| {
            db.query_row(
                &format!("SELECT document FROM {table} WHERE {column}=?1"),
                [key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()?
            .map(|r| json(&r))
            .transpose()
        })
    }
    pub fn put_probe(&self, entry: &Entry, info: &MediaInfo) -> Result<()> {
        self.with(|db| { db.execute("INSERT INTO probes(media_guid,document) VALUES(?1,?2) ON CONFLICT(media_guid) DO UPDATE SET document=excluded.document", params![entry.media_guid,serde_json::to_string(info)?]).app()?; Ok(()) })
    }
    pub fn progress(&self, entry: &Entry) -> Result<Progress> {
        Ok(self.get("progress", &entry.media_guid)?.unwrap_or_default())
    }
    pub fn activate(&self, media: &str) -> Result<i64> {
        self.activate_at(media, crate::model::now())?
            .ok_or_else(|| Error::api(error_code::STORAGE_CONFLICT, "此播放已被更新的起播取代"))
    }
    pub fn activate_at(&self, media: &str, started_at: i64) -> Result<Option<i64>> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let previous: Option<i64> = tx.query_row("SELECT started_at FROM play_authority WHERE media_guid=?1", [media], |r| r.get(0)).optional().app()?;
            if previous.is_some_and(|previous| previous > started_at) { return Ok(None); }
            tx.execute("UPDATE settings SET play_serial=play_serial+1 WHERE id=1 AND play_serial<9223372036854775807", []).app()?;
            let serial: i64 = tx.query_row("SELECT play_serial FROM settings WHERE id=1", [], |r| r.get(0)).app()?;
            tx.execute("INSERT INTO play_authority(media_guid,serial,started_at) VALUES(?1,?2,?3) ON CONFLICT(media_guid) DO UPDATE SET serial=excluded.serial,started_at=excluded.started_at", params![media,serial,started_at]).app()?;
            tx.commit().app()?; Ok(Some(serial))
        })
    }
    pub fn save_progress(&self, media: &str, serial: i64, progress: &Progress) -> Result<bool> {
        self.with(|db| { let tx=db.transaction().app()?; let active: Option<i64> = tx.query_row("SELECT serial FROM play_authority WHERE media_guid=?1", [media], |r| r.get(0)).optional().app()?; if active != Some(serial) { return Ok(false); } tx.execute("INSERT INTO progress(media_guid,updated_at,document,revision) VALUES(?1,?2,?3,?4) ON CONFLICT(media_guid) DO UPDATE SET updated_at=excluded.updated_at,document=excluded.document,revision=excluded.revision", params![media,progress.updated_at,serde_json::to_string(progress)?,random_id()]).app()?; tx.commit().app()?; Ok(true) })
    }
    pub fn flags(&self, target: &str) -> Result<(bool, Option<bool>)> {
        self.with(|db| {
            Ok(db
                .query_row(
                    "SELECT favorite,watched FROM flags WHERE target=?1",
                    [target],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .app()?
                .unwrap_or((false, None)))
        })
    }
    pub fn set_flag(&self, target: &str, favorite: bool, enabled: bool) -> Result<()> {
        self.with(|db| { let column=if favorite {"favorite"} else {"watched"}; db.execute(&format!("INSERT INTO flags(target,{column},revision) VALUES(?1,?2,?3) ON CONFLICT(target) DO UPDATE SET {column}=excluded.{column},revision=excluded.revision"), params![target,enabled,random_id()]).app()?; Ok(()) })
    }
    pub fn set_watched_cas(
        &self,
        target: &str,
        enabled: bool,
        expected: Option<&str>,
    ) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let current: Option<String> = tx.query_row("SELECT revision FROM flags WHERE target=?1", [target], |row|row.get(0)).optional().app()?;
            if current.as_deref() != expected { return Err(Error::api(error_code::STORAGE_CONFLICT, "观看标记已由另一个客户端改变")); }
            tx.execute("INSERT INTO flags(target,watched,revision) VALUES(?1,?2,?3) ON CONFLICT(target) DO UPDATE SET watched=excluded.watched,revision=excluded.revision",params![target,enabled,random_id()]).app()?;
            tx.commit().app()
        })
    }
    pub fn set_favorite_cas(
        &self,
        target: &str,
        enabled: bool,
        expected: Option<&str>,
    ) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let current: Option<String> = tx.query_row("SELECT revision FROM flags WHERE target=?1 AND favorite=1", [target], |r| r.get(0)).optional().app()?;
            if current.as_deref() != expected { return Err(Error::api(error_code::STORAGE_CONFLICT, "收藏状态已由另一个页面改变")); }
            tx.execute("INSERT INTO flags(target,favorite,revision) VALUES(?1,?2,?3) ON CONFLICT(target) DO UPDATE SET favorite=excluded.favorite,revision=excluded.revision", params![target,enabled,random_id()]).app()?;
            tx.commit().app()
        })
    }
    pub fn preference<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        expected: Option<&str>,
    ) -> Result<String> {
        self.with(|db| { let tx=db.transaction().app()?; let current: Option<String>=tx.query_row("SELECT revision FROM preferences WHERE key=?1",[key], |r| r.get(0)).optional().app()?; if current.as_deref()!=expected {return Err(Error::api(error_code::STORAGE_CONFLICT,"播放偏好已由其他页面更新"));} let revision=random_id(); tx.execute("INSERT INTO preferences(key,document,revision) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET document=excluded.document,revision=excluded.revision",params![key,serde_json::to_string(value)?,revision]).app()?;tx.commit().app()?;Ok(revision) })
    }
    pub fn preference_record(&self, key: &str) -> Result<Value> {
        self.with(|db| {
            let raw: Option<(String, String)> = db
                .query_row(
                    "SELECT document,revision FROM preferences WHERE key=?1",
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .app()?;
            raw.map(|(raw, revision)| {
                Ok(serde_json::json!({"key":key,"value":json::<Value>(&raw)?,"revision":revision}))
            })
            .unwrap_or(Ok(Value::Null))
        })
    }
}

fn rebuild_catalog(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch("DELETE FROM catalog_libraries; DELETE FROM catalog;")
        .app()?;
    {
        let mut s = tx.prepare("SELECT item_guid,document,library_id,added,modified FROM (SELECT l.item_guid,e.document,l.library_id,min(e.added_at) OVER(PARTITION BY l.item_guid) AS added,max(e.modified_at) OVER(PARTITION BY l.item_guid) AS modified,row_number() OVER(PARTITION BY l.item_guid ORDER BY n.name_key,json_extract(n.document,'$.name'),n.id,l.library_id) AS position FROM entry_libraries l JOIN entries e ON e.node_id=l.node_id JOIN nodes n ON n.id=e.node_id) WHERE position=1 ORDER BY item_guid").app()?;
        let mut rows = s.query([]).app()?;
        while let Some(row) = rows.next().app()? {
            let e: Entry = json(&row.get::<_, String>(1).app()?)?;
            let library: String = row.get(2).app()?;
            let item = CatalogItem {
                guid: row.get(0).app()?,
                kind: e.kind.clone(),
                title: e.title.clone(),
                added_at: row.get(3).app()?,
                modified_at: row.get(4).app()?,
                parent_guid: if e.kind == "Episode" {
                    e.season_guid()
                } else {
                    library
                },
                show_guid: e.show_guid.clone(),
                season: e.season,
                episode: e.episode,
                representative: e.node_id,
                episodes: 0,
                seasons: 0,
            };
            insert_catalog(tx, &item)?;
        }
    }
    for group in ["show_guid", "season_guid"] {
        let mut s=tx.prepare(&format!("SELECT {group},max(added_at),max(modified_at),count(*),count(DISTINCT season) FROM entries WHERE kind='Episode' GROUP BY {group}")).app()?;
        let records = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .app()?;
        for record in records {
            let (id, added, modified, episodes, seasons) = record.app()?;
            let raw:String=tx.query_row(&format!("SELECT document FROM entries WHERE {group}=?1 ORDER BY season,episode,guid LIMIT 1"),[&id],|r|r.get(0)).app()?;
            let e: Entry = json(&raw)?;
            let parent = if group == "show_guid" {
                tx.query_row("SELECT library_id FROM entry_libraries WHERE node_id=?1 ORDER BY library_id LIMIT 1",[&e.node_id],|r|r.get(0)).app()?
            } else {
                e.show_guid.clone()
            };
            insert_catalog(
                tx,
                &CatalogItem {
                    guid: id,
                    kind: if group == "show_guid" { "TV" } else { "Season" }.into(),
                    title: if group == "show_guid" {
                        e.show_title.clone()
                    } else {
                        format!("第 {} 季", e.season)
                    },
                    added_at: added,
                    modified_at: modified,
                    parent_guid: parent,
                    show_guid: e.show_guid,
                    season: e.season,
                    episode: 0,
                    representative: e.node_id,
                    episodes: episodes as u64,
                    seasons: seasons as u64,
                },
            )?;
        }
    }
    tx.execute_batch("INSERT INTO catalog_libraries SELECT item_guid,library_id FROM entry_libraries UNION SELECT e.show_guid,l.library_id FROM entries e JOIN entry_libraries l ON l.node_id=e.node_id WHERE e.kind='Episode' UNION SELECT e.season_guid,l.library_id FROM entries e JOIN entry_libraries l ON l.node_id=e.node_id WHERE e.kind='Episode';").app()?;
    Ok(())
}
fn insert_catalog(tx: &rusqlite::Transaction<'_>, c: &CatalogItem) -> Result<()> {
    tx.execute("INSERT INTO catalog(guid,kind,title,folded_title,added_at,modified_at,parent_guid,show_guid,season,episode,representative,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![c.guid,c.kind,c.title,c.title.to_lowercase(),c.added_at,c.modified_at,c.parent_guid,c.show_guid,c.season,c.episode,c.representative,serde_json::to_string(c)?]).app()?;
    Ok(())
}
