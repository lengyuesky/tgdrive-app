//! 影视应用后端。网盘能力只有 HostClient；自己的 SQLite 统一服务页面与外部客户端。
pub mod catalog;
pub mod covers;
pub mod database;
pub mod fntv;
pub mod index;
pub mod media;
pub mod model;
pub mod nfo;
pub mod page_api;
pub mod page_files;
pub mod persons;
pub mod service;
pub mod wire;

use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use database::Database;
use model::Library;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::Arc;
use tgdrive_backend_sdk::{Error, HostClient, Result};
use tgdrive_contract::{
    error_code,
    files::{NodeKind, NodeReference},
};
use tokio::sync::{Mutex, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

pub struct Application {
    pub host: Arc<dyn HostClient>,
    pub db: Database,
    pub service: service::Service,
    pub index_lock: Mutex<()>,
    pub(crate) read_sync: Mutex<Option<index::ReadSynchronization>>,
    pub cover_wake: Notify,
    pub probe_slots: Arc<Semaphore>,
    pub(crate) pending_probes:
        std::sync::Mutex<std::collections::HashMap<String, Arc<media::ProbeFlight>>>,
    pub(crate) probe_jobs: std::sync::Mutex<tokio::task::JoinSet<()>>,
    pub login_slots: Arc<Semaphore>,
    pub ffprobe_path: String,
    pub ffmpeg_path: String,
    pub page_plays: std::sync::Mutex<std::collections::HashMap<String, (String, i64, i64)>>,
    pub index_wake: Notify,
    pending_leases: std::sync::Mutex<std::collections::HashSet<String>>,
    jobs: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    owner_active: std::sync::atomic::AtomicI64,
    admin_lock: Mutex<()>,
    shutdown: CancellationToken,
}
impl Application {
    pub fn new(
        host: Arc<dyn HostClient>,
        connection: Connection,
        ffprobe_path: String,
        ffmpeg_path: String,
    ) -> Result<Self> {
        Ok(Self {
            host,
            db: Database::new(connection)?,
            service: service::Service::default(),
            index_lock: Mutex::new(()),
            read_sync: Mutex::new(None),
            cover_wake: Notify::new(),
            probe_slots: Arc::new(Semaphore::new(2)),
            pending_probes: std::sync::Mutex::default(),
            probe_jobs: std::sync::Mutex::default(),
            login_slots: Arc::new(Semaphore::new(2)),
            ffprobe_path,
            ffmpeg_path,
            page_plays: std::sync::Mutex::default(),
            index_wake: Notify::new(),
            pending_leases: std::sync::Mutex::default(),
            jobs: std::sync::Mutex::default(),
            owner_active: std::sync::atomic::AtomicI64::new(0),
            admin_lock: Mutex::new(()),
            shutdown: CancellationToken::new(),
        })
    }
    pub fn shutdown_token(&self) -> &CancellationToken {
        &self.shutdown
    }
    pub fn check_background(&self) -> Result<()> {
        if self.shutdown.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    pub fn set_index_status(&self, state: &str, error: &str) -> Result<()> {
        index::set_state(self, state, error)
    }
    pub async fn synchronize(&self, manual: bool) -> Result<()> {
        index::synchronize(self, manual).await
    }
    pub async fn configuration(&self) -> Result<Value> {
        let settings = self.db.settings()?;
        let mut libraries = Vec::new();
        for library in self.db.libraries()? {
            let node = match self
                .host
                .stat(NodeReference::Id {
                    id: library.root_id.clone(),
                    content_version: None,
                })
                .await
            {
                Ok(node) if node.kind == NodeKind::Directory => Some(node),
                Ok(_) => None,
                Err(e) if matches!(e.code(), error_code::NOT_FOUND | error_code::SCOPE_DENIED) => {
                    None
                }
                Err(e) => return Err(e),
            };
            let mut value = serde_json::to_value(&library)?;
            value["path"] = json!(node.as_ref().map(|n| &n.path));
            value["authorized"] = json!(node.is_some());
            libraries.push(value);
        }
        Ok(
            json!({"revision":settings.revision,"username":settings.username,"account_configured":!settings.verifier.is_empty(),"running":settings.running,"libraries":libraries,"index":index::state(self)?}),
        )
    }
    pub async fn configure_account(
        &self,
        expected: &str,
        username: &str,
        password: &str,
    ) -> Result<()> {
        let _guard = self.admin_lock.lock().await;
        if username.trim().is_empty()
            || username.len() > 64
            || username.chars().any(char::is_control)
            || !(8..=128).contains(&password.len())
            || password.chars().any(char::is_control)
        {
            return Err(Error::api(
                error_code::INVALID_REQUEST,
                "账号需为 1 至 64 字节，密码需为 8 至 128 字节且不含控制字符",
            ));
        }
        let password = password.to_owned();
        let verifier = tokio::task::spawn_blocking(move || {
            use sha2::{Digest, Sha256};
            let digest = format!("{:x}", Sha256::digest(password.as_bytes()));
            let salt = SaltString::encode_b64(&rand::random::<[u8; 16]>())
                .map_err(|_| Error::Protocol("影视密码盐生成失败"))?;
            Argon2::default()
                .hash_password(digest.as_bytes(), &salt)
                .map(|hash| hash.to_string())
                .map_err(|_| Error::Protocol("影视密码校验值生成失败"))
        })
        .await
        .map_err(|_| Error::Protocol("影视密码处理失败"))??;
        self.db
            .update_account(expected, username.trim(), &verifier)?;
        self.revoke_sessions().await
    }
    pub async fn configure_libraries(
        &self,
        expected: &str,
        mut libraries: Vec<Library>,
    ) -> Result<Vec<Library>> {
        let _guard = self.admin_lock.lock().await;
        if libraries.len() > 32 {
            return Err(Error::api(
                error_code::INVALID_REQUEST,
                "影视媒体库最多 32 个",
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for library in &mut libraries {
            if library.id.is_empty() {
                library.id = model::random_id();
            }
            if library.id.len() != 32
                || !library.id.bytes().all(|b| b.is_ascii_hexdigit())
                || !ids.insert(library.id.clone())
                || library.name.trim().is_empty()
                || library.name.len() > 160
                || library.name.chars().any(char::is_control)
                || !["movie", "tv"].contains(&library.kind.as_str())
                || !tgdrive_contract::validation::valid_node_id(&library.root_id)
            {
                return Err(Error::api(
                    error_code::INVALID_REQUEST,
                    "媒体库名称、类型或目录身份无效",
                ));
            }
            let node = self
                .host
                .stat(NodeReference::Id {
                    id: library.root_id.clone(),
                    content_version: None,
                })
                .await?;
            if node.kind != NodeKind::Directory {
                return Err(Error::api(
                    error_code::NOT_DIRECTORY,
                    "媒体库根必须是已授权目录",
                ));
            }
            library.name = library.name.trim().into();
        }
        self.db.set_libraries(expected, &libraries)?;
        self.revoke_sessions().await?;
        if libraries.is_empty() {
            let settings = self.db.settings()?;
            self.db.set_running(&settings.revision, false)?;
        }
        Ok(libraries)
    }
    pub async fn revoke_sessions(&self) -> Result<()> {
        let leases = self.service.invalidate();
        self.pending_leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(leases);
        self.flush_revocations().await
    }
    pub async fn flush_revocations(&self) -> Result<()> {
        use futures_util::StreamExt;
        let leases: Vec<_> = self
            .pending_leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        let results = futures_util::stream::iter(leases)
            .map(|lease| async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    self.host.revoke_read_lease(lease.clone()),
                )
                .await;
                (lease, result)
            })
            .buffer_unordered(32)
            .collect::<Vec<_>>()
            .await;
        let mut failed = false;
        let mut pending = self
            .pending_leases
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (lease, result) in results {
            if matches!(result, Ok(Ok(()))) {
                pending.remove(&lease);
            } else {
                failed = true;
            }
        }
        if failed {
            Err(Error::api(
                error_code::UPSTREAM_UNAVAILABLE,
                "新影视请求已拒绝，但部分在途读取的撤销尚未确认，正在重试",
            ))
        } else {
            Ok(())
        }
    }
    pub async fn start_service(&self, expected: &str) -> Result<()> {
        let _guard = self.admin_lock.lock().await;
        let settings = self.db.settings()?;
        if settings.username.is_empty()
            || settings.verifier.is_empty()
            || !self.configuration().await?["libraries"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["authorized"] == true))
        {
            return Err(Error::api(
                error_code::INVALID_REQUEST,
                "请先设置影视连接账号并创建已授权媒体库",
            ));
        }
        if !media::available(&self.ffprobe_path).await {
            return Err(Error::api(
                error_code::CAPABILITY_UNAVAILABLE,
                "上下文指定的 FFprobe 不可用",
            ));
        }
        self.db.set_running(expected, true)?;
        self.revoke_sessions().await?;
        self.index_wake.notify_one();
        self.cover_wake.notify_one();
        Ok(())
    }
    pub async fn stop_service(&self, expected: &str) -> Result<()> {
        let _guard = self.admin_lock.lock().await;
        self.db.set_running(expected, false)?;
        self.revoke_sessions().await
    }
    pub async fn handle(
        self: Arc<Self>,
        context: tgdrive_contract::runtime::ForwardContext,
        method: tgdrive_backend_sdk::http::Method,
        path: String,
        headers: tgdrive_backend_sdk::http::HeaderMap,
        value: Value,
    ) -> Result<tgdrive_backend_sdk::HttpResponse> {
        use tgdrive_contract::runtime::{ForwardCaller, ForwardEntry};
        if context.app_id != "cinema"
            || matches!(
                (context.caller, context.entry),
                (
                    ForwardCaller::Owner,
                    ForwardEntry::Root | ForwardEntry::Prefix
                ) | (ForwardCaller::External, ForwardEntry::Page)
            )
            || path == "/_tgdrive"
            || path.starts_with("/_tgdrive/")
        {
            return Err(Error::api(
                error_code::CALLER_NOT_ALLOWED,
                "影视调用方或路由入口无效",
            ));
        }
        match context.caller {
            ForwardCaller::Owner => {
                self.owner_active
                    .store(model::now() + 300_000, std::sync::atomic::Ordering::Release);
                page_api::request(self, &method, &path, &value).await
            }
            ForwardCaller::External => {
                fntv::request(self, &context, &method, &path, &headers, &value).await
            }
        }
    }
    pub async fn event(&self, event: &tgdrive_contract::events::HostEvent) -> Result<()> {
        use tgdrive_contract::events::{KnownHostEvent, event_name};
        match event.known()? {
            Some(KnownHostEvent::StreamStarted(started)) => {
                self.service
                    .started(&self.db, &started, event.occurred_at.0)?;
            }
            Some(KnownHostEvent::StreamFinished(finished)) => {
                self.service.finished(&finished.request_id);
                self.cover_wake.notify_one();
            }
            Some(KnownHostEvent::ScopeChanged(_)) => {
                self.revoke_sessions().await?;
                self.index_wake.notify_one();
            }
            _ if matches!(
                event.event.as_str(),
                event_name::FILES_CHANGED | event_name::SYNC_REQUIRED
            ) =>
            {
                self.index_wake.notify_one();
            }
            _ => {}
        }
        Ok(())
    }
    pub fn start_jobs(self: &Arc<Self>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if !jobs.is_empty() {
            return;
        }
        let index = self.clone();
        jobs.push(tokio::spawn(async move { loop { if index.shutdown.is_cancelled() { break; } let _ = index::synchronize_read(&index).await; let _ = covers::schedule(&index, false); let _ = index.flush_revocations().await; for lease in index.service.expired() { let _ = index.host.revoke_read_lease(lease).await; } tokio::select! { _ = index.shutdown.cancelled() => break, _ = index.index_wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {} } } }));
        let cover = self.clone();
        jobs.push(tokio::spawn(async move { loop { if cover.shutdown.is_cancelled() { break; } let active = cover.db.settings().is_ok_and(|s| s.running) || cover.owner_active.load(std::sync::atomic::Ordering::Acquire) > model::now(); if active && matches!(covers::process_next(&cover).await, Ok(true)) { continue; } tokio::select! { _ = cover.shutdown.cancelled() => break, _ = cover.cover_wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {} } } }));
        let events = self.clone();
        jobs.push(tokio::spawn(async move { use futures_util::StreamExt; let mut cursor = None; loop { let stream = tokio::select! { _ = events.shutdown.cancelled() => break, result = events.host.events(cursor.clone()) => result }; if let Ok(mut stream) = stream { loop { let event = tokio::select! { _ = events.shutdown.cancelled() => return, event = stream.next() => event }; let Some(Ok(event)) = event else { break; }; cursor = Some(event.cursor.clone()); let _ = events.event(&event).await; } } tokio::select! { _ = events.shutdown.cancelled() => break, _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {} } } }));
    }
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let _ = self.revoke_sessions().await;
        let jobs = std::mem::take(&mut *self.jobs.lock().unwrap_or_else(|e| e.into_inner()));
        for job in jobs {
            let abort = job.abort_handle();
            if tokio::time::timeout(std::time::Duration::from_secs(1), job)
                .await
                .is_err()
            {
                abort.abort();
            }
        }
        let mut probes =
            std::mem::take(&mut *self.probe_jobs.lock().unwrap_or_else(|e| e.into_inner()));
        if tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while probes.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            probes.shutdown().await;
        }
        self.db.close();
    }
}
