use crate::{MemoryConfig, SeedNode};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{
    ByteCount, Timestamp,
    data::*,
    error_code,
    events::{HostEvent, event_name},
    files::*,
    http::*,
    runtime::*,
    validation::*,
};

#[derive(Clone)]
pub(crate) struct StoredNode {
    pub node: FileNode,
    pub bytes: Vec<u8>,
    pub thumbnail: Option<Vec<u8>>,
    pub visible: bool,
}
#[derive(Clone)]
pub(crate) enum CursorState {
    Page {
        binding: Value,
        scope: String,
        expires: i64,
        last: Box<FileNode>,
        scan: String,
    },
    Changes {
        scope: String,
        position: u64,
        high_water: Option<u64>,
    },
    Kv {
        prefix: String,
        limit: u16,
        expires: i64,
        last: String,
    },
}
#[derive(Clone)]
pub(crate) struct ChangeLog {
    pub sequence: u64,
    pub timestamp: i64,
    pub old: Option<FileNode>,
    pub old_ancestors: Vec<String>,
    pub new: Option<FileNode>,
    pub new_ancestors: Vec<String>,
    pub subtree: bool,
}
#[derive(Clone)]
pub(crate) struct Upload {
    pub info: UploadInfo,
    pub request: CreateUploadRequest,
    pub body: Vec<u8>,
}
#[derive(Clone)]
pub(crate) struct CacheObject {
    pub entry: CacheEntry,
    pub bytes: Vec<u8>,
    pub sources: Vec<ContentRef>,
    pub accessed: u64,
}
#[derive(Clone)]
pub(crate) enum TicketKind {
    Media(ContentRef, FileRepresentation),
    Cache(String, String),
    Local(ContentRef, u64, u16),
}
#[derive(Clone)]
pub(crate) struct Ticket {
    pub expires: i64,
    pub lease: Option<String>,
    pub kind: TicketKind,
    pub generation: String,
    pub creator: String,
    pub backend_run_id: Option<String>,
}
#[derive(Clone)]
pub(crate) struct State {
    pub config: MemoryConfig,
    pub now: i64,
    pub enabled: bool,
    pub run_id: String,
    pub nodes: BTreeMap<String, StoredNode>,
    pub scope_revision: String,
    pub sequence: u64,
    pub next_node: u64,
    pub change_sequence: u64,
    pub changes: VecDeque<ChangeLog>,
    pub cursors: BTreeMap<String, CursorState>,
    pub kv: BTreeMap<String, KvRecord>,
    /// 键和值的实际序列化占用增量计量，不能每次写入重新序列化整库。
    pub kv_bytes: u64,
    /// 仅保留排序后的 ID；任何节点集合或元数据变化都会清空，范围修订另行绑定。
    pub query_cache: VecDeque<crate::query::CachedQuery>,
    pub cache: BTreeMap<String, CacheObject>,
    pub leases: BTreeMap<String, ReadLease>,
    pub lease_creators: BTreeMap<String, String>,
    pub tickets: BTreeMap<String, Ticket>,
    pub uploads: BTreeMap<String, Upload>,
    pub upload_keys: BTreeMap<String, (Value, String)>,
    pub receipts: BTreeMap<String, (Value, MutationReceipt)>,
    pub events: VecDeque<HostEvent>,
}

impl State {
    pub fn new(config: MemoryConfig) -> Result<Self> {
        validate_scope(&config.scope, &config.files)?;
        if !valid_app_id(&config.app.id)
            || stable_version(&config.app.version).is_none()
            || !valid_opaque_id(&config.app.generation)
        {
            return Err(Error::Protocol("测试应用身份无效"));
        }
        let now = config.now.0;
        if !(0..=MAX_TIMESTAMP_MILLIS as i64).contains(&now) {
            return Err(Error::Protocol("测试时间无效"));
        }
        let root = FileNode {
            id: "1".into(),
            parent_id: None,
            name: String::new(),
            path: "/".into(),
            kind: NodeKind::Directory,
            size: ByteCount(0),
            created_at: Timestamp(now),
            modified_at: Timestamp(now),
            revision: "root-1".into(),
            content_version: None,
            children_revision: Some("children-1".into()),
            has_thumbnail: false,
        };
        let mut state = Self {
            now,
            enabled: true,
            run_id: "test-run-1".into(),
            nodes: BTreeMap::from([(
                "1".into(),
                StoredNode {
                    node: root,
                    bytes: Vec::new(),
                    thumbnail: None,
                    visible: true,
                },
            )]),
            scope_revision: "scope-1".into(),
            sequence: 1,
            next_node: 2,
            change_sequence: 0,
            changes: VecDeque::new(),
            cursors: BTreeMap::new(),
            kv: BTreeMap::new(),
            kv_bytes: 0,
            query_cache: VecDeque::new(),
            cache: BTreeMap::new(),
            leases: BTreeMap::new(),
            lease_creators: BTreeMap::new(),
            tickets: BTreeMap::new(),
            uploads: BTreeMap::new(),
            upload_keys: BTreeMap::new(),
            receipts: BTreeMap::new(),
            events: VecDeque::new(),
            config,
        };
        let mut seed_names = BTreeSet::new();
        for node in std::mem::take(&mut state.config.nodes) {
            state.insert_seed(node, Some(&mut seed_names))?;
        }
        state.validate_roots_exist(&state.config.scope)?;
        Ok(state)
    }
    pub fn id(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }
    pub fn active(&self, generation: &str, caller: RuntimeCaller, started_at: i64) -> Result<()> {
        if self.config.app.generation != generation {
            return Err(Error::api(error_code::APP_CHANGED, "测试安装已更新"));
        }
        if !self.enabled {
            return Err(Error::api(error_code::APP_DISABLED, "测试应用已停用"));
        }
        if caller == RuntimeCaller::Page
            && self.now >= started_at + PAGE_SESSION_SECONDS as i64 * 1000
        {
            return Err(Error::api(
                error_code::SESSION_EXPIRED,
                "测试页面会话已过期",
            ));
        }
        Ok(())
    }
    pub fn node(&self, id: &str) -> Result<&StoredNode> {
        self.nodes
            .get(id)
            .filter(|node| node.visible && self.ancestors_visible(id))
            .ok_or_else(|| Error::api(error_code::NOT_FOUND, "节点不存在或不可见"))
    }
    pub fn ancestors(&self, id: &str) -> Vec<String> {
        let mut output = Vec::new();
        let mut current = Some(id);
        while let Some(id) = current {
            output.push(id.into());
            current = self
                .nodes
                .get(id)
                .and_then(|node| node.node.parent_id.as_deref());
        }
        output
    }
    fn ancestors_visible(&self, id: &str) -> bool {
        self.ancestors(id)
            .iter()
            .all(|id| self.nodes.get(id).is_some_and(|node| node.visible))
    }
    pub fn access_chain(&self, ancestors: &[String]) -> Option<AccessLevel> {
        effective_access(
            &self.config.scope,
            &self.config.files,
            &ancestors.iter().map(String::as_str).collect::<Vec<_>>(),
        )
    }
    pub fn read_node(&self, id: &str) -> Result<&StoredNode> {
        let node = self.node(id)?;
        if self.access_chain(&self.ancestors(id)).is_none() {
            return Err(Error::api(error_code::SCOPE_DENIED, "节点不在目录授权内"));
        }
        Ok(node)
    }
    pub fn write_node(&self, id: &str) -> Result<&StoredNode> {
        if !self.config.files.write {
            return Err(Error::api(error_code::WRITE_NOT_DECLARED, "应用未声明写入"));
        }
        let node = self.node(id)?;
        if self.access_chain(&self.ancestors(id)) != Some(AccessLevel::ReadWrite) {
            return Err(Error::api(error_code::SCOPE_DENIED, "节点没有读写授权"));
        }
        Ok(node)
    }
    pub fn directory(&self, id: &str, write: bool) -> Result<&StoredNode> {
        let node = if write {
            self.write_node(id)?
        } else {
            self.read_node(id)?
        };
        if node.node.kind != NodeKind::Directory {
            return Err(Error::api(error_code::NOT_DIRECTORY, "目标不是目录"));
        }
        Ok(node)
    }
    pub fn content(&self, file: &ContentRef) -> Result<&StoredNode> {
        validate_content_ref(file)?;
        let node = self.read_node(&file.id)?;
        if node.node.kind != NodeKind::File {
            return Err(Error::api(error_code::IS_DIRECTORY, "目录没有文件字节"));
        }
        if node.node.content_version.as_deref() != Some(&file.content_version) {
            return Err(Error::api(error_code::CONTENT_CHANGED, "文件内容已经变化"));
        }
        Ok(node)
    }
    pub fn validate_roots_exist(&self, scope: &DirectoryScope) -> Result<()> {
        if let DirectoryScope::Selected { directories } = scope {
            for grant in directories {
                if self.node(&grant.directory_id)?.node.kind != NodeKind::Directory {
                    return Err(Error::api(error_code::NOT_DIRECTORY, "授权根不是目录"));
                }
            }
        }
        Ok(())
    }
    pub fn scope_info(&self) -> ScopeInfo {
        let grants = match &self.config.scope {
            DirectoryScope::None => Vec::new(),
            DirectoryScope::All { access } => vec![DirectoryGrant {
                directory_id: "1".into(),
                access: *access,
            }],
            DirectoryScope::Selected { directories } => directories.clone(),
        };
        ScopeInfo {
            revision: self.scope_revision.clone(),
            scope: self.config.scope.clone(),
            roots: grants
                .into_iter()
                .map(|grant| AuthorizedRoot {
                    node: self
                        .node(&grant.directory_id)
                        .ok()
                        .map(|node| node.node.clone()),
                    directory_id: grant.directory_id,
                    access: grant.access,
                })
                .collect(),
        }
    }
    pub fn set_scope(&mut self, scope: DirectoryScope) -> Result<ScopeInfo> {
        validate_scope(&scope, &self.config.files)?;
        self.validate_roots_exist(&scope)?;
        self.config.scope = scope;
        self.query_cache.clear();
        self.scope_revision = self.id("scope");
        self.emit(
            event_name::SCOPE_CHANGED,
            serde_json::json!({"revision":self.scope_revision}),
        );
        Ok(self.scope_info())
    }
    pub fn root_signature(&self) -> Vec<(String, Option<String>)> {
        self.scope_info()
            .roots
            .into_iter()
            .map(|root| (root.directory_id, root.node.map(|node| node.path)))
            .collect()
    }
    pub fn refresh_scope(&mut self, previous: Vec<(String, Option<String>)>) {
        if previous != self.root_signature() {
            self.scope_revision = self.id("scope");
            self.emit(
                event_name::SCOPE_CHANGED,
                serde_json::json!({"revision":self.scope_revision}),
            );
        }
    }
    pub fn add_seed(&mut self, seed: SeedNode) -> Result<FileNode> {
        self.insert_seed(seed, None)
    }
    fn insert_seed(
        &mut self,
        seed: SeedNode,
        names: Option<&mut BTreeSet<(String, String)>>,
    ) -> Result<FileNode> {
        if !valid_node_id(&seed.id)
            || !valid_node_id(&seed.parent_id)
            || !valid_drive_name(&seed.name)
            || self.nodes.contains_key(&seed.id)
        {
            return Err(Error::Protocol("测试节点身份或名称无效"));
        }
        let parent = self.node(&seed.parent_id)?;
        if parent.node.kind != NodeKind::Directory {
            return Err(Error::api(error_code::NOT_DIRECTORY, "测试父节点不是目录"));
        }
        if let Some(names) = names {
            // 初始灌入没有隐藏节点，重名判定可增量查索引，不为每个节点扫描已灌入的整树。
            if !names.insert((seed.parent_id.clone(), seed.name.clone())) {
                return Err(Error::api(error_code::NAME_CONFLICT, "目标名称已存在"));
            }
        } else {
            self.unique_name(&seed.parent_id, &seed.name, None)?;
        }
        let path = if parent.node.path == "/" {
            format!("/{}", seed.name)
        } else {
            format!("{}/{}", parent.node.path, seed.name)
        };
        if !valid_drive_path(&path) {
            return Err(Error::api(error_code::INVALID_PATH, "节点路径超限"));
        }
        let revision = self.id("node");
        let directory = seed.kind == NodeKind::Directory;
        if directory && (!seed.bytes.is_empty() || seed.thumbnail.is_some()) {
            return Err(Error::Protocol("测试目录不能带文件字节"));
        }
        let node = FileNode {
            id: seed.id.clone(),
            parent_id: Some(seed.parent_id.clone()),
            name: seed.name,
            path,
            kind: seed.kind,
            size: ByteCount(seed.bytes.len() as u64),
            created_at: Timestamp(self.now),
            modified_at: Timestamp(self.now),
            revision,
            content_version: (!directory).then(|| self.id("content")),
            children_revision: directory.then(|| self.id("children")),
            has_thumbnail: seed.thumbnail.is_some(),
        };
        validate_file_node_size(&node)?;
        self.next_node = self.next_node.max(seed.id.parse::<u64>().unwrap() + 1);
        self.nodes.insert(
            seed.id.clone(),
            StoredNode {
                node: node.clone(),
                bytes: seed.bytes,
                thumbnail: seed.thumbnail,
                visible: true,
            },
        );
        self.touch_parent(&seed.parent_id);
        self.log(None, node.clone(), false, Vec::new());
        Ok(node)
    }
    pub fn unique_name(&self, parent: &str, name: &str, except: Option<&str>) -> Result<()> {
        if self.nodes.values().any(|node| {
            node.visible
                && node.node.parent_id.as_deref() == Some(parent)
                && node.node.name == name
                && except != Some(&node.node.id)
        }) {
            return Err(Error::api(error_code::NAME_CONFLICT, "目标名称已存在"));
        }
        Ok(())
    }
    pub fn touch_parent(&mut self, id: &str) {
        self.query_cache.clear();
        let revision = self.id("node");
        let children = self.id("children");
        if let Some(node) = self.nodes.get_mut(id) {
            node.node.revision = revision;
            node.node.children_revision = Some(children);
            node.node.modified_at = Timestamp(self.now);
        }
    }
    pub fn rebuild_paths(&mut self) -> Result<()> {
        self.query_cache.clear();
        let mut changed_parents = std::collections::BTreeSet::new();
        let ids = self.nodes.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let chain = self.ancestors(&id);
            let names = chain
                .iter()
                .rev()
                .filter_map(|id| {
                    self.nodes
                        .get(id)
                        .filter(|node| node.node.parent_id.is_some())
                        .map(|node| node.node.name.as_str())
                })
                .collect::<Vec<_>>();
            let path = format!("/{}", names.join("/"));
            if !valid_drive_path(&path) {
                return Err(Error::api(error_code::INVALID_PATH, "移动后的派生路径超限"));
            }
            if self.nodes[&id].node.path != path {
                if self.node(&id).is_ok() {
                    if let Some(parent) = self.nodes[&id].node.parent_id.clone() {
                        changed_parents.insert(parent);
                    }
                }
                let revision = self.id("node");
                let node = self.nodes.get_mut(&id).unwrap();
                node.node.path = path;
                node.node.revision = revision;
            }
        }
        for parent in changed_parents {
            let revision = self.id("node");
            let children = self.id("children");
            if let Some(node) = self.nodes.get_mut(&parent) {
                node.node.revision = revision;
                node.node.children_revision = Some(children);
            }
        }
        Ok(())
    }
    pub fn emit(&mut self, event: &str, data: Value) {
        let cursor = self.id("event");
        self.events.push_back(HostEvent {
            cursor,
            occurred_at: Timestamp(self.now),
            event: event.into(),
            data,
        });
        while self.events.len() > MAX_EVENT_JOURNAL_ENTRIES as usize {
            self.events.pop_front();
        }
    }
    pub fn checkpoint(&mut self, position: u64, high_water: Option<u64>) -> String {
        let id = self.id("cursor");
        self.cursors.insert(
            id.clone(),
            CursorState::Changes {
                scope: self.scope_revision.clone(),
                position,
                high_water,
            },
        );
        id
    }
    pub fn log(
        &mut self,
        old: Option<FileNode>,
        new: FileNode,
        subtree: bool,
        old_ancestors: Vec<String>,
    ) {
        self.change_sequence += 1;
        let new_ancestors = self.ancestors(&new.id);
        let new = self.node(&new.id).ok().map(|node| node.node.clone());
        self.changes.push_back(ChangeLog {
            sequence: self.change_sequence,
            timestamp: self.now,
            old,
            old_ancestors,
            new,
            new_ancestors,
            subtree,
        });
        while self.changes.front().is_some_and(|change| {
            change.timestamp < self.now - FILE_CHANGE_RETENTION_SECONDS as i64 * 1000
        }) || self.changes.len() > MAX_FILE_CHANGE_JOURNAL_ENTRIES as usize
        {
            self.changes.pop_front();
        }
        let cursor = self.checkpoint(self.change_sequence, None);
        self.emit(
            event_name::FILES_CHANGED,
            serde_json::json!({"change_cursor":cursor}),
        );
    }
    pub fn limits(&self, caller: RuntimeCaller) -> RuntimeLimits {
        let backend = self.config.has_backend.then_some(BackendResourceLimits {
            memory_bytes: ByteCount(0),
            cpu_millis: 0,
            enforced: BackendLimitEnforcement {
                memory: false,
                cpu: false,
            },
        });
        let is_page = caller == RuntimeCaller::Page;
        RuntimeLimits {
            json_request_bytes: ByteCount(MAX_JSON_REQUEST_BYTES),
            json_response_bytes: ByteCount(MAX_JSON_RESPONSE_BYTES),
            json_page_bytes: ByteCount(MAX_JSON_PAGE_BYTES),
            file_page_limit: MAX_PAGE_LIMIT as u16,
            query_root_limit: MAX_QUERY_ROOTS as u16,
            extension_limit: MAX_QUERY_EXTENSIONS as u16,
            mutation_operation_limit: MAX_MUTATION_OPERATIONS as u16,
            mutation_assertion_limit: MAX_MUTATION_ASSERTIONS as u16,
            random_limit: MAX_RANDOM_LIMIT as u16,
            random_exclusion_limit: MAX_RANDOM_EXCLUSIONS as u16,
            kv_key_bytes: MAX_KV_KEY_BYTES as u16,
            kv_value_bytes: ByteCount(MAX_KV_VALUE_BYTES),
            kv_entry_limit: DEFAULT_KV_ENTRIES as u32,
            kv_byte_limit: ByteCount(DEFAULT_KV_BYTES),
            cache_object_bytes: ByteCount(MAX_CACHE_OBJECT_BYTES),
            cache_metadata_bytes: ByteCount(MAX_CACHE_METADATA_BYTES),
            cache_lookup_limit: MAX_CACHE_LOOKUP_KEYS as u16,
            cache_byte_limit: ByteCount(DEFAULT_CACHE_BYTES),
            control_concurrency: if is_page {
                PAGE_CONTROL_CONCURRENCY
            } else {
                BACKEND_CONTROL_CONCURRENCY
            } as u16,
            byte_stream_concurrency: if is_page {
                PAGE_BYTE_CONCURRENCY
            } else {
                BACKEND_BYTE_CONCURRENCY
            } as u16,
            control_requests_per_second: if is_page {
                PAGE_CONTROL_RATE
            } else {
                BACKEND_CONTROL_RATE
            } as u16,
            control_burst: if is_page {
                PAGE_CONTROL_BURST
            } else {
                BACKEND_CONTROL_BURST
            } as u16,
            read_lease_limit: MAX_READ_LEASES as u16,
            media_ticket_limit: MAX_MEDIA_TICKETS as u32,
            upload_limit: MAX_UPLOADS as u16,
            backend,
        }
    }
}
