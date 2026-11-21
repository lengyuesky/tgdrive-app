//! 视频扫描以 SQLite 暂存，完整分页与增量核对结束后才开始整理；不会全树驻留内存。
use crate::{
    database::{Database, SqlResult, decode},
    model::*,
    planner::cancellable,
};
use rusqlite::params;
use std::collections::HashSet;
use tgdrive_backend_sdk::{Error, HostClient, Result};
use tgdrive_contract::{error_code, files::*};
use tokio_util::sync::CancellationToken;

impl Database {
    pub fn scan_reset(&self, run: &str) -> Result<()> {
        self.with(|db| {
            db.execute("DELETE FROM scan_nodes WHERE run_id=?1", [run])
                .app()?;
            db.execute("DELETE FROM items WHERE run_id=?1", [run])
                .app()?;
            db.execute(
                "UPDATE runs SET scan_cursor=NULL,scan_complete=0 WHERE id=?1",
                [run],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn scan_upsert(&self, run: &str, nodes: &[FileNode], root: &str) -> Result<()> {
        self.with(|db| {
            let tx=db.transaction().app()?;
            for node in nodes {
                if node.kind!=NodeKind::File || !video_name(&node.name) || !inside(root,&node.path) { continue; }
                let id=node.id.parse::<i64>().map_err(|_| Error::Protocol("视频标识不是有效 NodeId"))?;
                let parent=node.parent_id.as_deref().ok_or(Error::Protocol("视频没有父目录"))?;
                tx.execute("INSERT INTO scan_nodes(run_id,id,parent_id,stem_key,document) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(run_id,id) DO UPDATE SET parent_id=excluded.parent_id,stem_key=excluded.stem_key,document=excluded.document",params![run,id,parent,stem(&node.name).to_ascii_lowercase(),serde_json::to_string(node)?]).app()?;
            }
            tx.commit().app()
        })
    }
    fn scan_remove(&self, run: &str, id: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "DELETE FROM scan_nodes WHERE run_id=?1 AND id=?2",
                params![run, id],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn scan_checkpoint(&self, run: &str, cursor: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "UPDATE runs SET scan_cursor=?1,updated_at=?2 WHERE id=?3",
                params![cursor, now(), run],
            )
            .app()?;
            Ok(())
        })
    }
    pub fn scanned_count(&self, run: &str) -> Result<u32> {
        self.with(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM scan_nodes WHERE run_id=?1",
                [run],
                |r| r.get(0),
            )
            .app()
        })
    }
    pub fn prepare_retry(&self, run: &str, old: &str) -> Result<()> {
        self.with(|db| { db.execute("INSERT OR IGNORE INTO retry_nodes(run_id,id) SELECT ?1,f.node_id FROM item_files f JOIN items ON items.id=f.item_id WHERE f.run_id=?2 AND items.state!='done'",params![run,old]).app()?; Ok(()) })
    }
    pub fn retry_file(&self, run: &str, id: &str) -> Result<bool> {
        self.with(|db| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM retry_nodes WHERE run_id=?1 AND id=?2)",
                params![run, id],
                |r| r.get(0),
            )
            .app()
        })
    }
    pub fn materialize_items(&self, run: &Run) -> Result<()> {
        let (mut after_parent, mut after_base) = (String::new(), String::new());
        let mut position = 0i64;
        loop {
            let groups:Vec<(String,String)>=self.with(|db| {
                let mut s=db.prepare("SELECT parent_id,stem_key FROM scan_nodes WHERE run_id=?1 AND (parent_id,stem_key)>(?2,?3) GROUP BY parent_id,stem_key ORDER BY parent_id,stem_key LIMIT 200").app()?;
                s.query_map(params![run.id,after_parent,after_base],|r| Ok((r.get(0)?,r.get(1)?))).app()?.collect::<rusqlite::Result<_>>().app()
            })?;
            if groups.is_empty() {
                break;
            }
            for (parent, base) in groups {
                after_parent = parent.clone();
                after_base = base.clone();
                let files:Vec<FileNode>=self.with(|db| {
                    let mut s=db.prepare("SELECT document FROM scan_nodes WHERE run_id=?1 AND parent_id=?2 AND stem_key=?3 ORDER BY id").app()?;
                    s.query_map(params![run.id,parent,base],|r| r.get::<_,String>(0)).app()?.map(|r| decode(&r.app()?)).collect()
                })?;
                if files.len() > 128 {
                    return Err(Error::api(
                        error_code::QUOTA_EXCEEDED,
                        "同基本名视频超过 128 项记录预算，请先手动处理大小写重名；未截断清单",
                    ));
                }
                let number = infer_number(files.first().ok_or(Error::Protocol("扫描分组为空"))?);
                let item = Item {
                    id: random_id(),
                    run_id: run.id.clone(),
                    position,
                    files,
                    number: number.clone(),
                    state: if number.is_empty() {
                        "skipped"
                    } else {
                        "pending"
                    }
                    .into(),
                    reason: if number.is_empty() {
                        "文件名和所在目录中没有唯一可识别的番号"
                    } else {
                        ""
                    }
                    .into(),
                    target_id: None,
                    actors: Vec::new(),
                    actors_summary: String::new(),
                };
                self.save_item(&item)?;
                position += 1;
            }
        }
        self.with(|db| {
            let tx=db.transaction().app()?; tx.execute("UPDATE runs SET scan_complete=1,state='running',message='正在逐部刮削',updated_at=?1 WHERE id=?2",params![now(),run.id]).app()?;
            // 完整清单已经在项目记录中保存，扫描暂存不冗余保留 30 天。
            tx.execute("DELETE FROM scan_nodes WHERE run_id=?1",[&run.id]).app()?; tx.execute("DELETE FROM retry_nodes WHERE run_id=?1",[&run.id]).app()?; tx.commit().app()
        })
    }
}
pub async fn root_guard(
    host: &dyn HostClient,
    run: &Run,
    cancel: &CancellationToken,
) -> Result<FileNode> {
    let root = cancellable(
        cancel,
        host.stat(NodeReference::Id {
            id: run.root.id.clone(),
            content_version: None,
        }),
    )
    .await?;
    if root.kind != NodeKind::Directory || root.path != run.root.path {
        return Err(Error::api(
            error_code::SCOPE_CHANGED,
            "刮削目录身份或位置已改变，已停止整次任务",
        ));
    }
    let scope = cancellable(cancel, host.scope()).await?;
    if scope.revision != run.scope_revision {
        return Err(Error::api(
            error_code::SCOPE_CHANGED,
            "目录授权已改变，已停止整次任务",
        ));
    }
    Ok(root)
}
pub async fn scan(
    host: &dyn HostClient,
    db: &Database,
    run: &Run,
    cancel: &CancellationToken,
) -> Result<()> {
    let retry = run.retry_of.as_deref().map(|id| db.run(id)).transpose()?;
    if let Some(retry) = retry.as_ref().filter(|r| r.scan_complete) {
        db.prepare_retry(&run.id, &retry.id)?;
    }
    for attempt in 0..=1 {
        db.scan_reset(&run.id)?;
        root_guard(host, run, cancel).await?;
        let mut query = FileQuery {
            roots: vec![run.root.id.clone()],
            recursive: true,
            filter: FileFilter {
                kind: QueryKind::File,
                extensions: VIDEO_EXTENSIONS.iter().map(|s| (*s).into()).collect(),
                ..Default::default()
            },
            sort: NodeSort::Id,
            order: SortOrder::Asc,
            limit: 500,
            cursor: None,
        };
        let mut cursor = None;
        let mut pages = HashSet::new();
        loop {
            let page = cancellable(cancel, host.query(query.clone())).await?;
            if page.scope_revision != run.scope_revision {
                return Err(Error::api(
                    error_code::SCOPE_CHANGED,
                    "扫描期间目录授权已改变",
                ));
            }
            if cursor.is_none() {
                cursor = Some(page.scan_cursor.clone());
                db.scan_checkpoint(&run.id, &page.scan_cursor)?;
            }
            for node in &page.items {
                if node.kind != NodeKind::File
                    || !video_name(&node.name)
                    || !inside(&run.root.path, &node.path)
                {
                    return Err(Error::Protocol("扫描结果超出所选目录或视频筛选"));
                }
            }
            let mut selected = Vec::new();
            for node in page.items {
                if retry.as_ref().is_some_and(|r| r.scan_complete)
                    && !db.retry_file(&run.id, &node.id)?
                {
                    continue;
                }
                selected.push(node);
            }
            db.scan_upsert(&run.id, &selected, &run.root.path)?;
            query.cursor = page.next_cursor;
            if let Some(cursor) = &query.cursor {
                if !pages.insert(cursor.clone()) {
                    return Err(Error::api(
                        error_code::INVALID_CURSOR,
                        "扫描分页游标重复，清单未当作完整结果使用",
                    ));
                }
            } else {
                break;
            }
        }
        let mut cursor = cursor.ok_or(Error::Protocol("扫描没有稳定变更游标"))?;
        let mut pages = HashSet::new();
        let mut rescan = false;
        loop {
            let page = cancellable(
                cancel,
                host.changes(FileChangesRequest {
                    cursor: Some(cursor),
                    limit: 500,
                }),
            )
            .await?;
            if page.scope_revision != run.scope_revision {
                return Err(Error::api(
                    error_code::SCOPE_CHANGED,
                    "增量核对期间目录授权已改变",
                ));
            }
            if page.reset_required {
                rescan = true;
                break;
            }
            for change in page.changes {
                match change {
                    FileChange::Upsert { node } => {
                        db.scan_remove(&run.id, &node.id)?;
                        if retry.as_ref().is_some_and(|r| r.scan_complete)
                            && !db.retry_file(&run.id, &node.id)?
                        {
                            continue;
                        }
                        db.scan_upsert(&run.id, &[node], &run.root.path)?;
                    }
                    FileChange::Removed { id } => db.scan_remove(&run.id, &id)?,
                    FileChange::SubtreeInvalidated {
                        previous_path,
                        current,
                        ..
                    } => {
                        if previous_path
                            .as_deref()
                            .is_some_and(|p| inside(&run.root.path, p) || inside(p, &run.root.path))
                            || current.as_ref().is_some_and(|n| {
                                inside(&run.root.path, &n.path) || inside(&n.path, &run.root.path)
                            })
                        {
                            rescan = true;
                        }
                    }
                }
            }
            cursor = page.next_cursor;
            db.scan_checkpoint(&run.id, &cursor)?;
            if !pages.insert(cursor.clone()) {
                return Err(Error::api(error_code::INVALID_CURSOR, "增量核对游标重复"));
            }
            if rescan || !page.has_more {
                break;
            }
        }
        root_guard(host, run, cancel).await?;
        if rescan {
            if attempt == 1 {
                return Err(Error::api(
                    error_code::CHILDREN_CHANGED,
                    "扫描期间目录持续变化，未把弱一致扫描当成完整快照",
                ));
            }
            continue;
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        db.materialize_items(run)?;
        return Ok(());
    }
    unreachable!()
}
