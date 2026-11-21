//! 仅测试使用的内存语义核心。没有监听器、可运行宿主或本地网盘部署开关。
//! 页面测试工作进程也使用本 crate，因此不另抄 TypeScript 版授权/范围/CAS 规则。

mod data;
mod direct;
mod mutations;
mod query;
mod state;

use bytes::Bytes;
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use state::State;
use std::sync::{Arc, Mutex};
use tgdrive_backend_sdk::{
    ByteResponse, ByteStream, Error, EventStream, HostClient, HostFuture, ReadOptions, Result,
};
use tgdrive_contract::{
    CONTRACT_VERSION, Timestamp,
    data::*,
    error_code,
    events::{HostEvent, event_name},
    files::*,
    http::*,
    manifest::{FilePermissions, RunMode},
    runtime::*,
    validation::*,
};
use tokio::sync::{Semaphore, broadcast};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SeedNode {
    pub id: String,
    pub parent_id: String,
    pub name: String,
    pub kind: NodeKind,
    #[serde(default)]
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub thumbnail: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub app: AppIdentity,
    pub files: FilePermissions,
    pub scope: DirectoryScope,
    #[serde(default)]
    pub nodes: Vec<SeedNode>,
    #[serde(default = "backend_caller")]
    pub caller: RuntimeCaller,
    #[serde(default = "initial_time")]
    pub now: Timestamp,
    #[serde(default = "has_backend")]
    pub has_backend: bool,
}
fn backend_caller() -> RuntimeCaller {
    RuntimeCaller::Backend
}
fn initial_time() -> Timestamp {
    Timestamp(1)
}
fn has_backend() -> bool {
    true
}

#[derive(Clone)]
pub struct MemoryHost {
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<HostEvent>,
    event_slots: Arc<Semaphore>,
    closed: tokio::sync::watch::Sender<bool>,
    caller_id: String,
    generation: String,
    run_id: String,
    caller: RuntimeCaller,
    started_at: i64,
}
impl MemoryHost {
    pub fn new(config: MemoryConfig) -> Result<Self> {
        let generation = config.app.generation.clone();
        let caller = config.caller;
        let started_at = config.now.0;
        let mut state = State::new(config)?;
        let caller_id = state.id("caller");
        let run_id = state.run_id.clone();
        let (events, _) = broadcast::channel(MAX_EVENT_JOURNAL_ENTRIES as usize);
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            events,
            event_slots: Arc::new(Semaphore::new(MAX_EVENT_CONNECTIONS_PER_CALLER as usize)),
            closed: tokio::sync::watch::channel(false).0,
            caller_id,
            generation,
            run_id,
            caller,
            started_at,
        })
    }
    /// 同一应用的另一测试调用方，共享文件/KV，但拥有独立会话与 SSE 配额。
    pub fn fork(&self, caller: RuntimeCaller) -> Self {
        let mut state = self.state.lock().unwrap();
        let caller_id = state.id("caller");
        Self {
            state: self.state.clone(),
            events: self.events.clone(),
            event_slots: Arc::new(Semaphore::new(MAX_EVENT_CONNECTIONS_PER_CALLER as usize)),
            closed: tokio::sync::watch::channel(false).0,
            caller_id,
            generation: state.config.app.generation.clone(),
            run_id: state.run_id.clone(),
            caller,
            started_at: state.now,
        }
    }
    fn active(&self, state: &State) -> Result<()> {
        if *self.closed.borrow() {
            return Err(Error::api(
                error_code::SESSION_EXPIRED,
                "测试页面会话已关闭",
            ));
        }
        state.active(&self.generation, self.caller, self.started_at)?;
        if self.caller == RuntimeCaller::Backend && state.run_id != self.run_id {
            return Err(Error::api(
                error_code::BACKEND_UNAVAILABLE,
                "测试后端启动轮次已失效",
            ));
        }
        Ok(())
    }
    fn apply<T>(&self, active: bool, operation: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut state = self.state.lock().unwrap();
        if active {
            self.active(&state)?;
        }
        let previous = state.events.back().map(|event| event.cursor.clone());
        let result = operation(&mut state);
        // 通常没有新事件或只新增一条，必须从尾部找增量，不对每个只读/写调用正向扫满日志。
        let mut notifications = state
            .events
            .iter()
            .rev()
            .take_while(|event| previous.as_ref() != Some(&event.cursor))
            .cloned()
            .collect::<Vec<_>>();
        notifications.reverse();
        drop(state);
        for event in notifications {
            let _ = self.events.send(event);
        }
        result
    }
    fn backend(&self) -> Result<()> {
        if self.caller == RuntimeCaller::Backend {
            Ok(())
        } else {
            Err(Error::api(
                error_code::CALLER_NOT_ALLOWED,
                "仅应用后端可调用",
            ))
        }
    }
    fn expiry(&self) -> Option<i64> {
        (self.caller == RuntimeCaller::Page)
            .then_some(self.started_at + PAGE_SESSION_SECONDS as i64 * 1000)
    }
    pub fn close_page_session(&self) -> Result<()> {
        if self.caller != RuntimeCaller::Page {
            return Err(Error::api(
                error_code::CALLER_NOT_ALLOWED,
                "只有页面会话可以关闭",
            ));
        }
        self.apply(true, |state| {
            self.closed.send_replace(true);
            state
                .tickets
                .retain(|_, ticket| ticket.creator != self.caller_id);
            state.leases.retain(|id, _| {
                state
                    .lease_creators
                    .get(id)
                    .is_none_or(|creator| creator != &self.caller_id)
            });
            state
                .lease_creators
                .retain(|_, creator| creator != &self.caller_id);
            Ok(())
        })
    }
    /// 测试配置操作不是应用授权 API；应用只能持有 HostClient 接口。
    pub fn set_scope(&self, scope: DirectoryScope) -> Result<ScopeInfo> {
        self.apply(false, |state| state.set_scope(scope))
    }
    pub fn add_node(&self, node: SeedNode) -> Result<FileNode> {
        self.apply(false, |state| state.add_seed(node))
    }
    pub fn advance(&self, milliseconds: i64) -> Result<()> {
        self.apply(false, |state| {
            let now = state
                .now
                .checked_add(milliseconds)
                .filter(|now| (0..=MAX_TIMESTAMP_MILLIS as i64).contains(now))
                .ok_or(Error::Protocol("测试时间无效"))?;
            state.now = now;
            Ok(())
        })
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        self.apply(false, |state| {
            state.enabled = enabled;
            state.emit(
                event_name::APP_CHANGED,
                serde_json::json!({"generation":state.config.app.generation,"enabled":enabled}),
            );
            Ok(())
        })
    }
    pub fn reinstall(&self) -> Result<()> {
        self.apply(false, |state| { state.config.app.generation = state.id("generation"); state.tickets.clear(); state.leases.clear(); state.uploads.clear(); state.cursors.clear(); state.emit(event_name::APP_CHANGED, serde_json::json!({"generation":state.config.app.generation,"enabled":state.enabled})); Ok(()) })
    }
    pub fn restart(&self) -> Result<()> {
        self.apply(false, |state| {
            state.run_id = state.id("run");
            state.tickets.clear();
            state.leases.clear();
            state
                .uploads
                .retain(|_, upload| upload.info.state == UploadState::Committed);
            state.events.clear();
            state.emit(
                event_name::SYNC_REQUIRED,
                serde_json::json!({"reason":"host_restarted"}),
            );
            Ok(())
        })
    }
    /// 合成主人修改，便于测试授权根跟随身份、游标失效、在途撤权及内容变化。
    pub fn change_node(
        &self,
        id: String,
        parent: Option<String>,
        name: Option<String>,
        bytes: Option<Vec<u8>>,
        visible: Option<bool>,
    ) -> Result<FileNode> {
        self.apply(false, |state| {
            let mut working = state.clone();
            let signature = working.root_signature();
            let was_visible = working.node(&id).is_ok();
            let old = working
                .nodes
                .get(&id)
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "测试节点不存在"))?
                .node
                .clone();
            let ancestors = if was_visible {
                working.ancestors(&id)
            } else {
                Vec::new()
            };
            if id == "1" {
                return Err(Error::api(
                    error_code::INVALID_OPERATION,
                    "测试也不修改根目录",
                ));
            }
            if let Some(parent) = &parent {
                if working.node(parent)?.node.kind != NodeKind::Directory
                    || working.ancestors(parent).contains(&id)
                {
                    return Err(Error::api(error_code::INVALID_OPERATION, "测试移动无效"));
                }
            }
            if name.as_ref().is_some_and(|name| !valid_drive_name(name)) {
                return Err(Error::Protocol("测试名称无效"));
            }
            let next_parent = parent.as_ref().unwrap_or(old.parent_id.as_ref().unwrap());
            working.unique_name(next_parent, name.as_ref().unwrap_or(&old.name), Some(&id))?;
            let revision = working.id("node");
            let content = bytes.as_ref().map(|_| working.id("content"));
            let stored = working.nodes.get_mut(&id).unwrap();
            stored.node.revision = revision;
            stored.node.modified_at = Timestamp(working.now);
            if let Some(parent) = parent {
                stored.node.parent_id = Some(parent);
            }
            if let Some(name) = name {
                stored.node.name = name;
            }
            if let Some(bytes) = bytes {
                if stored.node.kind != NodeKind::File {
                    return Err(Error::api(error_code::IS_DIRECTORY, "目录不能覆盖字节"));
                }
                stored.node.size = (bytes.len() as u64).into();
                stored.node.content_version = content;
                stored.node.has_thumbnail = false;
                stored.thumbnail = None;
                stored.bytes = bytes;
            }
            if let Some(visible) = visible {
                stored.visible = visible;
            }
            let new_parent = stored.node.parent_id.clone().unwrap();
            working.touch_parent(old.parent_id.as_ref().unwrap());
            if old.parent_id.as_ref() != Some(&new_parent) {
                working.touch_parent(&new_parent);
            }
            working.rebuild_paths()?;
            let node = working.nodes[&id].node.clone();
            working.log(
                was_visible.then(|| old.clone()),
                node.clone(),
                old.kind == NodeKind::Directory,
                ancestors,
            );
            working.refresh_scope(signature);
            *state = working;
            Ok(node)
        })
    }
    pub fn events_snapshot(&self, cursor: Option<String>) -> Result<Vec<HostEvent>> {
        self.apply(true, |state| {
            if let Some(cursor) = cursor {
                if let Some(index) = state.events.iter().position(|event| event.cursor == cursor) {
                    return Ok(state.events.iter().skip(index + 1).cloned().collect());
                }
                state.emit(
                    event_name::SYNC_REQUIRED,
                    serde_json::json!({"reason":"cursor_expired"}),
                );
            } else {
                state.emit(
                    event_name::SYNC_REQUIRED,
                    serde_json::json!({"reason":"initial"}),
                );
            }
            Ok(vec![state.events.back().unwrap().clone()])
        })
    }
    pub fn read_ticket(&self, url: String, options: ReadOptions) -> Result<ByteResponse> {
        let plan = self.apply(true, |state| data::ticket_plan(state, &url, options))?;
        Ok(self.response(plan))
    }
    fn response(&self, plan: data::Plan) -> ByteResponse {
        let state = Some((
            self.clone(),
            plan.source,
            plan.offset,
            plan.length,
            plan.lease,
            data::ReadBinding {
                ticket: plan.ticket,
                remaining: plan.local_reserved,
            },
        ));
        let body: ByteStream = Box::pin(stream::unfold(state, |state| async {
            let (host, source, offset, remaining, lease, mut reservation) = state?;
            if remaining == 0 {
                return None;
            }
            let length = remaining.min(64 * 1024) as usize;
            let result = host.apply(true, |state| {
                if let Some(id) = &reservation.ticket {
                    data::live_ticket(state, id)?;
                    if reservation.remaining > 0 {
                        data::charge_local(state, id, length as u64)?;
                    }
                }
                if let Some(id) = &lease {
                    data::lease(state, id)?;
                }
                let bytes = match &source {
                    data::Source::File(file, representation) => {
                        let node = state.content(file)?;
                        if *representation == FileRepresentation::Original {
                            &node.bytes
                        } else {
                            node.thumbnail
                                .as_ref()
                                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "缩略图已失效"))?
                        }
                    }
                    data::Source::Cache(key, revision) => {
                        let object = state
                            .cache
                            .get(key)
                            .filter(|object| &object.entry.revision == revision)
                            .ok_or_else(|| Error::api(error_code::NOT_FOUND, "缓存已失效"))?;
                        for source in &object.sources {
                            state
                                .content(source)
                                .map_err(|_| Error::api(error_code::NOT_FOUND, "缓存源已失效"))?;
                        }
                        &object.bytes
                    }
                    data::Source::Empty => return Ok(Bytes::new()),
                };
                Ok(Bytes::copy_from_slice(
                    bytes
                        .get(offset as usize..offset as usize + length)
                        .ok_or(Error::Protocol("测试字节区间不匹配"))?,
                ))
            });
            match result {
                Ok(bytes) => {
                    reservation.remaining =
                        reservation.remaining.saturating_sub(bytes.len() as u64);
                    Some((
                        Ok(bytes),
                        Some((
                            host,
                            source,
                            offset + length as u64,
                            remaining - length as u64,
                            lease,
                            reservation,
                        )),
                    ))
                }
                Err(error) => Some((Err(error), None)),
            }
        }));
        ByteResponse {
            status: plan.status,
            headers: plan.headers,
            body,
        }
    }
}

fn wire<T: Serialize>(value: &T) -> Result<()> {
    validate_json_request(value)?;
    let bytes = serde_json::to_vec(value)?;
    parse_unique_json(&bytes)?;
    Ok(())
}
macro_rules! state_methods {
    ($( $name:ident($request:ident : $input:ty) -> $output:ty = $function:path; )*) => {
        $(fn $name(&self, $request: $input) -> HostFuture<'_, $output> { Box::pin(async move { wire(&$request)?; self.apply(true, |state| $function(state, $request)) }) })*
    };
}
impl HostClient for MemoryHost {
    fn runtime_info(&self) -> HostFuture<'_, RuntimeInfo> {
        Box::pin(async move {
            self.apply(true, |state| {
                let capabilities = CAPABILITIES
                    .iter()
                    .filter(|name| {
                        **name != "kv.device"
                            && (self.caller == RuntimeCaller::Page
                                || !name.starts_with("ui.")
                                    && **name != "session.refresh"
                                    && **name != "backend.proxy")
                            && (state.config.has_backend
                                || !name.starts_with("backend.") && **name != "files.local_url")
                            && (self.caller == RuntimeCaller::Backend
                                || !matches!(**name, "files.local_url" | "backend.keepalive"))
                    })
                    .map(|name| (*name).into())
                    .collect();
                Ok(RuntimeInfo {
                    contract: CONTRACT_VERSION,
                    app: state.config.app.clone(),
                    caller: self.caller,
                    capabilities,
                    files: state.config.files.clone(),
                    scope: state.scope_info(),
                    limits: state.limits(self.caller),
                    backend: state.config.has_backend.then_some(BackendStatus {
                        state: BackendState::Ready,
                        run_mode: RunMode::Resident,
                        run_id: Some(state.run_id.clone()),
                        error_code: None,
                    }),
                    external_service: None,
                })
            })
        })
    }
    fn scope(&self) -> HostFuture<'_, ScopeInfo> {
        Box::pin(async { self.apply(true, |state| Ok(state.scope_info())) })
    }
    state_methods! {
        stat(request: NodeReference) -> FileNode = query::stat;
        list(request: ListDirectoryRequest) -> DirectoryPage = query::list;
        query(request: FileQuery) -> FilePage = query::query;
        directories_with_files(request: DirectoriesWithFilesQuery) -> FilePage = query::directories;
        random(request: RandomFilesRequest) -> RandomFilesResponse = query::random;
        changes(request: FileChangesRequest) -> FileChangesPage = query::changes;
                kv_list(request: KvListRequest) -> KvPage = data::kv_list;
    }
    fn bytes(&self, file: ContentRef, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            let plan = self.apply(true, |state| {
                data::file_plan(state, file, FileRepresentation::Original, options)
            })?;
            Ok(self.response(plan))
        })
    }
    fn ticket_bytes(&self, url: String, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            self.backend()?;
            if !valid_same_origin_path(&url) {
                return Err(Error::Protocol("票据必须是同源相对路径"));
            }
            let uri: tgdrive_backend_sdk::http::Uri =
                url.parse().map_err(|_| Error::Protocol("票据路径无效"))?;
            let id = uri.path().rsplit('/').next().unwrap_or_default();
            let plan = self.apply(true, |state| {
                let ticket = state
                    .tickets
                    .get(id)
                    .ok_or_else(|| Error::api(error_code::TICKET_EXPIRED, "票据已撤销"))?;
                if !matches!(
                    ticket.kind,
                    state::TicketKind::Media(..) | state::TicketKind::Cache(..)
                ) || ticket.backend_run_id.as_deref() != Some(self.run_id.as_str())
                {
                    return Err(Error::api(
                        error_code::CALLER_NOT_ALLOWED,
                        "套接字只接受本应用当前后端轮次签发的媒体或缓存票据",
                    ));
                }
                data::ticket_plan(state, &url, options)
            })?;
            Ok(self.response(plan))
        })
    }
    fn media_url(&self, request: MediaUrlRequest) -> HostFuture<'_, MediaUrl> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| {
                data::media_url(
                    state,
                    request,
                    self.expiry(),
                    &self.caller_id,
                    (self.caller == RuntimeCaller::Backend).then_some(self.run_id.as_str()),
                )
            })
        })
    }
    fn local_url(&self, request: LocalFileUrlRequest) -> HostFuture<'_, LocalFileUrl> {
        Box::pin(async move {
            self.backend()?;
            wire(&request)?;
            self.apply(true, |state| {
                data::local_url(state, request, &self.caller_id)
            })
        })
    }
    fn revoke_local_url(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.backend()?;
            self.apply(true, |state| {
                state.tickets.remove(&id);
                Ok(())
            })
        })
    }
    fn create_read_lease(&self, request: CreateReadLeaseRequest) -> HostFuture<'_, ReadLease> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| {
                data::create_lease(state, request, &self.caller_id)
            })
        })
    }
    fn renew_read_lease(
        &self,
        id: String,
        request: CreateReadLeaseRequest,
    ) -> HostFuture<'_, ReadLease> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| data::renew_lease(state, id, request))
        })
    }
    fn revoke_read_lease(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.apply(true, |state| {
                state.leases.remove(&id);
                state.lease_creators.remove(&id);
                Ok(())
            })
        })
    }
    fn mutate(&self, key: String, request: FileMutationRequest) -> HostFuture<'_, MutationReceipt> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| mutations::mutate(state, key, request))
        })
    }
    fn mutation_receipt(&self, key: String) -> HostFuture<'_, MutationReceipt> {
        Box::pin(async move { self.apply(true, |state| mutations::mutation_receipt(state, &key)) })
    }
    fn create_upload(
        &self,
        key: String,
        request: CreateUploadRequest,
    ) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| mutations::create_upload(state, key, request))
        })
    }
    fn upload_body(
        &self,
        id: String,
        mut body: ByteStream,
        length: Option<u64>,
    ) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move {
            let request = self.apply(true, |state| mutations::begin_body(state, &id, length))?;
            let mut bytes = Vec::new();
            while let Some(chunk) = body.next().await {
                let chunk = chunk?;
                let received = (bytes.len() as u64)
                    .checked_add(chunk.len() as u64)
                    .ok_or(Error::Protocol("正文长度溢出"))?;
                if let Err(error) = self.apply(true, |state| {
                    mutations::receive_body(state, &id, &request, received)
                }) {
                    self.apply(false, |state| {
                        if let Some(upload) = state.uploads.get_mut(&id) {
                            upload.info.state = UploadState::Failed;
                            upload.info.error_code = Some(error.code().into());
                        }
                        Ok(())
                    })?;
                    return Err(error);
                }
                bytes.extend_from_slice(&chunk);
            }
            self.apply(true, |state| {
                mutations::finish_body(state, &id, &request, bytes)
            })
        })
    }
    fn upload_status(&self, id: String) -> HostFuture<'_, UploadInfo> {
        Box::pin(async move { self.apply(true, |state| mutations::upload_status(state, &id)) })
    }
    fn cancel_upload(&self, id: String) -> HostFuture<'_, ()> {
        Box::pin(async move { self.apply(true, |state| mutations::cancel_upload(state, &id)) })
    }
    fn kv_get(&self, key: String) -> HostFuture<'_, KvGetResponse> {
        Box::pin(async move { self.apply(true, |state| data::kv_get(state, &key)) })
    }
    fn kv_put(&self, key: String, request: KvPutRequest) -> HostFuture<'_, KvRecord> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| data::kv_put(state, key, request))
        })
    }
    fn kv_delete(&self, key: String, request: KvDeleteRequest) -> HostFuture<'_, ()> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| data::kv_delete(state, &key, request))
        })
    }
    fn data_usage(&self) -> HostFuture<'_, DataUsage> {
        Box::pin(async { self.apply(true, |state| Ok(data::usage(state, self.caller))) })
    }
    fn cache_put(
        &self,
        key: String,
        body: ByteStream,
        content_type: String,
        metadata: CachePutMetadata,
    ) -> HostFuture<'_, CacheEntry> {
        Box::pin(async move {
            self.apply(true, |state| {
                data::key_valid(&key)?;
                data::cache_metadata(state, &metadata, &content_type)
            })?;
            let bytes = tgdrive_backend_sdk::collect_bytes(body, MAX_CACHE_OBJECT_BYTES).await?;
            self.apply(true, |state| {
                data::cache_put(state, key, bytes.to_vec(), content_type, metadata)
            })
        })
    }
    fn cache_get(&self, key: String, options: ReadOptions) -> HostFuture<'_, ByteResponse> {
        Box::pin(async move {
            let plan = self.apply(true, |state| data::cache_plan(state, key, options))?;
            Ok(self.response(plan))
        })
    }
    fn cache_delete(&self, key: String) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.apply(true, |state| {
                data::key_valid(&key)?;
                state.cache.remove(&key);
                Ok(())
            })
        })
    }
    fn cache_lookup(&self, request: CacheLookupRequest) -> HostFuture<'_, CacheLookupResponse> {
        Box::pin(async move {
            wire(&request)?;
            self.apply(true, |state| {
                data::cache_lookup(
                    state,
                    request,
                    self.expiry(),
                    &self.caller_id,
                    (self.caller == RuntimeCaller::Backend).then_some(self.run_id.as_str()),
                )
            })
        })
    }
    fn events(&self, cursor: Option<String>) -> HostFuture<'_, EventStream> {
        Box::pin(async move {
            let permit = self
                .event_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::api(error_code::QUOTA_EXCEEDED, "事件连接已达上限"))?;
            let initial = self.events_snapshot(cursor)?;
            let receiver = self.events.subscribe();
            let state = Some((
                self.clone(),
                receiver,
                std::collections::VecDeque::from(initial),
                permit,
                self.closed.subscribe(),
            ));
            let stream: EventStream = Box::pin(stream::unfold(state, |state| async {
                let (host, mut receiver, mut queued, permit, mut closed) = state?;
                let is_closed = *closed.borrow();
                let event = if is_closed {
                    Err(Error::api(error_code::SESSION_EXPIRED, "页面事件流已关闭"))
                } else if let Some(event) = queued.pop_front() {
                    host.apply(true, |_| Ok(event))
                } else {
                    tokio::select! {
                        _ = closed.changed() => Err(Error::api(error_code::SESSION_EXPIRED, "页面事件流已关闭")),
                        event = receiver.recv() => match event {
                            Ok(event) => host.apply(true, |_| Ok(event)),
                            Err(broadcast::error::RecvError::Lagged(_)) => host.apply(true, |state| {
                                state.emit(event_name::SYNC_REQUIRED, serde_json::json!({"reason":"overflow"}));
                                Ok(state.events.back().unwrap().clone())
                            }),
                            Err(broadcast::error::RecvError::Closed) => return None,
                        },
                    }
                };
                let next = event
                    .is_ok()
                    .then_some((host, receiver, queued, permit, closed));
                Some((event, next))
            }));
            Ok(stream)
        })
    }
    fn keepalive(&self, request: BackendKeepaliveRequest) -> HostFuture<'_, ()> {
        Box::pin(async move {
            self.backend()?;
            self.apply(true, |_| {
                if request.ttl_seconds == 0
                    || u64::from(request.ttl_seconds) > BACKEND_KEEPALIVE_SECONDS
                {
                    return Err(Error::api(error_code::INVALID_REQUEST, "活动续期 TTL 无效"));
                }
                Ok(())
            })
        })
    }
}
