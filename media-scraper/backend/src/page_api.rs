//! 应用自己的只读进度和操作记录接口，均按键集分页，不暴露 Token 或完整写请求。
use crate::{Application, database::SqlResult, model::*};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tgdrive_backend_sdk::{Error, HttpResponse, Result, json_response};
use tgdrive_contract::error_code;

const PAGE_BYTES: usize = 512 * 1024;
#[derive(Clone, Serialize, Deserialize)]
struct HistoryCursor {
    created_at: i64,
    id: String,
}
#[derive(Serialize, Deserialize)]
struct HistoryRequest {
    cursor: Option<HistoryCursor>,
    limit: u16,
}
#[derive(Serialize, Deserialize)]
struct ItemsRequest {
    run_id: String,
    after: Option<i64>,
    limit: u16,
}
#[derive(Serialize, Deserialize)]
struct DetailRequest {
    item_id: String,
    after: Option<i64>,
    actor_after: Option<usize>,
    attempt_after: Option<i64>,
    limit: u16,
}
#[derive(Serialize)]
pub struct StepBadge {
    pub role: String,
    pub state: String,
}
#[derive(Serialize)]
pub struct ItemSummary {
    pub id: String,
    pub run_id: String,
    pub position: i64,
    pub files: Vec<tgdrive_contract::files::FileNode>,
    pub number: String,
    pub state: String,
    pub reason: String,
    pub target_id: Option<String>,
    pub actors_summary: String,
    pub variant: String,
    pub steps: Vec<StepBadge>,
}
#[derive(Serialize)]
struct StepView {
    id: String,
    role: String,
    state: String,
    name: String,
    message: String,
    file: Option<tgdrive_contract::files::FileNode>,
}
pub(crate) fn request<T: serde::de::DeserializeOwned + Serialize>(
    value: serde_json::Value,
) -> Result<T> {
    tgdrive_backend_sdk::decode_json(&serde_json::to_vec(&value)?)
}
fn limit(value: u16) -> Result<u16> {
    if !(1..=100).contains(&value) {
        Err(Error::api(
            error_code::INVALID_REQUEST,
            "记录页大小须为 1～100",
        ))
    } else {
        Ok(value)
    }
}
fn response<T: Serialize>(value: &T) -> Result<HttpResponse> {
    if serde_json::to_vec(value)?.len() > 8 * 1024 * 1024 {
        return Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "操作记录响应超过 8 MiB 预算；未截断记录",
        ));
    }
    json_response(200, value)
}
impl Application {
    pub fn status(&self) -> Result<HttpResponse> {
        let latest = self.db.with(|db| {
            db.query_row(
                "SELECT id FROM runs ORDER BY created_at DESC,id DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .app()
        })?;
        response(
            &serde_json::json!({"settings":self.db.settings()?.view,"active":self.db.active_run()?,"latest":latest.map(|id| self.db.run(&id)).transpose()?}),
        )
    }
    pub fn history(&self, value: serde_json::Value) -> Result<HttpResponse> {
        let input: HistoryRequest = request(value)?;
        let count = limit(input.limit)?;
        if input.cursor.as_ref().is_some_and(|c| {
            c.created_at < 0 || !tgdrive_contract::validation::valid_opaque_id(&c.id)
        }) {
            return Err(Error::api(error_code::INVALID_CURSOR, "操作记录游标无效"));
        }
        let (time, id) = input.cursor.map(|c| (c.created_at, c.id)).unwrap_or((
            tgdrive_contract::http::MAX_TIMESTAMP_MILLIS as i64,
            "~".into(),
        ));
        let ids:Vec<String>=self.db.with(|db| { let mut s=db.prepare("SELECT id FROM runs WHERE (created_at,id)<(?1,?2) ORDER BY created_at DESC,id DESC LIMIT ?3").app()?; s.query_map(params![time,id,count+1],|r| r.get(0)).app()?.collect::<rusqlite::Result<_>>().app() })?;
        let mut records = Vec::new();
        let mut bytes = 0usize;
        for id in ids.iter().take(count as usize) {
            let run = self.db.run(id)?;
            let size = serde_json::to_vec(&run)?.len();
            if !records.is_empty() && bytes + size > PAGE_BYTES {
                break;
            }
            bytes += size;
            records.push(run);
        }
        let next = if records.len() < ids.len() {
            records.last().map(|r| HistoryCursor {
                created_at: r.created_at,
                id: r.id.clone(),
            })
        } else {
            None
        };
        response(&serde_json::json!({"records":records,"next_cursor":next}))
    }
    fn item_summary(&self, item: Item) -> Result<ItemSummary> {
        let badges=self.db.with(|db| { let mut s=db.prepare("SELECT role,state FROM steps WHERE item_id=?1 AND role IN ('organize','nfo','poster') ORDER BY rowid").app()?; s.query_map([&item.id],|r| Ok(StepBadge { role:r.get(0)?,state:r.get(1)? })).app()?.collect::<rusqlite::Result<Vec<_>>>().app() })?;
        Ok(ItemSummary {
            id: item.id,
            run_id: item.run_id,
            position: item.position,
            files: item.files,
            number: item.number,
            state: item.state,
            reason: item.reason,
            target_id: item.target_id,
            actors_summary: item.actors_summary,
            variant: item.variant,
            steps: badges,
        })
    }
    pub fn items_page(&self, value: serde_json::Value) -> Result<HttpResponse> {
        let input: ItemsRequest = request(value)?;
        let limit = limit(input.limit)?;
        let after = input.after.unwrap_or(-1);
        if after < -1 {
            return Err(Error::api(error_code::INVALID_CURSOR, "结果游标无效"));
        }
        let run = self.db.run(&input.run_id)?;
        let fetched = self.db.items(&input.run_id, after, limit + 1)?;
        let total = fetched.len();
        let mut items = Vec::new();
        let mut bytes = 0usize;
        for item in fetched.into_iter().take(limit as usize) {
            let item = self.item_summary(item)?;
            let size = serde_json::to_vec(&item)?.len();
            if !items.is_empty() && bytes + size > PAGE_BYTES {
                break;
            }
            bytes += size;
            items.push(item);
        }
        let next = if items.len() < total {
            items.last().map(|i| i.position)
        } else {
            None
        };
        response(&serde_json::json!({"run":run,"items":items,"next_after":next}))
    }
    pub fn detail(&self, value: serde_json::Value) -> Result<HttpResponse> {
        let input: DetailRequest = request(value)?;
        let limit = limit(input.limit)?;
        let item = self.db.item(&input.item_id)?;
        let after = input.after.unwrap_or(0);
        let actor_after = input.actor_after.unwrap_or(0);
        if after < 0 || actor_after > item.actors.len() {
            return Err(Error::api(error_code::INVALID_CURSOR, "执行明细游标无效"));
        }
        let rows:Vec<(i64,String)>=self.db.with(|db| { let mut s=db.prepare("SELECT rowid,document FROM steps WHERE item_id=?1 AND rowid>?2 ORDER BY rowid LIMIT ?3").app()?; s.query_map(params![input.item_id,after,limit+1],|r| Ok((r.get(0)?,r.get(1)?))).app()?.collect::<rusqlite::Result<_>>().app() })?;
        let mut steps = Vec::new();
        let mut bytes = 0usize;
        let mut last = after;
        for (sequence, raw) in rows.iter().take(limit as usize) {
            let step: Step = crate::database::decode(raw)?;
            let view = StepView {
                id: step.id,
                role: step.role,
                state: step.state,
                name: step.name,
                message: step.message,
                file: step.file,
            };
            let size = serde_json::to_vec(&view)?.len();
            if !steps.is_empty() && bytes + size > PAGE_BYTES {
                break;
            }
            bytes += size;
            last = *sequence;
            steps.push(view);
        }
        let step_next = if steps.len() < rows.len() {
            Some(last)
        } else {
            None
        };
        let actors: Vec<_> = item
            .actors
            .iter()
            .skip(actor_after)
            .take(limit as usize)
            .cloned()
            .collect();
        let actor_next =
            (actor_after + actors.len() < item.actors.len()).then_some(actor_after + actors.len());
        // 来源错误与步骤分别分页，完整原因不会塞进单个摘要或被截断丢弃。
        let attempt_after = input.attempt_after.unwrap_or(0);
        if attempt_after < 0 {
            return Err(Error::api(error_code::INVALID_CURSOR, "来源错误游标无效"));
        }
        let attempts = self.db.attempts(&item.id, attempt_after, limit + 1)?;
        let attempt_next =
            (attempts.len() > limit as usize).then(|| attempts[limit as usize - 1].sequence);
        let summary = self.item_summary(item)?;
        response(
            &serde_json::json!({"item":summary,"steps":steps,"next_step":step_next,"actors":actors,"next_actor":actor_next,"attempts":attempts.into_iter().take(limit as usize).collect::<Vec<_>>(),"next_attempt":attempt_next}),
        )
    }
}
