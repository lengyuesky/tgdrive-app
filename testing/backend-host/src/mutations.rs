use crate::{
    SeedNode,
    state::{State, Upload},
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{ByteCount, Timestamp, error_code, files::*, http::*, validation::*};

fn scope(state: &State, revision: &str) -> Result<()> {
    if !state.config.files.write {
        return Err(Error::api(error_code::WRITE_NOT_DECLARED, "应用未声明写入"));
    }
    if revision != state.scope_revision {
        return Err(Error::api(error_code::SCOPE_CHANGED, "目录授权修订不匹配"));
    }
    Ok(())
}
pub(crate) fn validate_key(key: &str) -> Result<()> {
    if !valid_idempotency_key(key) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "幂等键不符合契约边界",
        ));
    }
    Ok(())
}
fn node_condition(state: &State, condition: &NodeCondition) -> Result<FileNode> {
    if !valid_node_id(&condition.id) || !valid_opaque_id(&condition.revision) {
        return Err(Error::api(error_code::INVALID_REQUEST, "节点条件无效"));
    }
    let node = state.read_node(&condition.id)?.node.clone();
    if node.revision != condition.revision {
        return Err(Error::api(error_code::NODE_CHANGED, "节点修订不匹配"));
    }
    Ok(node)
}
fn write_existing(state: &State, id: &str) -> Result<FileNode> {
    let node = state.write_node(id)?.node.clone();
    let parent = node
        .parent_id
        .as_ref()
        .ok_or_else(|| Error::api(error_code::INVALID_OPERATION, "不能修改网盘根目录"))?;
    state.directory(parent, true)?;
    if node.kind == NodeKind::Directory {
        for stored in state.nodes.values().filter(|node| {
            node.visible
                && state
                    .ancestors(&node.node.id)
                    .iter()
                    .any(|ancestor| ancestor == id)
        }) {
            state.write_node(&stored.node.id)?;
        }
    }
    Ok(node)
}
fn upload_target(state: &State, target: &UploadTarget) -> Result<()> {
    match target {
        UploadTarget::Create { parent_id, name } => {
            if !valid_node_id(parent_id) || !valid_drive_name(name) {
                return Err(Error::api(error_code::INVALID_REQUEST, "上传目标无效"));
            }
            state.directory(parent_id, true)?;
            state.unique_name(parent_id, name, None)?;
        }
        UploadTarget::Replace { node } => {
            let current = node_condition(state, node)?;
            if current.kind != NodeKind::File {
                return Err(Error::api(error_code::IS_DIRECTORY, "不能覆盖目录"));
            }
            write_existing(state, &node.id)?;
        }
    }
    Ok(())
}
pub(crate) fn create_upload(
    state: &mut State,
    key: String,
    request: CreateUploadRequest,
) -> Result<UploadInfo> {
    validate_key(&key)?;
    scope(state, &request.scope_revision)?;
    if request.size.0 > i64::MAX as u64
        || request
            .sha256
            .as_ref()
            .is_some_and(|sha| !valid_sha256(sha))
    {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "上传大小或摘要无效",
        ));
    }
    let normalized = serde_json::to_value(&request)?;
    if let Some((previous, id)) = state.upload_keys.get(&key) {
        if previous != &normalized {
            return Err(Error::api(
                error_code::IDEMPOTENCY_CONFLICT,
                "幂等键已经绑定另一上传",
            ));
        }
        return upload_status(state, id);
    }
    upload_target(state, &request.target)?;
    if state
        .uploads
        .values()
        .filter(|upload| {
            upload.info.expires_at.0 > state.now
                && matches!(
                    upload.info.state,
                    UploadState::AwaitingBody | UploadState::Receiving | UploadState::Ready
                )
        })
        .count()
        >= MAX_UPLOADS as usize
    {
        return Err(Error::api(error_code::QUOTA_EXCEEDED, "未提交上传已达上限"));
    }
    let id = state.id("upload");
    let info = UploadInfo {
        id: id.clone(),
        state: UploadState::AwaitingBody,
        size: request.size,
        received_bytes: ByteCount(0),
        expires_at: Timestamp(state.now + UPLOAD_RETENTION_SECONDS as i64 * 1000),
        result: None,
        error_code: None,
    };
    state.uploads.insert(
        id.clone(),
        Upload {
            info: info.clone(),
            request,
            body: Vec::new(),
        },
    );
    state.upload_keys.insert(key, (normalized, id));
    Ok(info)
}
pub(crate) fn upload_status(state: &State, id: &str) -> Result<UploadInfo> {
    let upload = state
        .uploads
        .get(id)
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "上传句柄不存在"))?;
    if upload.info.expires_at.0 <= state.now {
        return Err(Error::api(error_code::UPLOAD_EXPIRED, "上传句柄已过期"));
    }
    Ok(upload.info.clone())
}
pub(crate) fn begin_body(
    state: &mut State,
    id: &str,
    length: Option<u64>,
) -> Result<CreateUploadRequest> {
    let info = upload_status(state, id)?;
    if info.state != UploadState::AwaitingBody {
        return Err(Error::api(error_code::UPLOAD_STATE, "上传正文只接受一次"));
    }
    let request = state.uploads[id].request.clone();
    scope(state, &request.scope_revision)?;
    upload_target(state, &request.target)?;
    if length.is_some_and(|length| length != info.size.0) {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "正文长度与声明不符",
        ));
    }
    state.uploads.get_mut(id).unwrap().info.state = UploadState::Receiving;
    Ok(request)
}
pub(crate) fn receive_body(
    state: &mut State,
    id: &str,
    request: &CreateUploadRequest,
    received: u64,
) -> Result<()> {
    upload_status(state, id)?;
    scope(state, &request.scope_revision)?;
    upload_target(state, &request.target)?;
    if received > request.size.0 {
        return Err(Error::api(
            error_code::PAYLOAD_TOO_LARGE,
            "正文超过声明大小",
        ));
    }
    state.uploads.get_mut(id).unwrap().info.received_bytes = ByteCount(received);
    Ok(())
}
pub(crate) fn finish_body(
    state: &mut State,
    id: &str,
    request: &CreateUploadRequest,
    bytes: Vec<u8>,
) -> Result<UploadInfo> {
    receive_body(state, id, request, bytes.len() as u64)?;
    let valid_length = bytes.len() as u64 == request.size.0;
    use sha2::{Digest, Sha256};
    let valid_digest = request
        .sha256
        .as_ref()
        .is_none_or(|digest| format!("{:x}", Sha256::digest(&bytes)) == *digest);
    let upload = state.uploads.get_mut(id).unwrap();
    if !valid_length || !valid_digest {
        upload.info.state = UploadState::Failed;
        upload.info.error_code = Some(error_code::INVALID_REQUEST.into());
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "正文长度或摘要不匹配",
        ));
    }
    upload.body = bytes;
    upload.info.state = UploadState::Ready;
    Ok(upload.info.clone())
}
pub(crate) fn cancel_upload(state: &mut State, id: &str) -> Result<()> {
    let info = upload_status(state, id)?;
    if info.state == UploadState::Committed {
        return Err(Error::api(
            error_code::UPLOAD_STATE,
            "已提交上传不能变成文件删除",
        ));
    }
    let upload = state.uploads.get_mut(id).unwrap();
    upload.info.state = UploadState::Cancelled;
    upload.body.clear();
    Ok(())
}
fn parent(
    state: &State,
    target: &DirectoryTarget,
    created: &BTreeMap<String, String>,
) -> Result<String> {
    let id = match target {
        DirectoryTarget::Existing { id } => id.clone(),
        DirectoryTarget::Created { operation_id } => created
            .get(operation_id)
            .cloned()
            .ok_or_else(|| Error::api(error_code::INVALID_OPERATION, "新建目录引用必须先出现"))?,
    };
    state.directory(&id, true)?;
    Ok(id)
}
fn operation_id(operation: &FileOperation) -> &str {
    match operation {
        FileOperation::Mkdir { operation_id, .. }
        | FileOperation::Rename { operation_id, .. }
        | FileOperation::Move { operation_id, .. }
        | FileOperation::Trash { operation_id, .. }
        | FileOperation::CommitUpload { operation_id, .. } => operation_id,
    }
}
fn existing_condition(operation: &FileOperation) -> Option<&NodeCondition> {
    match operation {
        FileOperation::Rename { node, .. }
        | FileOperation::Move { node, .. }
        | FileOperation::Trash { node, .. } => Some(node),
        _ => None,
    }
}
pub(crate) fn mutation_receipt(state: &State, key: &str) -> Result<MutationReceipt> {
    validate_key(key)?;
    state
        .receipts
        .get(key)
        .filter(|(_, receipt)| receipt.expires_at.0 > state.now)
        .map(|(_, receipt)| receipt.clone())
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "没有已提交回执"))
}
pub(crate) fn mutate(
    state: &mut State,
    key: String,
    request: FileMutationRequest,
) -> Result<MutationReceipt> {
    validate_key(&key)?;
    scope(state, &request.scope_revision)?;
    let normalized: Value = serde_json::to_value(&request)?;
    parse_unique_json(&serde_json::to_vec(&normalized)?)?;
    if let Some((previous, receipt)) = state.receipts.get(&key) {
        if receipt.expires_at.0 <= state.now {
            return Err(Error::api(
                error_code::IDEMPOTENCY_CONFLICT,
                "不允许复用历史幂等键",
            ));
        }
        if previous != &normalized {
            return Err(Error::api(
                error_code::IDEMPOTENCY_CONFLICT,
                "幂等键已经绑定另一事务",
            ));
        }
        return Ok(receipt.clone());
    }
    if request.operations.is_empty()
        || request.operations.len() > MAX_MUTATION_OPERATIONS as usize
        || request.assertions.len() > MAX_MUTATION_ASSERTIONS as usize
    {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "事务操作或断言数量无效",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut existing = BTreeSet::new();
    for operation in &request.operations {
        let id = operation_id(operation);
        if !valid_operation_id(id) || !ids.insert(id) {
            return Err(Error::api(
                error_code::INVALID_OPERATION,
                "操作标识无效或重复",
            ));
        }
        if let Some(condition) = existing_condition(operation) {
            node_condition(state, condition)?;
            if !existing.insert(condition.id.clone()) {
                return Err(Error::api(
                    error_code::INVALID_OPERATION,
                    "同一批次不能重复修改同一节点",
                ));
            }
        }
        if let FileOperation::CommitUpload { upload_id, .. } = operation {
            upload_status(state, upload_id)?;
            if let UploadTarget::Replace { node } = &state.uploads[upload_id].request.target {
                node_condition(state, node)?;
                if !existing.insert(node.id.clone()) {
                    return Err(Error::api(
                        error_code::INVALID_OPERATION,
                        "同一批次不能重复修改同一节点",
                    ));
                }
            }
        }
    }
    for assertion in &request.assertions {
        match assertion {
            FileAssertion::Node { id, revision } => {
                node_condition(
                    state,
                    &NodeCondition {
                        id: id.clone(),
                        revision: revision.clone(),
                    },
                )?;
            }
            FileAssertion::Children {
                directory_id,
                children_revision,
            } => {
                if !valid_node_id(directory_id) || !valid_opaque_id(children_revision) {
                    return Err(Error::api(error_code::INVALID_REQUEST, "直属集合断言无效"));
                }
                if state
                    .directory(directory_id, false)?
                    .node
                    .children_revision
                    .as_ref()
                    != Some(children_revision)
                {
                    return Err(Error::api(error_code::CHILDREN_CHANGED, "直属集合已经变化"));
                }
            }
        }
    }
    // 对内存工作副本执行，失败不会泄露局部目录、移动、覆盖或事件；回执一起提交。
    let mut working = state.clone();
    working.query_cache.clear();
    let root_signature = working.root_signature();
    let mut created = BTreeMap::new();
    let mut results = Vec::new();
    for operation in &request.operations {
        let result = match operation {
            FileOperation::Mkdir {
                operation_id,
                parent: target,
                name,
            } => {
                let parent = parent(&working, target, &created)?;
                let id = working.next_node.to_string();
                working.next_node += 1;
                let node = working.add_seed(SeedNode {
                    id: id.clone(),
                    parent_id: parent,
                    name: name.clone(),
                    kind: NodeKind::Directory,
                    bytes: Vec::new(),
                    thumbnail: None,
                })?;
                created.insert(operation_id.clone(), id);
                node
            }
            FileOperation::Rename { node, name, .. }
            | FileOperation::Move {
                node,
                name: Some(name),
                ..
            } => {
                if !valid_drive_name(name) {
                    return Err(Error::api(error_code::INVALID_REQUEST, "新名称无效"));
                }
                change_node(&mut working, node, operation, Some(name), &created)?
            }
            FileOperation::Move {
                node, name: None, ..
            } => change_node(&mut working, node, operation, None, &created)?,
            FileOperation::Trash { node, .. } => {
                change_node(&mut working, node, operation, None, &created)?
            }
            FileOperation::CommitUpload { upload_id, .. } => {
                commit_upload(&mut working, upload_id)?
            }
        };
        results.push(MutationResult {
            operation_id: operation_id(operation).into(),
            node_id: result.id,
            content_version: result.content_version,
        });
    }
    working.refresh_scope(root_signature);
    let receipt = MutationReceipt {
        idempotency_key: key.clone(),
        committed_at: Timestamp(working.now),
        results,
        expires_at: Timestamp(working.now + MUTATION_RECEIPT_SECONDS as i64 * 1000),
    };
    working.receipts.insert(key, (normalized, receipt.clone()));
    *state = working;
    Ok(receipt)
}
fn change_node(
    state: &mut State,
    condition: &NodeCondition,
    operation: &FileOperation,
    name: Option<&String>,
    created: &BTreeMap<String, String>,
) -> Result<FileNode> {
    let old = write_existing(state, &condition.id)?;
    let old_ancestors = state.ancestors(&condition.id);
    let old_parent = old.parent_id.as_ref().unwrap().clone();
    let destination = match operation {
        FileOperation::Move { parent: target, .. } => parent(state, target, created)?,
        _ => old_parent.clone(),
    };
    if old.kind == NodeKind::Directory && state.ancestors(&destination).contains(&old.id) {
        return Err(Error::api(
            error_code::INVALID_OPERATION,
            "目录不能移入自身或子孙",
        ));
    }
    let new_name = name.cloned().unwrap_or_else(|| old.name.clone());
    if !matches!(operation, FileOperation::Trash { .. }) {
        state.unique_name(&destination, &new_name, Some(&old.id))?;
    }
    let revision = state.id("node");
    let node = state.nodes.get_mut(&old.id).unwrap();
    node.node.name = new_name;
    node.node.parent_id = Some(destination.clone());
    node.node.revision = revision;
    node.node.modified_at = Timestamp(state.now);
    if matches!(operation, FileOperation::Trash { .. }) {
        node.visible = false;
    }
    state.touch_parent(&old_parent);
    if destination != old_parent {
        state.touch_parent(&destination);
    }
    state.rebuild_paths()?;
    let node = state.nodes[&old.id].node.clone();
    state.log(
        Some(old.clone()),
        node.clone(),
        old.kind == NodeKind::Directory,
        old_ancestors,
    );
    Ok(node)
}
fn commit_upload(state: &mut State, id: &str) -> Result<FileNode> {
    let info = upload_status(state, id)?;
    if info.state != UploadState::Ready {
        return Err(Error::api(
            error_code::UPLOAD_STATE,
            "只有 ready 上传可以提交",
        ));
    }
    let upload = state.uploads[id].clone();
    scope(state, &upload.request.scope_revision)?;
    upload_target(state, &upload.request.target)?;
    let node = match upload.request.target {
        UploadTarget::Create { parent_id, name } => {
            let id = state.next_node.to_string();
            state.next_node += 1;
            state.add_seed(SeedNode {
                id,
                parent_id,
                name,
                kind: NodeKind::File,
                bytes: upload.body,
                thumbnail: None,
            })?
        }
        UploadTarget::Replace { node } => {
            let old = state.nodes[&node.id].node.clone();
            let ancestors = state.ancestors(&node.id);
            let revision = state.id("node");
            let content_version = state.id("content");
            let stored = state.nodes.get_mut(&node.id).unwrap();
            stored.node.revision = revision;
            stored.node.content_version = Some(content_version);
            stored.node.size = ByteCount(upload.body.len() as u64);
            stored.node.modified_at = Timestamp(state.now);
            stored.node.has_thumbnail = false;
            stored.thumbnail = None;
            stored.bytes = upload.body;
            let new = stored.node.clone();
            state.touch_parent(new.parent_id.as_ref().unwrap());
            state.log(Some(old), new.clone(), false, ancestors);
            new
        }
    };
    let upload = state.uploads.get_mut(id).unwrap();
    upload.info.state = UploadState::Committed;
    upload.info.result = Some(ContentRef {
        id: node.id.clone(),
        content_version: node.content_version.clone().unwrap(),
    });
    upload.info.expires_at = Timestamp(state.now + MUTATION_RECEIPT_SECONDS as i64 * 1000);
    upload.body.clear();
    Ok(node)
}
