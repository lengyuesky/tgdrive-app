//! 每一步先保存完整请求和幂等键；宿主回执落入 SQLite 后才能宣布完成。
use crate::{
    database::Database,
    images,
    model::*,
    planner::{self, Artifact, DirectoryCache, Plan},
};
use bytes::Bytes;
use futures_util::stream;
use sha2::{Digest, Sha256};
use tgdrive_backend_sdk::{ByteStream, Error, HostClient, ReadOptions, Result, collect_bytes};
use tgdrive_contract::{ByteCount, error_code, files::*};
use tokio_util::sync::CancellationToken;

pub const NEEDS_VERIFICATION: &str = "scrape_needs_verification";
pub fn unsettled(state: &str) -> bool {
    matches!(
        state,
        "creating" | "uploading" | "ready" | "committing" | "unknown"
    )
}
fn uncertain(error: &Error) -> bool {
    match error {
        Error::Api { status, .. } => *status >= 500,
        Error::Validation(_) => false,
        _ => true,
    }
}
fn stream_bytes(bytes: Vec<u8>) -> ByteStream {
    Box::pin(stream::unfold(
        (Bytes::from(bytes), 0usize),
        |(bytes, offset)| async move {
            if offset >= bytes.len() {
                return None;
            }
            let end = (offset + 64 * 1024).min(bytes.len());
            Some((Ok(bytes.slice(offset..end)), (bytes, end)))
        },
    ))
}
pub fn confirmed_content(step: &Step) -> Option<ContentRef> {
    if let Some(file) = &step.file {
        return file.content_version.as_ref().map(|v| ContentRef {
            id: file.id.clone(),
            content_version: v.clone(),
        });
    }
    if let Some(result) = step.upload.as_ref().and_then(|u| u.result.clone()) {
        return Some(result);
    }
    step.receipt
        .as_ref()?
        .results
        .iter()
        .find(|r| r.operation_id == "file")
        .and_then(|r| {
            r.content_version.as_ref().map(|v| ContentRef {
                id: r.node_id.clone(),
                content_version: v.clone(),
            })
        })
}
fn pending(message: &str) -> Error {
    Error::api(NEEDS_VERIFICATION, message)
}
pub struct Writer<'a> {
    pub host: &'a dyn HostClient,
    pub db: &'a Database,
    pub process_id: &'a str,
    pub scope: &'a str,
    pub cancel: &'a CancellationToken,
}
impl Writer<'_> {
    fn step(&self, item: &Item, role: &str, name: &str) -> Step {
        Step {
            id: random_id(),
            process_id: self.process_id.into(),
            run_id: item.run_id.clone(),
            item_id: item.id.clone(),
            role: role.into(),
            name: name.into(),
            created_at: now(),
            ..Default::default()
        }
    }
    pub fn keep(&self, item: &Item, role: &str, artifact: &Artifact) -> Result<Step> {
        let mut step = self.step(item, role, &artifact.name);
        step.state = "kept".into();
        step.file = artifact.existing.clone();
        step.target_id = step.file.as_ref().and_then(|n| n.parent_id.clone());
        self.db.save_step(&step)?;
        Ok(step)
    }

    /// 新 NFO 提交确认或有效 NFO 保留后，按当前引用回收本组无用头像；失败重试只重新规划。
    pub async fn cleanup_actors(
        &self,
        item: &Item,
        run: &Run,
        plan: &Plan,
        cache: &mut DirectoryCache,
        nfo_step: &Step,
    ) -> Result<()> {
        let target = plan.target.as_ref().unwrap_or(&plan.source);
        let snapshot = cache
            .get(self.host, &target.id, self.scope, self.cancel)
            .await?;
        if !snapshot.entries.values().any(|node| {
            node.kind == NodeKind::File
                && crate::nfo::is_actor_image(&node.name, &plan.base)
                && !item
                    .actors
                    .iter()
                    .any(|actor| actor.data.thumb == node.name)
        }) {
            return Ok(());
        }
        let expected =
            confirmed_content(nfo_step).ok_or(Error::Protocol("头像清理没有已确认的 NFO 文件"))?;
        let current_nfo = snapshot
            .entries
            .get(&expected.id)
            .filter(|node| {
                node.name == nfo_step.name
                    && node.content_version.as_ref() == Some(&expected.content_version)
            })
            .ok_or_else(|| {
                Error::api(
                    error_code::NODE_CHANGED,
                    "已确认的 NFO 在头像清理前已改变，保留旧头像",
                )
            })?;
        let cleanup = planner::actor_cleanup(self.host, &snapshot, &plan.base, self.cancel).await?;
        for (index, batch) in cleanup
            .files
            .chunks(tgdrive_contract::http::MAX_MUTATION_OPERATIONS as usize)
            .enumerate()
        {
            let root = crate::scan::root_guard(self.host, run, self.cancel).await?;
            let current = cache
                .get(self.host, &target.id, self.scope, self.cancel)
                .await?;
            if current
                .entries
                .values()
                .filter(|node| node.kind == NodeKind::File && extension(&node.name) == "nfo")
                .count()
                != cleanup.nfos.len()
                || cleanup.nfos.iter().any(|old| {
                    !current.entries.get(&old.id).is_some_and(|node| {
                        node.revision == old.revision && node.content_version == old.content_version
                    })
                })
            {
                return Err(Error::api(
                    error_code::CHILDREN_CHANGED,
                    "清理期间 NFO 资料已改变，保留剩余旧头像",
                ));
            }
            let mut files = Vec::new();
            for old in batch {
                let Some(node) = current.entries.get(&old.id) else {
                    continue;
                };
                if node.revision != old.revision {
                    return Err(Error::api(
                        error_code::NODE_CHANGED,
                        "待清理头像已改变，未继续回收",
                    ));
                }
                files.push(node.clone());
            }
            if files.is_empty() {
                continue;
            }
            if self.cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            // 直属集合修订包含 NFO 的内容版本变化；读完引用后的新增或改写会阻止整批回收。
            let request = FileMutationRequest {
                scope_revision: self.scope.into(),
                assertions: vec![
                    planner::children_assertion(&current.directory)?,
                    planner::node_assertion(&root),
                    planner::node_assertion(current_nfo),
                ],
                operations: files
                    .iter()
                    .enumerate()
                    .map(|(i, file)| FileOperation::Trash {
                        operation_id: format!("actor_{i}"),
                        node: planner::condition(file),
                    })
                    .collect(),
            };
            let mut step = self.step(
                item,
                "actor_cleanup",
                &format!("旧演员头像（第 {} 批）", index + 1),
            );
            step.target_id = Some(target.id.clone());
            step.before = files;
            let receipt = self.mutation(&mut step, &random_id(), request).await?;
            step.receipt = Some(receipt);
            step.state = "done".into();
            step.message = format!("已将 {} 张不再引用的演员头像移入回收站", step.before.len());
            self.db.save_step(&step)?;
        }
        Ok(())
    }

    async fn mutation(
        &self,
        step: &mut Step,
        key: &str,
        request: FileMutationRequest,
    ) -> Result<MutationReceipt> {
        step.mutation_key = Some(key.into());
        step.mutation_request = Some(request.clone());
        step.state = "committing".into();
        self.db.save_step(step)?;
        match self.host.mutate(key.into(), request).await {
            Ok(receipt) => Ok(receipt),
            Err(error) if uncertain(&error) => match self.host.mutation_receipt(key.into()).await {
                Ok(receipt) => Ok(receipt),
                Err(_) => {
                    step.state = "unknown".into();
                    step.message = "提交结果尚未确认，已停止；不会换幂等键重复写入".into();
                    self.db.save_step(step)?;
                    Err(pending(&step.message))
                }
            },
            Err(error) => {
                step.state = "failed".into();
                step.message = error.to_string();
                self.db.save_step(step)?;
                Err(error)
            }
        }
    }
    pub async fn organize(&self, item: &Item, root: &FileNode, plan: &Plan) -> Result<Step> {
        let Some(mut request) = plan.organizing_request(self.scope)? else {
            let mut step = self.step(item, "organize", &plan.target_name);
            step.state = "kept".into();
            step.target_id = Some(plan.source.id.clone());
            self.db.save_step(&step)?;
            return Ok(step);
        };
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        request.assertions.push(planner::node_assertion(root));
        let mut step = self.step(item, "organize", &plan.target_name);
        step.before = plan.moving.clone();
        step.target_id = plan.target.as_ref().map(|d| d.id.clone());
        let key = random_id();
        let receipt = self.mutation(&mut step, &key, request).await?;
        if step.target_id.is_none() {
            step.target_id = receipt
                .results
                .iter()
                .find(|r| r.operation_id == "directory")
                .map(|r| r.node_id.clone());
        }
        step.receipt = Some(receipt);
        step.state = "done".into();
        step.message.clear();
        self.db.save_step(&step)?;
        Ok(step)
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn upload(
        &self,
        item: &Item,
        root: &FileNode,
        plan: &Plan,
        cache: &mut DirectoryCache,
        role: &str,
        artifact: &Artifact,
        bytes: Vec<u8>,
    ) -> Result<Step> {
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let limit = match role {
            "nfo" => crate::nfo::MAX_BYTES,
            "poster" => images::POSTER_LIMIT,
            _ => images::ACTOR_LIMIT,
        };
        if bytes.len() > limit {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "刮削产物超过预算，未截断也未上传",
            ));
        }
        let target = plan.target.as_ref().unwrap_or(&plan.source);
        let snapshot = cache
            .get(self.host, &target.id, self.scope, self.cancel)
            .await?;
        let current_videos: Vec<_> = snapshot
            .entries
            .values()
            .filter(|n| n.kind == NodeKind::File && video_name(&n.name))
            .cloned()
            .collect();
        if planner::other_video_uses(&artifact.name, &plan.base, &current_videos) {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "新资料名称与另一视频重叠，已跳过",
            ));
        }
        for video in &plan.videos {
            let current = snapshot
                .entries
                .get(&video.id)
                .ok_or_else(|| Error::api(error_code::NODE_CHANGED, "视频已离开资料目录"))?;
            if current.revision != video.revision
                || current.content_version != video.content_version
            {
                return Err(Error::api(error_code::NODE_CHANGED, "写入前视频已改变"));
            }
        }
        if current_videos.iter().any(|v| {
            stem(&v.name).eq_ignore_ascii_case(&plan.base)
                && !plan.videos.iter().any(|p| p.id == v.id)
        }) {
            return Err(Error::api(
                error_code::CHILDREN_CHANGED,
                "本组出现新视频格式，未部分刮削",
            ));
        }
        if role == "nfo" {
            for actor in item.actors.iter().filter(|a| !a.data.thumb.is_empty()) {
                let id = actor.image_step.as_deref().ok_or_else(|| {
                    Error::api(error_code::INVALID_OPERATION, "头像引用没有已确认步骤")
                })?;
                let saved = self.db.step(id)?;
                let expected = confirmed_content(&saved).ok_or_else(|| {
                    Error::api(
                        error_code::INVALID_OPERATION,
                        "头像步骤没有已提交的文件引用",
                    )
                })?;
                if !snapshot.entries.values().any(|n| {
                    n.name == actor.data.thumb
                        && n.id == expected.id
                        && n.content_version.as_ref() == Some(&expected.content_version)
                }) {
                    return Err(Error::api(
                        error_code::NODE_CHANGED,
                        "头像在 NFO 提交前已移走或改变，未写入失效引用",
                    ));
                }
            }
        }
        let mut assertions = vec![
            planner::children_assertion(&snapshot.directory)?,
            planner::node_assertion(root),
        ];
        assertions.extend(plan.videos.iter().map(planner::node_assertion));
        let target_request = match artifact.action.as_str() {
            "create" => UploadTarget::Create {
                parent_id: target.id.clone(),
                name: artifact.name.clone(),
            },
            "replace" => UploadTarget::Replace {
                node: planner::condition(
                    artifact
                        .existing
                        .as_ref()
                        .ok_or(Error::Protocol("覆盖没有文件条件"))?,
                ),
            },
            _ => return Err(Error::Protocol("上传产物操作无效")),
        };
        let mut step = self.step(item, role, &artifact.name);
        step.target_id = Some(target.id.clone());
        step.before = artifact.existing.iter().cloned().collect();
        step.sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
        step.size = Some(bytes.len() as u64);
        let request = CreateUploadRequest {
            target: target_request,
            size: ByteCount(bytes.len() as u64),
            sha256: step.sha256.clone(),
            scope_revision: self.scope.into(),
        };
        let create_key = random_id();
        step.create_key = Some(create_key.clone());
        step.create_request = Some(request.clone());
        step.state = "creating".into();
        self.db.save_step(&step)?;
        let created = match self
            .host
            .create_upload(create_key.clone(), request.clone())
            .await
        {
            Ok(info) => info,
            Err(error) if uncertain(&error) => {
                match self.host.create_upload(create_key, request).await {
                    Ok(info) => info,
                    Err(_) => {
                        step.state = "unknown".into();
                        step.message = "创建上传句柄的结果不明；未重新生成幂等键".into();
                        self.db.save_step(&step)?;
                        return Err(pending(&step.message));
                    }
                }
            }
            Err(error) => {
                step.state = "failed".into();
                step.message = error.to_string();
                self.db.save_step(&step)?;
                return Err(error);
            }
        };
        step.upload = Some(created.clone());
        self.db.save_step(&step)?;
        if self.cancel.is_cancelled() {
            self.cancel_created(&mut step).await?;
            return Err(Error::Cancelled);
        }
        step.state = "uploading".into();
        self.db.save_step(&step)?;
        let body = self
            .host
            .upload_body(created.id.clone(), stream_bytes(bytes), step.size);
        tokio::pin!(body);
        let received = tokio::select! { biased;
            _=self.cancel.cancelled()=>{
                // 不先丢弃原请求，也不声称超时等于回滚；取消句柄是禁止未来提交的通用围栏。
                let cancelled=self.host.cancel_upload(created.id.clone()).await;
                let result=body.await;
                if cancelled.is_err() { step.state="unknown".into(); step.message="停止上传尚未确认，待核实".into(); self.db.save_step(&step)?; return Err(pending(&step.message)); }
                result
            },
            received=&mut body=>received,
        };
        let info = match received {
            Ok(info) => info,
            Err(error) => match self.host.upload_status(created.id.clone()).await {
                Ok(info) => info,
                Err(_) if uncertain(&error) => {
                    step.state = "unknown".into();
                    step.message = "上传正文结果未能核实；未重复发送正文".into();
                    self.db.save_step(&step)?;
                    return Err(pending(&step.message));
                }
                Err(_) => {
                    step.state = "failed".into();
                    step.message = error.to_string();
                    self.db.save_step(&step)?;
                    return Err(error);
                }
            },
        };
        step.upload = Some(info.clone());
        self.db.save_step(&step)?;
        if self.cancel.is_cancelled() {
            self.cancel_created(&mut step).await?;
            return Err(Error::Cancelled);
        }
        match info.state {
            UploadState::Ready => {}
            UploadState::Failed | UploadState::Cancelled => {
                step.state = "failed".into();
                step.message = "宿主确认本次上传未能完成".into();
                self.db.save_step(&step)?;
                return Err(Error::api(error_code::UPSTREAM_UNAVAILABLE, &step.message));
            }
            UploadState::AwaitingBody => {
                self.cancel_created(&mut step).await?;
                return Err(Error::api(
                    error_code::UPSTREAM_UNAVAILABLE,
                    "宿主未收到上传正文，句柄已取消",
                ));
            }
            _ => {
                step.state = "unknown".into();
                step.message = "上传仍在接收或状态不明，已停止并等待核实".into();
                self.db.save_step(&step)?;
                return Err(pending(&step.message));
            }
        }
        step.state = "ready".into();
        self.db.save_step(&step)?;
        let key = random_id();
        let request = FileMutationRequest {
            scope_revision: self.scope.into(),
            assertions,
            operations: vec![FileOperation::CommitUpload {
                operation_id: "file".into(),
                upload_id: info.id,
            }],
        };
        let receipt = match self.mutation(&mut step, &key, request).await {
            Ok(receipt) => receipt,
            Err(error) => {
                if error.code() != NEEDS_VERIFICATION {
                    let _ = self.host.cancel_upload(created.id).await;
                }
                return Err(error);
            }
        };
        step.receipt = Some(receipt.clone());
        step.state = "done".into();
        step.message.clear();
        self.db.save_step(&step)?;
        // 回执已保存，之后的 stat 失败不会把已提交误判成未写入。
        if let Some(result) = receipt.results.iter().find(|r| r.operation_id == "file")
            && let Ok(file) = self
                .host
                .stat(NodeReference::Id {
                    id: result.node_id.clone(),
                    content_version: result.content_version.clone(),
                })
                .await
        {
            step.file = Some(file);
            self.db.save_step(&step)?;
        }
        Ok(step)
    }
    async fn cancel_created(&self, step: &mut Step) -> Result<()> {
        let Some(upload) = &step.upload else {
            return Err(pending("上传句柄尚未确认"));
        };
        let id = upload.id.clone();
        if self.host.cancel_upload(id.clone()).await.is_err() {
            step.state = "unknown".into();
            step.message = "未提交上传的取消结果尚未确认".into();
            self.db.save_step(step)?;
            return Err(pending(&step.message));
        }
        step.state = "failed".into();
        step.message = "未提交上传已取消，已有网盘文件不变".into();
        if let Ok(info) = self.host.upload_status(id).await {
            step.upload = Some(info);
        }
        self.db.save_step(step)
    }
    /// 用户主动重试时只核实，不重放旧的覆盖计划。不同进程轮次意味着旧写入已被宿主撤销。
    pub async fn verify(&self, step: &mut Step) -> Result<bool> {
        if !unsettled(&step.state) {
            return Ok(true);
        }
        if let Some(key) = &step.mutation_key {
            match self.host.mutation_receipt(key.clone()).await {
                Ok(receipt) => {
                    step.receipt = Some(receipt);
                    step.state = "done".into();
                    step.message = "已按宿主回执核实".into();
                    self.db.save_step(step)?;
                    return Ok(true);
                }
                Err(error) if error.code() == error_code::NOT_FOUND => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(upload) = &step.upload {
            match self.host.upload_status(upload.id.clone()).await {
                Ok(info) if info.state == UploadState::Committed => {
                    if let Some(file) = &info.result {
                        step.file = self
                            .host
                            .stat(NodeReference::Id {
                                id: file.id.clone(),
                                content_version: Some(file.content_version.clone()),
                            })
                            .await
                            .ok();
                    }
                    step.upload = Some(info);
                    step.state = "done".into();
                    step.message = "已按上传提交状态核实".into();
                    self.db.save_step(step)?;
                    return Ok(true);
                }
                Ok(info) if matches!(info.state, UploadState::Failed | UploadState::Cancelled) => {
                    step.upload = Some(info);
                    step.state = "failed".into();
                    step.message = "宿主确认旧上传未提交".into();
                    self.db.save_step(step)?;
                    return Ok(true);
                }
                Ok(info) if step.mutation_key.is_none() && info.state != UploadState::Committed => {
                    step.upload = Some(info);
                    self.cancel_created(step).await?;
                    return Ok(true);
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.code(),
                        error_code::NOT_FOUND | error_code::UPLOAD_EXPIRED
                    ) => {}
                Err(error) => return Err(error),
            }
        }
        if !matches!(step.role.as_str(), "organize" | "actor_cleanup") {
            let current = match (&step.create_request, &step.target_id) {
                (
                    Some(CreateUploadRequest {
                        target: UploadTarget::Replace { node },
                        ..
                    }),
                    _,
                ) => {
                    self.host
                        .stat(NodeReference::Id {
                            id: node.id.clone(),
                            content_version: None,
                        })
                        .await
                }
                (_, Some(parent)) => {
                    let directory = self
                        .host
                        .stat(NodeReference::Id {
                            id: parent.clone(),
                            content_version: None,
                        })
                        .await?;
                    self.host
                        .stat(NodeReference::Path {
                            path: joined(&directory.path, &step.name),
                            content_version: None,
                        })
                        .await
                }
                _ => return Ok(false),
            };
            match current {
                Ok(file)
                    if file.kind == NodeKind::File
                        && file.size.0 == step.size.unwrap_or(u64::MAX) =>
                {
                    let content = file
                        .content_version
                        .clone()
                        .ok_or(Error::Protocol("核实文件没有内容版本"))?;
                    let response = self
                        .host
                        .bytes(
                            ContentRef {
                                id: file.id.clone(),
                                content_version: content,
                            },
                            ReadOptions::default(),
                        )
                        .await?;
                    let bytes = collect_bytes(response.body, step.size.unwrap_or(0)).await?;
                    if Some(format!("{:x}", Sha256::digest(&bytes))) == step.sha256 {
                        let current = self
                            .host
                            .stat(NodeReference::Id {
                                id: file.id.clone(),
                                content_version: file.content_version.clone(),
                            })
                            .await?;
                        if current.revision == file.revision {
                            step.file = Some(file);
                            step.state = "done".into();
                            step.message = "已按当前文件完整 SHA256 核实".into();
                            self.db.save_step(step)?;
                            return Ok(true);
                        }
                    }
                }
                Ok(_) => {}
                Err(error) if error.code() == error_code::NOT_FOUND => {}
                Err(error) => return Err(error),
            }
        }
        if step.process_id == self.process_id {
            step.state = "unknown".into();
            step.message =
                "本轮提交仍缺少终态证据；请在应用中心重启后端后再核实，不能把无回执当成失败".into();
            self.db.save_step(step)?;
            return Ok(false);
        }
        // 后端重启围栏使旧轮次不可能再提交；仍只保留现有文件，并由新计划按当前状态补缺。
        if step.role == "organize" {
            let mut current = Vec::new();
            for old in &step.before {
                let node = self
                    .host
                    .stat(NodeReference::Id {
                        id: old.id.clone(),
                        content_version: old.content_version.clone(),
                    })
                    .await?;
                current.push(node);
            }
            let all_source = current
                .iter()
                .zip(&step.before)
                .all(|(a, b)| a.parent_id == b.parent_id && a.name == b.name);
            let one_target = current
                .first()
                .and_then(|n| n.parent_id.as_ref())
                .filter(|parent| current.iter().all(|n| n.parent_id.as_ref() == Some(parent)));
            let organized = if !all_source {
                if let Some(parent) = one_target {
                    let directory = self
                        .host
                        .stat(NodeReference::Id {
                            id: parent.clone(),
                            content_version: None,
                        })
                        .await?;
                    normalized_number(&directory.name) == normalized_number(&step.name)
                } else {
                    false
                }
            } else {
                false
            };
            if !all_source && !organized {
                step.message = "当前整组文件不在同一源/目标状态，请手动核实，未执行部分移动".into();
                self.db.save_step(step)?;
                return Ok(false);
            }
            step.state = if organized { "done" } else { "failed" }.into();
            step.target_id = if organized {
                one_target.cloned()
            } else {
                step.target_id.clone()
            };
        } else {
            step.state = "failed".into();
        }
        step.message = "旧后端轮次已撤销，按当前文件状态核实；新任务仅补缺".into();
        self.db.save_step(step)?;
        Ok(true)
    }
}
