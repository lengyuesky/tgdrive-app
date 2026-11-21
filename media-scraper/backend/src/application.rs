//! 主人页面接口与后台任务生命周期；不提供对外服务，不靠页面心跳推进。
use crate::{
    database::{Database, SqlResult},
    engine,
    metatube::{base_url, validate_token},
    model::*,
    writes,
};
use rusqlite::{Connection, OptionalExtension};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tgdrive_backend_sdk::{Error, HostClient, HttpResponse, Result, http::Method, json_response};
use tgdrive_contract::{
    error_code,
    files::*,
    runtime::{BackendKeepaliveRequest, ForwardCaller, ForwardContext, ForwardEntry},
};
use tokio_util::sync::CancellationToken;

struct Job {
    id: String,
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}
pub struct Application {
    pub host: Arc<dyn HostClient>,
    pub db: Database,
    pub process_id: String,
    gate: tokio::sync::Mutex<()>,
    job: Mutex<Option<Job>>,
    stopping: AtomicBool,
}
impl Application {
    pub fn new(
        host: Arc<dyn HostClient>,
        connection: Connection,
        process_id: String,
    ) -> Result<Self> {
        Ok(Self {
            host,
            db: Database::new(connection)?,
            process_id,
            gate: tokio::sync::Mutex::new(()),
            job: Mutex::new(None),
            stopping: AtomicBool::new(false),
        })
    }
    fn available(&self) -> Result<()> {
        if self.stopping.load(Ordering::SeqCst) {
            Err(Error::api(
                error_code::BACKEND_UNAVAILABLE,
                "刮削应用正在停止",
            ))
        } else {
            Ok(())
        }
    }
    pub async fn configure(&self, mut input: ConfigureRequest) -> Result<SettingsView> {
        let _guard = self.gate.lock().await;
        self.available()?;
        input.backend_url = base_url(&input.backend_url)?.to_string();
        if let Some(token) = &mut input.token {
            *token = token.trim().to_owned();
            validate_token((!token.is_empty()).then_some(token.as_str()))?;
        }
        self.db.configure(input)
    }
    pub async fn start(self: &Arc<Self>, request: StartRequest) -> Result<Run> {
        let _guard = self.gate.lock().await;
        self.available()?;
        self.db.prune(now())?;
        if !tgdrive_contract::validation::valid_idempotency_key(&request.request_id)
            || request
                .retry_of
                .as_deref()
                .is_some_and(|id| !tgdrive_contract::validation::valid_opaque_id(id))
        {
            return Err(Error::api(error_code::INVALID_REQUEST, "任务标识格式无效"));
        }
        if let Some(run) = self.db.request_run(&request)? {
            return Ok(run);
        }
        {
            let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
            if job.as_ref().is_some_and(|j| j.handle.is_finished()) {
                job.take();
            }
            if job.is_some() || self.db.active_run()?.is_some() {
                return Err(Error::api(
                    error_code::INVALID_OPERATION,
                    "同一时间只能运行一个刮削任务，上一任务正在执行或收尾",
                ));
            }
        }
        let retry_of = request
            .retry_of
            .as_deref()
            .map(|id| self.db.retry_origin(id))
            .transpose()?;
        let unresolved:Option<String>=self.db.with(|db| db.query_row("SELECT run_id FROM steps WHERE state IN ('creating','uploading','ready','committing','unknown') AND (?1 IS NULL OR run_id!=?1) LIMIT 1",[&retry_of],|r| r.get(0)).optional().app())?;
        if unresolved.is_some() {
            return Err(Error::api(
                writes::NEEDS_VERIFICATION,
                "旧任务还有待核实写入，请先在该操作记录中重试未完成项",
            ));
        }
        let root = self
            .host
            .stat(NodeReference::Id {
                id: request.directory_id.clone(),
                content_version: None,
            })
            .await?;
        if root.kind != NodeKind::Directory {
            return Err(Error::api(error_code::NOT_DIRECTORY, "请选择网盘目录"));
        }
        if let Some(id) = &retry_of {
            let old = self.db.run(id)?;
            if old.root.id != root.id
                || matches!(old.state.as_str(), "running" | "scanning" | "stopping")
            {
                return Err(Error::api(
                    error_code::INVALID_OPERATION,
                    "重试范围须为已经结束的原任务目录",
                ));
            }
        }
        let scope = self.host.scope().await?;
        if !scope.roots.iter().any(|grant| {
            grant.access == AccessLevel::ReadWrite
                && grant
                    .node
                    .as_ref()
                    .is_some_and(|node| inside(&node.path, &root.path))
        }) {
            return Err(Error::api(
                error_code::SCOPE_DENIED,
                "所选目录需要读写授权，请在应用中心确认授权",
            ));
        }
        let settings = self.db.settings()?;
        let run = self.db.insert_run(
            &request,
            &root,
            &scope.revision,
            &settings.view,
            retry_of.as_deref(),
        )?;
        let cancel = CancellationToken::new();
        let app = self.clone();
        let task_run = run.clone();
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            app.work(task_run, task_cancel).await;
        });
        *self.job.lock().unwrap_or_else(|e| e.into_inner()) = Some(Job {
            id: run.id.clone(),
            cancel,
            handle,
        });
        Ok(run)
    }
    async fn work(self: Arc<Self>, run: Run, cancel: CancellationToken) {
        let heartbeat_stop = CancellationToken::new();
        let stop = heartbeat_stop.clone();
        let activity_cancel = cancel.clone();
        let app = self.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                let result = tokio::select! { biased; _=stop.cancelled()=>return, _=activity_cancel.cancelled()=>return, result=app.host.keepalive(BackendKeepaliveRequest { ttl_seconds:120 })=>result };
                if result.is_err() {
                    activity_cancel.cancel();
                    return;
                }
                tokio::select! { biased; _=stop.cancelled()=>return, _=activity_cancel.cancelled()=>return, _=tokio::time::sleep(Duration::from_secs(60))=>{} }
            }
        });
        let result = engine::execute(
            self.host.as_ref(),
            &self.db,
            &self.process_id,
            &run,
            &cancel,
        )
        .await;
        heartbeat_stop.cancel();
        let _ = heartbeat.await;
        let (state, message) = match result {
            Ok(()) => ("completed", "刮削已完成；操作记录保留 30 天".to_owned()),
            Err(Error::Cancelled) => {
                let stopping = !self.stopping.load(Ordering::SeqCst)
                    && self.db.run(&run.id).is_ok_and(|r| r.state == "stopping");
                (
                    if stopping { "cancelled" } else { "interrupted" },
                    if stopping {
                        "刮削已停止，已完成的文件和结果保留"
                    } else {
                        "后端活动或授权已中断，任务不会自动续跑"
                    }
                    .into(),
                )
            }
            Err(error) => (
                if error.code() == writes::NEEDS_VERIFICATION {
                    "interrupted"
                } else {
                    "failed"
                },
                error.to_string(),
            ),
        };
        // 记录失败绝不能触发下一影片；必要时重启初始化会把 processing 标成待核实。
        let _ = engine::finish_remaining(&self.db, &run.id, &message);
        let _ = self.db.run_state(&run.id, state, &message);
    }
    pub async fn stop(&self, id: &str) -> Result<Run> {
        let _guard = self.gate.lock().await;
        self.available()?;
        let run = self.db.run(id)?;
        let job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = job
            .as_ref()
            .filter(|job| job.id == id && !job.handle.is_finished())
        {
            self.db
                .run_state(id, "stopping", "正在停止，等待在途写入收尾或核实")?;
            job.cancel.cancel();
        }
        drop(job);
        if matches!(run.state.as_str(), "running" | "scanning" | "stopping") {
            self.db.run(id)
        } else {
            Ok(run)
        }
    }
    pub async fn wait_idle(&self) {
        loop {
            let done = self
                .job
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_none_or(|j| j.handle.is_finished());
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let job = self.job.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut job) = job {
            job.cancel.cancel();
            let _ = self.db.run_state(&job.id, "stopping", "应用后端正在停止");
            if tokio::time::timeout(Duration::from_secs(8), &mut job.handle)
                .await
                .is_err()
            {
                job.handle.abort();
                let _ = job.handle.await;
            }
        }
        let _ = self
            .db
            .interrupt_active("应用后端已停止，任务不会自动续跑；不明步骤需先核实");
        self.db.close();
    }
    pub async fn handle(
        self: &Arc<Self>,
        context: ForwardContext,
        method: Method,
        path: String,
        value: serde_json::Value,
    ) -> Result<HttpResponse> {
        if context.app_id != "media-scraper"
            || context.caller != ForwardCaller::Owner
            || context.entry != ForwardEntry::Page
        {
            return Err(Error::api(
                error_code::CALLER_NOT_ALLOWED,
                "刮削应用仅提供主人页面接口，不提供对外服务",
            ));
        }
        self.available()?;
        match (method.as_str(), path.as_str()) {
            ("GET", "/owner/settings") => json_response(200, &self.db.settings()?.view),
            ("PUT", "/owner/settings") => json_response(
                200,
                &self.configure(crate::page_api::request(value)?).await?,
            ),
            ("POST", "/owner/runs") => {
                json_response(202, &self.start(crate::page_api::request(value)?).await?)
            }
            ("GET", "/owner/status") => self.status(),
            ("POST", "/owner/stop") => {
                let id = value
                    .get("run_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        Error::api(error_code::INVALID_REQUEST, "停止请求缺少任务标识")
                    })?;
                json_response(200, &self.stop(id).await?)
            }
            ("POST", "/owner/history") => self.history(value),
            ("POST", "/owner/items") => self.items_page(value),
            ("POST", "/owner/detail") => self.detail(value),
            _ => Err(Error::api(error_code::NOT_FOUND, "刮削页面接口不存在")),
        }
    }
}
