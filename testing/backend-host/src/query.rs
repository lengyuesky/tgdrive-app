use crate::state::{CursorState, State};
use serde_json::Value;
use std::{cmp::Ordering, collections::BTreeSet, sync::Arc};
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::{error_code, files::*, http::*, validation::*};

pub(crate) fn stat(state: &State, reference: NodeReference) -> Result<FileNode> {
    let (id, expected) = match reference {
        NodeReference::Id {
            id,
            content_version,
        } => {
            if !valid_node_id(&id) {
                return Err(Error::api(error_code::INVALID_REQUEST, "节点 ID 无效"));
            }
            (id, content_version)
        }
        NodeReference::Path {
            path,
            content_version,
        } => {
            if !valid_drive_path(&path) {
                return Err(Error::api(error_code::INVALID_PATH, "网盘路径无效"));
            }
            let id = state
                .nodes
                .values()
                .find(|node| node.node.path == path && node.visible)
                .map(|node| node.node.id.clone())
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "节点不存在"))?;
            (id, content_version)
        }
    };
    let node = state.read_node(&id)?.node.clone();
    if let Some(version) = expected {
        if !valid_opaque_id(&version) {
            return Err(Error::api(error_code::INVALID_REQUEST, "内容版本无效"));
        }
        if node.kind == NodeKind::Directory {
            return Err(Error::api(error_code::IS_DIRECTORY, "目录不能提供内容版本"));
        }
        if node.content_version.as_ref() != Some(&version) {
            return Err(Error::api(error_code::CONTENT_CHANGED, "文件内容已经变化"));
        }
    }
    Ok(node)
}

fn roots(state: &State, requested: &[String]) -> Result<Vec<String>> {
    if !state.config.files.read || matches!(state.config.scope, DirectoryScope::None) {
        return Err(Error::api(error_code::SCOPE_DENIED, "没有文件读取授权"));
    }
    let ids = if requested.is_empty() {
        state
            .scope_info()
            .roots
            .into_iter()
            .filter(|root| root.node.is_some())
            .map(|root| root.directory_id)
            .collect()
    } else {
        requested.to_vec()
    };
    for id in &ids {
        state.directory(id, false)?;
    }
    Ok(ids)
}
fn in_roots(
    state: &State,
    node: &FileNode,
    roots: &[String],
    recursive: bool,
    include_root: bool,
) -> bool {
    if state.read_node(&node.id).is_err() {
        return false;
    }
    if include_root && roots.contains(&node.id) {
        return true;
    }
    if recursive {
        state
            .ancestors(&node.id)
            .iter()
            .skip(1)
            .any(|id| roots.contains(id))
    } else {
        node.parent_id.as_ref().is_some_and(|id| roots.contains(id))
    }
}
fn fold(value: &str) -> String {
    value.to_ascii_lowercase()
}
pub(crate) fn matches_filter(state: &State, node: &FileNode, filter: &FileFilter) -> bool {
    if filter.kind != QueryKind::All
        && (filter.kind == QueryKind::File) != (node.kind == NodeKind::File)
    {
        return false;
    }
    if !filter.include_hidden
        && state.ancestors(&node.id).iter().any(|id| {
            state
                .nodes
                .get(id)
                .is_some_and(|node| node.node.name.starts_with('.'))
        })
    {
        return false;
    }
    if filter
        .name_contains
        .as_ref()
        .is_some_and(|value| !fold(&node.name).contains(&fold(value)))
    {
        return false;
    }
    if node.kind == NodeKind::File
        && !filter.extensions.is_empty()
        && !filter
            .extensions
            .iter()
            .any(|extension| fold(&node.name).ends_with(&format!(".{extension}")))
    {
        return false;
    }
    if filter.size.as_ref().is_some_and(|bounds| {
        bounds.min.is_some_and(|min| node.size < min)
            || bounds.max.is_some_and(|max| node.size > max)
    }) {
        return false;
    }
    for (time, bounds) in [
        (node.created_at, &filter.created_at),
        (node.modified_at, &filter.modified_at),
    ] {
        if bounds.as_ref().is_some_and(|bounds| {
            bounds.from.is_some_and(|from| time < from) || bounds.to.is_some_and(|to| time > to)
        }) {
            return false;
        }
    }
    true
}
pub(crate) fn compare(a: &FileNode, b: &FileNode, sort: NodeSort, order: SortOrder) -> Ordering {
    let ordering = match sort {
        NodeSort::Name => fold(&a.name)
            .cmp(&fold(&b.name))
            .then_with(|| a.name.as_bytes().cmp(b.name.as_bytes())),
        NodeSort::Size => a.size.cmp(&b.size),
        NodeSort::CreatedAt => a.created_at.cmp(&b.created_at),
        NodeSort::ModifiedAt => a.modified_at.cmp(&b.modified_at),
        NodeSort::Id => Ordering::Equal,
    }
    .then_with(|| {
        a.id.parse::<u64>()
            .unwrap()
            .cmp(&b.id.parse::<u64>().unwrap())
    });
    if order == SortOrder::Desc {
        ordering.reverse()
    } else {
        ordering
    }
}
fn binding<T: serde::Serialize>(request: &T) -> Result<Value> {
    let mut value = serde_json::to_value(request).map_err(Error::from)?;
    value.as_object_mut().unwrap().remove("cursor");
    Ok(value)
}

#[derive(Clone)]
pub(crate) struct CachedQuery {
    binding: Value,
    scope: String,
    generation: String,
    ids: Arc<[String]>,
}

/// 缓存当前树版本的排序 ID，不缓存跨请求快照；节点变更入口会清空，授权/安装修订仍逐请求绑定。
fn sorted_ids(
    state: &mut State,
    kind: &str,
    query: &Value,
    sort: NodeSort,
    order: SortOrder,
    select: impl FnOnce(&State) -> Vec<String>,
) -> Arc<[String]> {
    let key = serde_json::json!([kind, query]);
    if let Some(position) = state.query_cache.iter().position(|cached| {
        cached.binding == key
            && cached.scope == state.scope_revision
            && cached.generation == state.config.app.generation
    }) {
        let cached = state.query_cache.remove(position).unwrap();
        let ids = cached.ids.clone();
        state.query_cache.push_back(cached);
        return ids;
    }
    let mut ids = select(state);
    ids.sort_unstable_by(|left, right| {
        compare(
            &state.nodes[left].node,
            &state.nodes[right].node,
            sort,
            order,
        )
    });
    let ids: Arc<[String]> = ids.into();
    state.query_cache.push_back(CachedQuery {
        binding: key,
        scope: state.scope_revision.clone(),
        generation: state.config.app.generation.clone(),
        ids: ids.clone(),
    });
    while state.query_cache.len() > 8 {
        state.query_cache.pop_front();
    }
    ids
}

fn page(
    state: &mut State,
    ids: Arc<[String]>,
    binding: Value,
    sort: NodeSort,
    order: SortOrder,
    limit: u16,
    cursor: Option<String>,
) -> Result<FilePage> {
    let mut last = None;
    let scan = if let Some(cursor) = cursor {
        match state.cursors.get(&cursor) {
            Some(CursorState::Page { scope, .. }) if scope != &state.scope_revision => {
                return Err(Error::api(error_code::SCOPE_CHANGED, "目录授权已经变化"));
            }
            Some(CursorState::Page { expires, .. }) if *expires <= state.now => {
                return Err(Error::api(error_code::CURSOR_EXPIRED, "分页游标已过期"));
            }
            Some(CursorState::Page {
                binding: previous,
                last: node,
                scan,
                ..
            }) if *previous == binding => {
                last = Some(node.clone());
                scan.clone()
            }
            _ => {
                return Err(Error::api(
                    error_code::INVALID_CURSOR,
                    "游标与查询参数不匹配",
                ));
            }
        }
    } else {
        state.checkpoint(state.change_sequence, None)
    };
    // 游标的最后键可能已移动/删除，按当前排序 ID 二分寻址；只物化本页候选，避免每页克隆整库长路径。
    let start = last.as_ref().map_or(0, |last| {
        ids.partition_point(|id| {
            compare(&state.nodes[id].node, last, sort, order) != Ordering::Greater
        })
    });
    let mut items = ids
        .iter()
        .skip(start)
        .take(usize::from(limit) + 1)
        .map(|id| state.nodes[id].node.clone())
        .collect::<Vec<_>>();
    let count = json_page_prefix_count(&items, usize::from(limit), MAX_JSON_PAGE_BYTES)?;
    let more = start + count < ids.len();
    items.truncate(count);
    let next_cursor = if more {
        let id = state.id("cursor");
        state.cursors.insert(
            id.clone(),
            CursorState::Page {
                binding,
                scope: state.scope_revision.clone(),
                expires: state.now + PAGE_CURSOR_SECONDS as i64 * 1000,
                last: Box::new(items.last().unwrap().clone()),
                scan: scan.clone(),
            },
        );
        Some(id)
    } else {
        None
    };
    Ok(FilePage {
        items,
        next_cursor,
        scan_cursor: scan,
        scope_revision: state.scope_revision.clone(),
    })
}

pub(crate) fn query(state: &mut State, request: FileQuery) -> Result<FilePage> {
    validate_file_query(&request)?;
    let roots = roots(state, &request.roots)?;
    let query = binding(&request)?;
    let ids = sorted_ids(
        state,
        "query",
        &query,
        request.sort,
        request.order,
        |state| {
            state
                .nodes
                .values()
                .filter(|node| {
                    node.visible
                        && in_roots(state, &node.node, &roots, request.recursive, false)
                        && matches_filter(state, &node.node, &request.filter)
                })
                .map(|node| node.node.id.clone())
                .collect()
        },
    );
    page(
        state,
        ids,
        query,
        request.sort,
        request.order,
        request.limit,
        request.cursor,
    )
}
pub(crate) fn list(state: &mut State, request: ListDirectoryRequest) -> Result<DirectoryPage> {
    let directory = stat(state, request.directory.clone())?;
    state.directory(&directory.id, false)?;
    validate_file_query(&FileQuery {
        roots: vec![directory.id.clone()],
        recursive: false,
        filter: FileFilter::default(),
        sort: request.sort,
        order: request.order,
        limit: request.limit,
        cursor: request.cursor.clone(),
    })?;
    let query = binding(&request)?;
    let ids = sorted_ids(
        state,
        "list",
        &query,
        request.sort,
        request.order,
        |state| {
            state
                .nodes
                .values()
                .filter(|node| {
                    node.visible
                        && node.node.parent_id.as_ref() == Some(&directory.id)
                        && state.read_node(&node.node.id).is_ok()
                })
                .map(|node| node.node.id.clone())
                .collect()
        },
    );
    let page = page(
        state,
        ids,
        query,
        request.sort,
        request.order,
        request.limit,
        request.cursor,
    )?;
    Ok(DirectoryPage {
        directory,
        items: page.items,
        next_cursor: page.next_cursor,
        scan_cursor: page.scan_cursor,
        scope_revision: page.scope_revision,
    })
}
pub(crate) fn directories(
    state: &mut State,
    request: DirectoriesWithFilesQuery,
) -> Result<FilePage> {
    validate_directories_query(&request)?;
    let roots = roots(state, &request.roots)?;
    let sort = match request.sort {
        DirectorySort::Name => NodeSort::Name,
        DirectorySort::CreatedAt => NodeSort::CreatedAt,
        DirectorySort::ModifiedAt => NodeSort::ModifiedAt,
        DirectorySort::Id => NodeSort::Id,
    };
    let query = binding(&request)?;
    let ids = sorted_ids(state, "directories", &query, sort, request.order, |state| {
        // 一次收集直属命中的父目录，不为每个目录再扫描整树的所有文件。
        let parents = state
            .nodes
            .values()
            .filter(|file| {
                file.visible
                    && file.node.kind == NodeKind::File
                    && state.read_node(&file.node.id).is_ok()
                    && matches_filter(state, &file.node, &request.file_filter)
            })
            .filter_map(|file| file.node.parent_id.clone())
            .collect::<BTreeSet<_>>();
        parents
            .into_iter()
            .filter(|id| {
                let stored = &state.nodes[id];
                let node = &stored.node;
                stored.visible
                    && node.kind == NodeKind::Directory
                    && in_roots(state, node, &roots, true, true)
                    && request
                        .directory_name_contains
                        .as_ref()
                        .is_none_or(|value| fold(&node.name).contains(&fold(value)))
            })
            .collect()
    });
    page(
        state,
        ids,
        query,
        sort,
        request.order,
        request.limit,
        request.cursor,
    )
}
pub(crate) fn random(
    state: &mut State,
    request: RandomFilesRequest,
) -> Result<RandomFilesResponse> {
    validate_random_request(&request)?;
    let roots = roots(state, &request.roots)?;
    let mut items = state
        .nodes
        .values()
        .filter(|node| {
            node.visible
                && !request.exclude_ids.contains(&node.node.id)
                && in_roots(state, &node.node, &roots, true, false)
                && matches_filter(state, &node.node, &request.filter)
        })
        .map(|node| node.node.clone())
        .collect::<Vec<_>>();
    // 内存替身模拟索引环顺序，覆盖全匹配范围；不局限于普通查询的第一页。
    let pivot = state.sequence.wrapping_mul(0x9e3779b97f4a7c15);
    items.sort_by_key(|node| {
        node.id
            .parse::<u64>()
            .unwrap()
            .wrapping_mul(0x517cc1b727220a95)
            .wrapping_sub(pivot)
    });
    state.sequence += 1;
    items.truncate(usize::from(request.limit));
    Ok(RandomFilesResponse {
        items,
        scope_revision: state.scope_revision.clone(),
    })
}
pub(crate) fn changes(state: &mut State, request: FileChangesRequest) -> Result<FileChangesPage> {
    validate_file_query(&FileQuery {
        roots: Vec::new(),
        recursive: true,
        filter: FileFilter::default(),
        sort: NodeSort::Id,
        order: SortOrder::Asc,
        limit: request.limit,
        cursor: request.cursor.clone(),
    })?;
    if !state.config.files.read || matches!(state.config.scope, DirectoryScope::None) {
        return Err(Error::api(error_code::SCOPE_DENIED, "没有文件读取授权"));
    }
    let Some(cursor) = request.cursor else {
        let next = state.checkpoint(state.change_sequence, None);
        return Ok(FileChangesPage {
            changes: Vec::new(),
            next_cursor: next,
            has_more: false,
            reset_required: true,
            scope_revision: state.scope_revision.clone(),
        });
    };
    let (position, high_water) = match state.cursors.get(&cursor) {
        Some(CursorState::Changes { scope, .. }) if scope != &state.scope_revision => {
            return Err(Error::api(error_code::SCOPE_CHANGED, "目录授权已经变化"));
        }
        Some(CursorState::Changes {
            position,
            high_water,
            ..
        }) => (*position, high_water.unwrap_or(state.change_sequence)),
        _ => return Err(Error::api(error_code::INVALID_CURSOR, "变更游标无效")),
    };
    let oldest = state
        .changes
        .iter()
        .find(|change| change.timestamp >= state.now - FILE_CHANGE_RETENTION_SECONDS as i64 * 1000)
        .map(|change| change.sequence)
        .unwrap_or(state.change_sequence + 1);
    if position + 1 < oldest {
        return Err(Error::api(error_code::CURSOR_EXPIRED, "变更日志已经过期"));
    }
    let mut changes = Vec::new();
    let mut positions = Vec::new();
    let mut inspected = position;
    for change in state
        .changes
        .iter()
        .filter(|change| change.sequence > position && change.sequence <= high_water)
    {
        if changes.len() == usize::from(request.limit) {
            break;
        }
        inspected = change.sequence;
        let old_access =
            change.old.as_ref().is_some() && state.access_chain(&change.old_ancestors).is_some();
        let new_access =
            change.new.as_ref().is_some() && state.access_chain(&change.new_ancestors).is_some();
        if !old_access && !new_access {
            continue;
        }
        let before = changes.len();
        if change.subtree {
            let id = change
                .old
                .as_ref()
                .or(change.new.as_ref())
                .unwrap()
                .id
                .clone();
            changes.push(FileChange::SubtreeInvalidated {
                id,
                previous_path: old_access.then(|| change.old.as_ref().unwrap().path.clone()),
                current: if new_access {
                    change
                        .new
                        .as_ref()
                        .and_then(|node| state.read_node(&node.id).ok())
                        .map(|node| node.node.clone())
                } else {
                    None
                },
            });
        } else if let Some(node) = change
            .new
            .as_ref()
            .filter(|_| new_access)
            .and_then(|node| state.read_node(&node.id).ok())
        {
            changes.push(FileChange::Upsert {
                node: node.node.clone(),
            });
        } else if old_access {
            changes.push(FileChange::Removed {
                id: change.old.as_ref().unwrap().id.clone(),
            });
        }
        if changes.len() > before {
            positions.push(change.sequence);
        }
    }
    let count = json_page_prefix_count(&changes, usize::from(request.limit), MAX_JSON_PAGE_BYTES)?;
    if count < changes.len() {
        inspected = positions[count - 1];
        changes.truncate(count);
    }
    let has_more = inspected < high_water;
    let next_cursor = state.checkpoint(inspected, has_more.then_some(high_water));
    Ok(FileChangesPage {
        changes,
        next_cursor,
        has_more,
        reset_required: false,
        scope_revision: state.scope_revision.clone(),
    })
}
