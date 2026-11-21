//! 设置、秘密、操作记录与完整条件请求只保存在本应用的一份 SQLite 中。
use crate::model::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use std::{collections::HashSet, sync::Mutex};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{error_code, files::FileNode};

pub trait SqlResult<T> {
    fn app(self) -> Result<T>;
}
impl<T> SqlResult<T> for rusqlite::Result<T> {
    fn app(self) -> Result<T> {
        self.map_err(|_| {
            Error::api(
                error_code::STORAGE_UNAVAILABLE,
                "刮削操作记录未能保存或读取",
            )
        })
    }
}
pub(crate) fn decode<T: DeserializeOwned>(raw: &str) -> Result<T> {
    serde_json::from_str(raw).map_err(|_| {
        Error::api(
            error_code::STORAGE_UNAVAILABLE,
            "刮削操作记录不完整，请恢复应用备份",
        )
    })
}
pub struct Database {
    connection: Mutex<Option<Connection>>,
}
impl Database {
    pub fn new(connection: Connection) -> Result<Self> {
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .app()?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .app()?;
        if version > 1 {
            return Err(Error::api(
                error_code::STORAGE_UNAVAILABLE,
                "刮削应用数据库版本较新，不能降级打开",
            ));
        }
        connection.execute_batch(include_str!("schema.sql")).app()?;
        connection
            .execute(
                "INSERT OR IGNORE INTO settings(id,revision,backend_url) VALUES(1,?1,?2)",
                params![random_id(), DEFAULT_URL],
            )
            .app()?;
        let db = Self {
            connection: Mutex::new(Some(connection)),
        };
        db.interrupt_active("应用后端已中断；不会自动续跑，请重试未完成项")?;
        db.prune(now())?;
        Ok(db)
    }
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        f(guard
            .as_mut()
            .ok_or_else(|| Error::api(error_code::BACKEND_UNAVAILABLE, "刮削应用正在停止"))?)
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
        self.with(|db| {
            let (revision, backend_url, token, overwrite_nfo, overwrite_poster, directory): (String,String,Option<String>,bool,bool,Option<String>) = db.query_row("SELECT revision,backend_url,token,overwrite_nfo,overwrite_poster,directory FROM settings WHERE id=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).app()?;
            Ok(Settings { view: SettingsView { revision,backend_url,token_configured: token.is_some(),overwrite_nfo,overwrite_poster,directory: directory.as_deref().map(decode).transpose()? },token })
        })
    }
    pub fn configure(&self, input: ConfigureRequest) -> Result<SettingsView> {
        self.with(|db| {
            let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE state IN ('scanning','running','stopping'))", [], |r| r.get(0)).app()?;
            if active { return Err(Error::api(error_code::INVALID_OPERATION, "刮削任务结束后才能修改设置")); }
            // null 保留已配置 Token；空字符串明确清除。Token 不进入公开回读对象。
            let old: Option<String> = db.query_row("SELECT token FROM settings WHERE id=1", [], |r| r.get(0)).app()?;
            let token = input.token.map(|s| s.trim().to_owned()).map(|s| (!s.is_empty()).then_some(s)).unwrap_or(old);
            if db.execute("UPDATE settings SET revision=?1,backend_url=?2,token=?3,overwrite_nfo=?4,overwrite_poster=?5 WHERE id=1 AND revision=?6", params![random_id(),input.backend_url,token,input.overwrite_nfo,input.overwrite_poster,input.revision]).app()? != 1 {
                return Err(Error::api(error_code::STORAGE_CONFLICT, "设置已被另一个页面修改，请重新读取"));
            }
            Ok(())
        })?;
        Ok(self.settings()?.view)
    }
    pub fn interrupt_active(&self, message: &str) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            let mut s = tx.prepare("SELECT document FROM items WHERE run_id IN (SELECT id FROM runs WHERE state IN ('scanning','running','stopping')) AND state='processing'").app()?;
            let items: Vec<String> = s.query_map([], |r| r.get(0)).app()?.collect::<rusqlite::Result<_>>().app()?;
            drop(s);
            for raw in items {
                let mut item: Item = decode(&raw)?;
                let unknown: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM steps WHERE item_id=?1 AND state IN ('creating','uploading','committing','unknown'))", [&item.id], |r| r.get(0)).app()?;
                item.state = if unknown { "needs_verification" } else { "stopped" }.into();
                item.reason = message.into();
                tx.execute("UPDATE items SET state=?1,document=?2 WHERE id=?3", params![item.state,serde_json::to_string(&item)?,item.id]).app()?;
            }
            tx.execute("UPDATE runs SET state='interrupted',message=?1 WHERE state IN ('scanning','running','stopping')", [message]).app()?;
            tx.commit().app()
        })
    }
    pub fn prune(&self, time: i64) -> Result<usize> {
        self.with(|db| db.execute("DELETE FROM runs WHERE updated_at<?1 AND state NOT IN ('scanning','running','stopping')", [time.saturating_sub(RETENTION_MILLIS)]).app())
    }
    /// 尚未完成扫描的重试没有新文件步骤，后续重试仍先核实真正的原任务。
    pub fn retry_origin(&self, id: &str) -> Result<String> {
        self.with(|db| {
            let mut id = id.to_owned();
            let mut seen = HashSet::new();
            loop {
                if !seen.insert(id.clone()) {
                    return Err(Error::api(
                        error_code::STORAGE_UNAVAILABLE,
                        "重试来源记录出现循环，未执行新任务",
                    ));
                }
                let (state, complete, previous): (String, bool, Option<String>) = db
                    .query_row(
                        "SELECT state,scan_complete,retry_of FROM runs WHERE id=?1",
                        [&id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .app()?
                    .ok_or_else(|| {
                        Error::api(error_code::NOT_FOUND, "原任务不存在或已超过保留期")
                    })?;
                if matches!(state.as_str(), "running" | "scanning" | "stopping") {
                    return Err(Error::api(
                        error_code::INVALID_OPERATION,
                        "原任务尚未结束，不能重试",
                    ));
                }
                if complete || previous.is_none() {
                    return Ok(id);
                }
                id = previous.expect("未扫描重试已确认有来源");
            }
        })
    }
    pub fn insert_run(
        &self,
        request: &StartRequest,
        root: &FileNode,
        scope: &str,
        settings: &SettingsView,
        retry_of: Option<&str>,
    ) -> Result<Run> {
        let id = random_id();
        let time = now();
        self.with(|db| {
            let tx = db.transaction().app()?;
            tx.execute("INSERT INTO runs(id,request_id,request,root,scope_revision,state,created_at,updated_at,retry_of,overwrite_nfo,overwrite_poster) VALUES(?1,?2,?3,?4,?5,'scanning',?6,?6,?7,?8,?9)", params![id,request.request_id,serde_json::to_string(request)?,serde_json::to_string(root)?,scope,time,retry_of,request.retry_of.is_none() && settings.overwrite_nfo,request.retry_of.is_none() && settings.overwrite_poster]).app()?;
            tx.execute("INSERT INTO run_config(run_id,backend_url) VALUES(?1,?2)", params![id, settings.backend_url]).app()?;
            tx.execute("UPDATE settings SET directory=?1 WHERE id=1", [serde_json::to_string(root)?]).app()?;
            tx.commit().app()
        })?;
        self.run(&id)
    }
    pub fn request_run(&self, request: &StartRequest) -> Result<Option<Run>> {
        let id: Option<(String, String)> = self.with(|db| {
            db.query_row(
                "SELECT id,request FROM runs WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .app()
        })?;
        let Some((id, raw)) = id else {
            return Ok(None);
        };
        if raw != serde_json::to_string(request)? {
            return Err(Error::api(
                error_code::IDEMPOTENCY_CONFLICT,
                "任务请求标识不能用于不同目录或重试操作",
            ));
        }
        self.run(&id).map(Some)
    }
    pub fn run(&self, id: &str) -> Result<Run> {
        self.with(|db| {
            let row = db.query_row("SELECT root,scope_revision,state,message,created_at,updated_at,scan_complete,retry_of FROM runs WHERE id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,bool>(6)?,r.get::<_,Option<String>>(7)?))).optional().app()?.ok_or_else(|| Error::api(error_code::NOT_FOUND, "刮削操作记录不存在或已超过保留期"))?;
            let counts = db.query_row("SELECT COALESCE(SUM(video_count),0),COALESCE(SUM(CASE WHEN state='done' THEN video_count ELSE 0 END),0),COALESCE(SUM(CASE WHEN state='skipped' THEN video_count ELSE 0 END),0),COALESCE(SUM(CASE WHEN state IN ('failed','needs_verification') THEN video_count ELSE 0 END),0) FROM items WHERE run_id=?1", [id], |r| Ok(Counts { total:r.get(0)?,done:r.get(1)?,skipped:r.get(2)?,failed:r.get(3)?,processed:0 })).app()?;
            let counts = if !row.6 {
                Counts { total: db.query_row("SELECT COUNT(*) FROM scan_nodes WHERE run_id=?1", [id], |r| r.get(0)).app()?, ..counts }
            } else { counts };
            let counts = Counts { processed: counts.done.saturating_add(counts.skipped).saturating_add(counts.failed), ..counts };
            Ok(Run { id:id.into(),root:decode(&row.0)?,scope_revision:row.1,state:row.2,message:row.3,created_at:row.4,updated_at:row.5,scan_complete:row.6,retry_of:row.7,counts })
        })
    }
    pub fn active_run(&self) -> Result<Option<Run>> {
        let id = self.with(|db| {
            db.query_row(
                "SELECT id FROM runs WHERE state IN ('scanning','running','stopping') LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()
        })?;
        id.map(|id| self.run(&id)).transpose()
    }
    pub fn run_state(&self, id: &str, state: &str, message: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "UPDATE runs SET state=?1,message=?2,updated_at=?3 WHERE id=?4",
                params![state, message, now(), id],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn save_item(&self, item: &Item) -> Result<()> {
        self.with(|db| {
            let tx = db.transaction().app()?;
            tx.execute("INSERT INTO items(id,run_id,position,document,state,video_count) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET document=excluded.document,state=excluded.state", params![item.id,item.run_id,item.position,serde_json::to_string(item)?,item.state,item.files.len() as i64]).app()?;
            for file in &item.files { tx.execute("INSERT OR IGNORE INTO item_files(item_id,run_id,node_id) VALUES(?1,?2,?3)", params![item.id,item.run_id,file.id]).app()?; }
            tx.execute("UPDATE runs SET updated_at=?1 WHERE id=?2", params![now(),item.run_id]).app()?;
            tx.commit().app()
        })
    }
    pub fn item(&self, id: &str) -> Result<Item> {
        self.with(|db| {
            db.query_row("SELECT document FROM items WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .app()?
            .map(|s| decode(&s))
            .unwrap_or_else(|| Err(Error::api(error_code::NOT_FOUND, "刮削项目不存在")))
        })
    }
    pub fn items(&self, run: &str, after: i64, limit: u16) -> Result<Vec<Item>> {
        self.with(|db| { let mut s = db.prepare("SELECT document FROM items WHERE run_id=?1 AND position>?2 ORDER BY position LIMIT ?3").app()?; s.query_map(params![run,after,limit], |r| r.get::<_,String>(0)).app()?.map(|r| decode(&r.app()?)).collect() })
    }
    pub fn save_step(&self, step: &Step) -> Result<()> {
        self.with(|db| { db.execute("INSERT INTO steps(id,run_id,item_id,role,state,document,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document", params![step.id,step.run_id,step.item_id,step.role,step.state,serde_json::to_string(step)?,step.created_at]).app()?; Ok(()) })
    }
    pub fn steps(&self, item: &str) -> Result<Vec<Step>> {
        self.with(|db| {
            let mut s = db
                .prepare("SELECT document FROM steps WHERE item_id=?1 ORDER BY rowid")
                .app()?;
            s.query_map([item], |r| r.get::<_, String>(0))
                .app()?
                .map(|r| decode(&r.app()?))
                .collect()
        })
    }
    pub fn attempt(&self, item: &str, stage: &str, provider: &str, reason: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "INSERT INTO attempts(item_id,stage,provider,reason) VALUES(?1,?2,?3,?4)",
                params![item, stage, provider, reason],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn attempts(&self, item: &str, after: i64, limit: u16) -> Result<Vec<Attempt>> {
        self.with(|db| { let mut s = db.prepare("SELECT sequence,stage,provider,reason FROM attempts WHERE item_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").app()?; s.query_map(params![item,after,limit], |r| Ok(Attempt { sequence:r.get(0)?,stage:r.get(1)?,provider:r.get(2)?,reason:r.get(3)? })).app()?.collect::<rusqlite::Result<_>>().app() })
    }
    pub fn source(&self, run: &str, number: &str) -> Result<Option<Movie>> {
        self.with(|db| {
            db.query_row(
                "SELECT movie FROM sources WHERE run_id=?1 AND number_key=?2",
                params![run, normalized_number(number)],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()?
            .map(|s| decode(&s))
            .transpose()
        })
    }
    pub fn adopt_source(&self, run: &str, movie: &Movie) -> Result<()> {
        self.with(|db| {
            db.execute(
                "INSERT OR IGNORE INTO sources(run_id,number_key,movie) VALUES(?1,?2,?3)",
                params![
                    run,
                    normalized_number(&movie.number),
                    serde_json::to_string(movie)?
                ],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn run_options(&self, run: &str) -> Result<(bool, bool)> {
        self.with(|db| {
            db.query_row(
                "SELECT overwrite_nfo,overwrite_poster FROM runs WHERE id=?1",
                [run],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .app()
        })
    }
    pub fn step(&self, id: &str) -> Result<Step> {
        self.with(|db| {
            db.query_row("SELECT document FROM steps WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .app()?
            .map(|raw| decode(&raw))
            .unwrap_or_else(|| Err(Error::api(error_code::NOT_FOUND, "步骤记录不存在")))
        })
    }
    pub fn previous_item(&self, run: &str, node: &str) -> Result<Option<Item>> {
        let id = self.with(|db| {
            db.query_row(
                "SELECT item_id FROM item_files WHERE run_id=?1 AND node_id=?2 LIMIT 1",
                params![run, node],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()
        })?;
        id.map(|id| self.item(&id)).transpose()
    }
    pub fn source_url(&self, run: &str) -> Result<Option<String>> {
        self.with(|db| {
            db.query_row(
                "SELECT backend_url FROM run_config WHERE run_id=?1",
                [run],
                |r| r.get(0),
            )
            .optional()
            .app()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_private_and_compare_and_swap() {
        let db = Database::new(Connection::open_in_memory().unwrap()).unwrap();
        let initial = db.settings().unwrap();
        let input = ConfigureRequest {
            revision: initial.view.revision,
            backend_url: DEFAULT_URL.into(),
            token: Some("synthetic-token".into()),
            overwrite_nfo: true,
            overwrite_poster: false,
        };
        let view = db.configure(input.clone()).unwrap();
        assert!(view.token_configured);
        assert!(
            !serde_json::to_string(&view)
                .unwrap()
                .contains("synthetic-token")
        );
        assert_eq!(
            db.configure(input).unwrap_err().code(),
            error_code::STORAGE_CONFLICT
        );
        let view = db
            .configure(ConfigureRequest {
                revision: view.revision,
                backend_url: DEFAULT_URL.into(),
                token: Some(String::new()),
                overwrite_nfo: false,
                overwrite_poster: false,
            })
            .unwrap();
        assert!(!view.token_configured);
    }
    #[test]
    fn rejects_a_newer_database_schema() {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "user_version", 2).unwrap();
        assert!(Database::new(db).is_err());
    }
}
