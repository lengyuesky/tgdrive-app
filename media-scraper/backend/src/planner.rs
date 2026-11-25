//! 整理与配套归属在应用中计算；所有计划最终依靠节点/直属集合修订条件提交。
use crate::{images, model::*, nfo, variant};
use futures_util::Future;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::Duration,
};
use tgdrive_backend_sdk::{Error, HostClient, ReadOptions, Result, collect_bytes};
use tgdrive_contract::{error_code, files::*};
use tokio_util::sync::CancellationToken;

const DIRECTORY_BYTES: usize = 32 * 1024 * 1024;
pub async fn cancellable<T>(
    cancel: &CancellationToken,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! { biased; _=cancel.cancelled()=>Err(Error::Cancelled), value=future=>value }
}
pub fn children_assertion(node: &FileNode) -> Result<FileAssertion> {
    Ok(FileAssertion::Children {
        directory_id: node.id.clone(),
        children_revision: node
            .children_revision
            .clone()
            .ok_or_else(|| Error::api(error_code::NOT_DIRECTORY, "计划位置不是目录"))?,
    })
}
pub fn node_assertion(node: &FileNode) -> FileAssertion {
    FileAssertion::Node {
        id: node.id.clone(),
        revision: node.revision.clone(),
    }
}
pub fn condition(node: &FileNode) -> NodeCondition {
    NodeCondition {
        id: node.id.clone(),
        revision: node.revision.clone(),
    }
}
#[derive(Clone)]
pub struct DirectorySnapshot {
    pub directory: FileNode,
    pub entries: BTreeMap<String, FileNode>,
}
#[derive(Default)]
pub struct DirectoryCache {
    directories: HashMap<String, DirectorySnapshot>,
    cursor: Option<String>,
}
impl DirectoryCache {
    /// 已变直属集合通过通用变更游标更新缓存；避免每写一份资料就重读整目录。
    async fn sync(
        &mut self,
        host: &dyn HostClient,
        scope: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let Some(mut cursor) = self.cursor.clone() else {
            return Ok(());
        };
        let mut seen = HashSet::new();
        let mut count = 0usize;
        loop {
            let page = match cancellable(
                cancel,
                host.changes(FileChangesRequest {
                    cursor: Some(cursor.clone()),
                    limit: 500,
                }),
            )
            .await
            {
                Ok(page) => page,
                Err(error) if error.code() == error_code::CURSOR_EXPIRED => {
                    self.directories.clear();
                    self.cursor = None;
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            if page.scope_revision != scope {
                return Err(Error::api(
                    error_code::SCOPE_CHANGED,
                    "目录授权已改变，刮削已停止",
                ));
            }
            if page.reset_required {
                self.directories.clear();
                self.cursor = None;
                return Ok(());
            }
            count += page.changes.len();
            if count > 4096 {
                self.directories.clear();
                self.cursor = None;
                return Ok(());
            }
            for change in page.changes {
                match change {
                    FileChange::Upsert { node } => {
                        for cache in self.directories.values_mut() {
                            cache.entries.remove(&node.id);
                        }
                        if let Some(parent) = node
                            .parent_id
                            .as_ref()
                            .and_then(|id| self.directories.get_mut(id))
                        {
                            parent.entries.insert(node.id.clone(), node);
                        }
                    }
                    FileChange::Removed { id } => {
                        for cache in self.directories.values_mut() {
                            cache.entries.remove(&id);
                        }
                    }
                    FileChange::SubtreeInvalidated { .. } => {
                        self.directories.clear();
                    }
                }
            }
            cursor = page.next_cursor;
            if !seen.insert(cursor.clone()) {
                return Err(Error::api(
                    error_code::INVALID_CURSOR,
                    "文件变更游标没有推进",
                ));
            }
            self.cursor = Some(cursor.clone());
            if !page.has_more {
                return Ok(());
            }
        }
    }
    pub async fn get(
        &mut self,
        host: &dyn HostClient,
        id: &str,
        scope: &str,
        cancel: &CancellationToken,
    ) -> Result<DirectorySnapshot> {
        let before = cancellable(
            cancel,
            host.stat(NodeReference::Id {
                id: id.into(),
                content_version: None,
            }),
        )
        .await?;
        if before.kind != NodeKind::Directory {
            return Err(Error::api(error_code::NOT_DIRECTORY, "计划位置不是目录"));
        }
        if let Some(cache) = self.directories.get(id) {
            if cache.directory.children_revision == before.children_revision
                && cache.directory.path == before.path
            {
                return Ok(cache.clone());
            }
            self.sync(host, scope, cancel).await?;
            let after = cancellable(
                cancel,
                host.stat(NodeReference::Id {
                    id: id.into(),
                    content_version: None,
                }),
            )
            .await?;
            // 先 stat，再读固定高水位变更，最后核对修订；未知并发变化绝不能被当作我们的写入吞掉。
            if before.children_revision == after.children_revision
                && before.path == after.path
                && let Some(cache) = self.directories.get_mut(id)
            {
                cache.directory = after;
                return Ok(cache.clone());
            }
            self.directories.remove(id);
        } else {
            self.sync(host, scope, cancel).await?;
        }
        let (snapshot, scan) = read_directory(host, id, scope, cancel).await?;
        let bytes = serde_json::to_vec(&snapshot.entries)?.len();
        if bytes > DIRECTORY_BYTES {
            return Err(Error::api(
                error_code::QUOTA_EXCEEDED,
                "单目录整理元数据超过 32 MiB 预算，请缩小目录；未截断条目",
            ));
        }
        let cached: usize = self
            .directories
            .values()
            .map(|s| {
                s.entries
                    .values()
                    .map(|n| n.name.len() + n.path.len() + 512)
                    .sum::<usize>()
            })
            .sum();
        if cached.saturating_add(bytes) > DIRECTORY_BYTES {
            self.directories.clear();
        }
        if self.cursor.is_none() {
            self.cursor = Some(scan);
        }
        self.directories.insert(id.into(), snapshot.clone());
        Ok(snapshot)
    }
    pub fn invalidate(&mut self) {
        self.directories.clear();
        self.cursor = None;
    }
}
async fn read_directory(
    host: &dyn HostClient,
    id: &str,
    scope: &str,
    cancel: &CancellationToken,
) -> Result<(DirectorySnapshot, String)> {
    let mut request = ListDirectoryRequest {
        directory: NodeReference::Id {
            id: id.into(),
            content_version: None,
        },
        sort: NodeSort::Id,
        order: SortOrder::Asc,
        limit: 500,
        cursor: None,
    };
    let mut first: Option<FileNode> = None;
    let mut scan = String::new();
    let mut entries = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    loop {
        let page = cancellable(cancel, host.list(request.clone())).await?;
        if page.scope_revision != scope {
            return Err(Error::api(
                error_code::SCOPE_CHANGED,
                "目录授权已改变，刮削已停止",
            ));
        }
        if let Some(first) = &first {
            if first.children_revision != page.directory.children_revision
                || first.path != page.directory.path
            {
                return Err(Error::api(
                    error_code::CHILDREN_CHANGED,
                    "同行文件在读取目录期间已改变",
                ));
            }
        } else {
            first = Some(page.directory.clone());
            scan = page.scan_cursor.clone();
        }
        for node in page.items {
            if node.parent_id.as_deref() != Some(id) {
                return Err(Error::Protocol("目录列表包含非直属文件"));
            }
            bytes = bytes.saturating_add(serde_json::to_vec(&node)?.len());
            if bytes > DIRECTORY_BYTES {
                return Err(Error::api(
                    error_code::QUOTA_EXCEEDED,
                    "单目录整理元数据超过 32 MiB 预算；未截断条目",
                ));
            }
            entries.insert(node.id.clone(), node);
        }
        request.cursor = page.next_cursor;
        if let Some(cursor) = &request.cursor {
            if !seen.insert(cursor.clone()) {
                return Err(Error::api(error_code::INVALID_CURSOR, "目录列表游标重复"));
            }
        } else {
            break;
        }
    }
    let directory = cancellable(
        cancel,
        host.stat(NodeReference::Id {
            id: id.into(),
            content_version: None,
        }),
    )
    .await?;
    let first = first.ok_or(Error::Protocol("目录分页没有目录信息"))?;
    if first.children_revision != directory.children_revision || first.path != directory.path {
        return Err(Error::api(
            error_code::CHILDREN_CHANGED,
            "同行文件在读取目录期间已改变",
        ));
    }
    Ok((DirectorySnapshot { directory, entries }, scan))
}
pub fn common_artifact(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "movie.nfo"
        || ["poster", "folder", "cover"].iter().any(|base| {
            ["jpg", "jpeg", "png", "webp"]
                .iter()
                .any(|ext| name == format!("{base}.{ext}"))
        })
}
pub fn private_related(name: &str, base: &str) -> bool {
    let value = stem(name).to_ascii_lowercase();
    let base = base.to_ascii_lowercase();
    let ext = extension(name);
    nfo::is_actor_image(name, &base)
        || ["srt", "vtt", "ass", "ssa"].contains(&ext.as_str())
            && (value == base || value.starts_with(&format!("{base}.")))
        || ext == "nfo" && value == base
        || ["jpg", "jpeg", "png", "webp"].contains(&ext.as_str())
            && (value == base || value == format!("{base}-poster"))
}
/// 同一处、同一番号的全部视频。文件名自带番号的按文件名判断；不带番号的只有位于番号目录里才算。
fn same_work<'a>(
    videos: impl Iterator<Item = &'a FileNode>,
    number: &str,
    in_number_directory: bool,
) -> impl Iterator<Item = &'a FileNode> {
    let expected = normalized_number(number);
    videos.filter(move |v| {
        let own = numbers(&v.name);
        match own.as_slice() {
            [] => in_number_directory,
            [only] => normalized_number(only) == expected,
            _ => false,
        }
    })
}
pub fn other_video_uses(name: &str, base: &str, videos: &[FileNode]) -> bool {
    videos.iter().any(|v| {
        !stem(&v.name).eq_ignore_ascii_case(base)
            && (common_artifact(name) || private_related(name, stem(&v.name)))
    })
}
fn find(files: &[FileNode], name: &str) -> Result<Option<FileNode>> {
    let mut matches = files.iter().filter(|f| f.name.eq_ignore_ascii_case(name));
    let first = matches.next().cloned();
    if matches.next().is_some() {
        return Err(Error::api(
            error_code::NAME_CONFLICT,
            "同位置存在大小写同名的资料，请先手动确定归属",
        ));
    }
    if first.as_ref().is_some_and(|n| n.kind != NodeKind::File) {
        return Err(Error::api(
            error_code::NAME_CONFLICT,
            "拟写入的资料名称已被目录占用",
        ));
    }
    Ok(first)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub action: String,
    pub name: String,
    pub existing: Option<FileNode>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub source: FileNode,
    pub target: Option<FileNode>,
    pub target_name: String,
    pub number: String,
    pub base: String,
    pub videos: Vec<FileNode>,
    pub moving: Vec<FileNode>,
    pub nfo: Artifact,
    pub poster: Artifact,
    pub needs_source: bool,
    /// 本视频在同番号文件里的区分标签；整理前计算，移动后沿用，见 [`variant::labels`]。
    #[serde(default)]
    pub label: String,
}
impl Plan {
    pub fn organizing_request(&self, scope: &str) -> Result<Option<FileMutationRequest>> {
        if self.moving.is_empty() {
            return Ok(None);
        }
        let mut assertions = vec![children_assertion(&self.source)?];
        let mut operations = Vec::new();
        let parent = if let Some(target) = &self.target {
            assertions.push(children_assertion(target)?);
            DirectoryTarget::Existing {
                id: target.id.clone(),
            }
        } else {
            operations.push(FileOperation::Mkdir {
                operation_id: "directory".into(),
                parent: DirectoryTarget::Existing {
                    id: self.source.id.clone(),
                },
                name: self.target_name.clone(),
            });
            DirectoryTarget::Created {
                operation_id: "directory".into(),
            }
        };
        for (i, file) in self.moving.iter().enumerate() {
            operations.push(FileOperation::Move {
                operation_id: format!("move_{i}"),
                node: condition(file),
                parent: parent.clone(),
                name: None,
            });
        }
        if operations.len() > tgdrive_contract::http::MAX_MUTATION_OPERATIONS as usize {
            return Err(Error::api(
                error_code::QUOTA_EXCEEDED,
                "本组视频及配套文件超过条件事务 64 项上限，未拆分移动",
            ));
        }
        Ok(Some(FileMutationRequest {
            scope_revision: scope.into(),
            assertions,
            operations,
        }))
    }
}
async fn read_existing(
    host: &dyn HostClient,
    file: &FileNode,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    if file.kind != NodeKind::File || file.size.0 == 0 || file.size.0 > limit as u64 {
        return Err(Error::api(
            error_code::INVALID_OPERATION,
            "既有资料为空、不是文件或超过读取预算，请显式覆盖或手动处理",
        ));
    }
    let content = file
        .content_version
        .clone()
        .ok_or(Error::Protocol("文件没有内容版本"))?;
    let read = async {
        let response = host
            .bytes(
                ContentRef {
                    id: file.id.clone(),
                    content_version: content,
                },
                ReadOptions::default(),
            )
            .await?;
        collect_bytes(response.body, limit as u64).await
    };
    let bytes = cancellable(cancel, async {
        tokio::time::timeout(Duration::from_secs(5), read)
            .await
            .map_err(|_| Error::api(error_code::INVALID_OPERATION, "既有资料读取超时，请重试"))?
    })
    .await?;
    let current = cancellable(
        cancel,
        host.stat(NodeReference::Id {
            id: file.id.clone(),
            content_version: file.content_version.clone(),
        }),
    )
    .await?;
    if current.revision != file.revision {
        return Err(Error::api(
            error_code::NODE_CHANGED,
            "读取期间资料位置或元数据已改变",
        ));
    }
    Ok(bytes.to_vec())
}

pub(crate) struct ActorCleanup {
    pub files: Vec<FileNode>,
    pub nfos: Vec<FileNode>,
}

pub(crate) async fn actor_cleanup(
    host: &dyn HostClient,
    snapshot: &DirectorySnapshot,
    base: &str,
    cancel: &CancellationToken,
) -> Result<ActorCleanup> {
    let nfos: Vec<_> = snapshot
        .entries
        .values()
        .filter(|node| node.kind == NodeKind::File && extension(&node.name) == "nfo")
        .cloned()
        .collect();
    if nfos
        .iter()
        .fold(0u64, |total, node| total.saturating_add(node.size.0))
        > DIRECTORY_BYTES as u64
    {
        return Err(Error::api(
            error_code::QUOTA_EXCEEDED,
            "同目录 NFO 引用核对超过 32 MiB 预算，未清理旧头像",
        ));
    }
    let read = async {
        let mut references = HashSet::new();
        for file in &nfos {
            let bytes = read_existing(host, file, nfo::MAX_BYTES, cancel).await?;
            let referenced = std::str::from_utf8(&bytes)
                .ok()
                .and_then(|xml| nfo::actor_image_references(xml, base))
                .ok_or_else(|| {
                    Error::api(
                        error_code::INVALID_OPERATION,
                        "同目录 NFO 无法解析，未猜测引用或清理旧头像",
                    )
                })?;
            references.extend(referenced);
        }
        Ok(ActorCleanup {
            files: snapshot
                .entries
                .values()
                .filter(|node| {
                    node.kind == NodeKind::File
                        && nfo::is_actor_image(&node.name, base)
                        && !references.contains(&node.name.to_ascii_lowercase())
                })
                .cloned()
                .collect(),
            nfos,
        })
    };
    cancellable(cancel, async {
        tokio::time::timeout(Duration::from_secs(40), read)
            .await
            .map_err(|_| {
                Error::api(
                    error_code::INVALID_OPERATION,
                    "同目录 NFO 引用核对超时，未清理旧头像",
                )
            })?
    })
    .await
}

pub async fn build(
    host: &dyn HostClient,
    cache: &mut DirectoryCache,
    files: &[FileNode],
    number: &str,
    scope: &str,
    overwrite: (bool, bool),
    cancel: &CancellationToken,
) -> Result<Plan> {
    let number = valid_number(number)?;
    let first = files
        .first()
        .ok_or_else(|| Error::api(error_code::INVALID_REQUEST, "没有待处理视频"))?;
    let parent = first
        .parent_id
        .as_deref()
        .ok_or(Error::Protocol("视频没有父目录"))?;
    let base = stem(&first.name).to_owned();
    if files.iter().any(|f| {
        f.parent_id.as_deref() != Some(parent)
            || !stem(&f.name).eq_ignore_ascii_case(&base)
            || f.kind != NodeKind::File
            || !video_name(&f.name)
    }) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "每组必须为同目录同基本名的视频",
        ));
    }
    let source = cache.get(host, parent, scope, cancel).await?;
    let siblings: Vec<_> = source.entries.values().cloned().collect();
    let ids: HashSet<_> = files.iter().map(|f| f.id.as_str()).collect();
    let mut videos = Vec::new();
    for file in files {
        let current = source
            .entries
            .get(&file.id)
            .ok_or_else(|| Error::api(error_code::NODE_CHANGED, "扫描后视频已移走或不可见"))?;
        if current.name != file.name
            || current.path != file.path
            || current.content_version != file.content_version
            || current.size != file.size
        {
            return Err(Error::api(
                error_code::NODE_CHANGED,
                "扫描后视频身份、位置或内容已改变",
            ));
        }
        videos.push(current.clone());
    }
    let all_videos: Vec<_> = siblings
        .iter()
        .filter(|f| f.kind == NodeKind::File && video_name(&f.name))
        .cloned()
        .collect();
    if all_videos
        .iter()
        .any(|v| stem(&v.name).eq_ignore_ascii_case(&base) && !ids.contains(v.id.as_str()))
    {
        return Err(Error::api(
            error_code::CHILDREN_CHANGED,
            "同基本名视频有新增格式，本组未进行部分整理",
        ));
    }
    let inside_number = normalized_number(&source.directory.name) == normalized_number(&number);
    let aliases: Vec<_> = siblings
        .iter()
        .filter(|n| {
            n.kind == NodeKind::Directory
                && normalized_number(&n.name) == normalized_number(&number)
        })
        .cloned()
        .collect();
    if !inside_number && aliases.len() > 1 {
        return Err(Error::api(
            error_code::NAME_CONFLICT,
            "同位置存在多个同番号目录，请先手动确定目标",
        ));
    }
    let mut target = if inside_number {
        Some(source.directory.clone())
    } else {
        aliases.first().cloned()
    };
    if !inside_number
        && target.is_none()
        && siblings
            .iter()
            .any(|n| n.name.eq_ignore_ascii_case(&number))
    {
        return Err(Error::api(
            error_code::NAME_CONFLICT,
            "目标番号名称已被文件占用",
        ));
    }
    let moving = if inside_number {
        Vec::new()
    } else {
        if siblings
            .iter()
            .any(|f| f.kind == NodeKind::File && common_artifact(&f.name))
        {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "原目录有归属不明的目录共用资料，本组已跳过；资料保持原位",
            ));
        }
        let companions: Vec<_> = siblings
            .iter()
            .filter(|f| {
                f.kind == NodeKind::File && !video_name(&f.name) && private_related(&f.name, &base)
            })
            .cloned()
            .collect();
        if companions
            .iter()
            .any(|f| other_video_uses(&f.name, &base, &all_videos))
        {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "配套资料同时关联多个视频，本组已跳过且未移动",
            ));
        }
        videos.iter().chain(companions.iter()).cloned().collect()
    };
    let target_files = if inside_number {
        siblings.clone()
    } else if let Some(directory) = &target {
        let snapshot = cache.get(host, &directory.id, scope, cancel).await?;
        let entries = snapshot.entries.values().cloned().collect();
        // 父目录缓存中的子目录行不代表该子目录最新的直属集合修订。
        target = Some(snapshot.directory);
        entries
    } else {
        Vec::new()
    };
    if !inside_number
        && moving.iter().any(|f| {
            target_files
                .iter()
                .any(|t| t.name.eq_ignore_ascii_case(&f.name))
        })
    {
        return Err(Error::api(
            error_code::NAME_CONFLICT,
            "目标已有同名视频或配套文件，本组不会移动或覆盖",
        ));
    }
    let final_files: Vec<_> = target_files.iter().chain(moving.iter()).cloned().collect();
    let nfo_name = format!("{base}.nfo");
    let private = find(&final_files, &nfo_name)?;
    let existing_nfo = private.clone().or(find(&final_files, "movie.nfo")?);
    let nfo = if let Some(existing) = existing_nfo.filter(|_| !overwrite.0) {
        Artifact {
            action: "keep".into(),
            name: existing.name.clone(),
            existing: Some(existing),
        }
    } else if let Some(private) = private {
        Artifact {
            action: "replace".into(),
            name: private.name.clone(),
            existing: Some(private),
        }
    } else {
        Artifact {
            action: "create".into(),
            name: nfo_name,
            existing: None,
        }
    };
    let mut existing_poster = None;
    for name in nfo::poster_names(&base) {
        if let Some(file) = find(&final_files, &name)? {
            existing_poster = Some(file);
            break;
        }
    }
    let private_jpeg = existing_poster
        .as_ref()
        .filter(|f| {
            private_related(&f.name, &base)
                && ["jpg", "jpeg"].contains(&extension(&f.name).as_str())
        })
        .cloned();
    let poster = if let Some(existing) = existing_poster.filter(|_| !overwrite.1) {
        Artifact {
            action: "keep".into(),
            name: existing.name.clone(),
            existing: Some(existing),
        }
    } else if let Some(file) = private_jpeg {
        Artifact {
            action: "replace".into(),
            name: file.name.clone(),
            existing: Some(file),
        }
    } else {
        Artifact {
            action: "create".into(),
            name: format!("{base}.jpg"),
            existing: None,
        }
    };
    let final_videos: Vec<_> = final_files
        .iter()
        .filter(|f| f.kind == NodeKind::File && video_name(&f.name))
        .cloned()
        .collect();
    for artifact in [&nfo, &poster] {
        if artifact.action != "keep" && other_video_uses(&artifact.name, &base, &final_videos) {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "拟写入的资料名称同时关联另一视频，已跳过",
            ));
        }
        if !tgdrive_contract::validation::valid_drive_name(&artifact.name) {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "资料文件名超过网盘名称预算，未截断名称",
            ));
        }
    }
    let mut existing_number = false;
    if nfo.action == "keep" {
        let file = nfo.existing.as_ref().expect("保留产物有文件");
        let bytes = read_existing(host, file, nfo::MAX_BYTES, cancel).await?;
        let xml = std::str::from_utf8(&bytes).map_err(|_| {
            Error::api(
                error_code::INVALID_OPERATION,
                "既有 NFO 不是 UTF-8，请显式覆盖或手动处理",
            )
        })?;
        if nfo::document(xml).is_none() {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "既有 NFO 无法解析，请显式覆盖或手动处理",
            ));
        }
        let supplied = nfo::number(xml);
        existing_number = supplied
            .as_ref()
            .is_some_and(|n| normalized_number(n) == normalized_number(&number));
        if supplied
            .as_ref()
            .is_some_and(|n| normalized_number(n) != normalized_number(&number))
            || file.name.eq_ignore_ascii_case("movie.nfo") && supplied.is_none()
        {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "既有 NFO 的作品归属不能确定，已跳过",
            ));
        }
    }
    if poster.action == "keep" {
        let bytes = read_existing(
            host,
            poster.existing.as_ref().expect("保留产物有文件"),
            images::POSTER_LIMIT,
            cancel,
        )
        .await?;
        images::decode(&bytes)?;
    }
    let needs_source =
        nfo.action != "keep" || poster.action != "keep" || !inside_number && !existing_number;
    // 版本与分段要对照同片的全部视频才能确定。散放的同片视频逐个移入番号目录，
    // 所以把原目录里还没移走的和目标目录里已有的合在一起看。
    let mut peers: Vec<&FileNode> = same_work(all_videos.iter(), &number, inside_number).collect();
    if !inside_number {
        let known: HashSet<&str> = peers.iter().map(|v| v.id.as_str()).collect();
        let arrived: Vec<&FileNode> = same_work(
            target_files
                .iter()
                .filter(|f| f.kind == NodeKind::File && video_name(&f.name)),
            &number,
            true,
        )
        .filter(|v| !known.contains(v.id.as_str()))
        .collect();
        peers.extend(arrived);
    }
    let names: Vec<&str> = peers.iter().map(|v| v.name.as_str()).collect();
    let label = peers
        .iter()
        .position(|v| v.id == first.id)
        .map(|at| variant::labels(&names, &number).swap_remove(at))
        .unwrap_or_default();
    let plan = Plan {
        source: source.directory,
        target,
        target_name: number.clone(),
        number,
        base,
        videos,
        moving,
        nfo,
        poster,
        needs_source,
        label,
    };
    plan.organizing_request(scope)?;
    Ok(plan)
}
