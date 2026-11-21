use crate::state::{CacheObject, CursorState, State, Ticket, TicketKind};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::collections::BTreeSet;
use tgdrive_backend_sdk::{
    Error, ReadOptions, Result,
    http::{HeaderMap, StatusCode},
};
use tgdrive_contract::{
    ByteCount, Timestamp, data::*, error_code, events::event_name, files::*, http::*,
    runtime::RuntimeCaller, validation::*,
};

pub(crate) fn kv_get(state: &State, key: &str) -> Result<KvGetResponse> {
    key_valid(key)?;
    Ok(KvGetResponse {
        record: state.kv.get(key).cloned(),
    })
}
pub(crate) fn key_valid(key: &str) -> Result<()> {
    if valid_kv_key(key) {
        Ok(())
    } else {
        Err(Error::api(error_code::INVALID_REQUEST, "键无效"))
    }
}
pub(crate) fn kv_put(state: &mut State, key: String, request: KvPutRequest) -> Result<KvRecord> {
    key_valid(&key)?;
    let bytes = serde_json::to_vec(&request.value)?;
    parse_unique_json(&bytes)?;
    if bytes.len() as u64 > MAX_KV_VALUE_BYTES {
        return Err(Error::api(error_code::PAYLOAD_TOO_LARGE, "KV 单值过大"));
    }
    let old = state.kv.get(&key);
    let matches = match &request.condition {
        KvCondition::Absent => old.is_none(),
        KvCondition::Revision { revision } => {
            valid_opaque_id(revision) && old.is_some_and(|record| record.revision == *revision)
        }
    };
    if !matches {
        return Err(Error::api(error_code::STORAGE_CONFLICT, "KV 修订不匹配"));
    }
    let old_size = old
        .map(|record| key.len() + serde_json::to_vec(&record.value).unwrap().len())
        .unwrap_or(0);
    let usage = state.kv_bytes;
    if usage - old_size as u64 + (key.len() + bytes.len()) as u64 > DEFAULT_KV_BYTES
        || old.is_none() && state.kv.len() >= DEFAULT_KV_ENTRIES as usize
    {
        return Err(Error::api(error_code::QUOTA_EXCEEDED, "KV 配额不足"));
    }
    let revision = state.id("kv");
    let record = KvRecord {
        key: key.clone(),
        value: request.value,
        revision,
        updated_at: Timestamp(state.now),
    };
    state.kv.insert(key.clone(), record.clone());
    state.kv_bytes = usage - old_size as u64 + (key.len() + bytes.len()) as u64;
    state.emit(
        event_name::KV_CHANGED,
        serde_json::json!({"key":key,"revision":record.revision}),
    );
    Ok(record)
}
pub(crate) fn kv_delete(state: &mut State, key: &str, request: KvDeleteRequest) -> Result<()> {
    key_valid(key)?;
    if !valid_opaque_id(&request.revision)
        || state
            .kv
            .get(key)
            .is_none_or(|record| record.revision != request.revision)
    {
        return Err(Error::api(error_code::STORAGE_CONFLICT, "删除条件不匹配"));
    }
    let record = state.kv.remove(key).unwrap();
    state.kv_bytes -= (key.len() + serde_json::to_vec(&record.value)?.len()) as u64;
    state.emit(
        event_name::KV_CHANGED,
        serde_json::json!({"key":key,"revision":null}),
    );
    Ok(())
}
pub(crate) fn kv_list(state: &mut State, request: KvListRequest) -> Result<KvPage> {
    if !request.prefix.is_empty() && !valid_kv_key(&request.prefix)
        || request.limit == 0
        || u64::from(request.limit) > MAX_KV_PAGE_LIMIT
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "KV 列表参数无效"));
    }
    let last = if let Some(cursor) = request.cursor {
        match state.cursors.get(&cursor) {
            Some(CursorState::Kv { expires, .. }) if *expires <= state.now => {
                return Err(Error::api(error_code::CURSOR_EXPIRED, "KV 游标已过期"));
            }
            Some(CursorState::Kv {
                prefix,
                limit,
                last,
                ..
            }) if *prefix == request.prefix && *limit == request.limit => Some(last.clone()),
            _ => return Err(Error::api(error_code::INVALID_CURSOR, "KV 游标参数不匹配")),
        }
    } else {
        None
    };
    let start = last
        .map(std::ops::Bound::Excluded)
        .unwrap_or_else(|| std::ops::Bound::Included(request.prefix.clone()));
    let mut records = state
        .kv
        .range((start, std::ops::Bound::Unbounded))
        .take_while(|(key, _)| key.starts_with(&request.prefix))
        .take(usize::from(request.limit) + 1)
        .map(|(_, record)| record.clone())
        .collect::<Vec<_>>();
    let count = json_page_prefix_count(&records, usize::from(request.limit), MAX_JSON_PAGE_BYTES)?;
    let more = records.len() > count;
    records.truncate(count);
    let next_cursor = if more {
        let id = state.id("cursor");
        state.cursors.insert(
            id.clone(),
            CursorState::Kv {
                prefix: request.prefix,
                limit: request.limit,
                expires: state.now + PAGE_CURSOR_SECONDS as i64 * 1000,
                last: records.last().unwrap().key.clone(),
            },
        );
        Some(id)
    } else {
        None
    };
    Ok(KvPage {
        records,
        next_cursor,
    })
}
fn kv_bytes(state: &State) -> u64 {
    state.kv_bytes
}
pub(crate) fn usage(state: &State, caller: RuntimeCaller) -> DataUsage {
    let limits = state.limits(caller);
    DataUsage {
        kv_entries: state.kv.len() as u32,
        kv_bytes: ByteCount(kv_bytes(state)),
        kv_entry_limit: limits.kv_entry_limit,
        kv_byte_limit: limits.kv_byte_limit,
        cache_bytes: ByteCount(state.cache.values().map(|object| object.entry.size.0).sum()),
        cache_byte_limit: limits.cache_byte_limit,
        database_bytes: limits.backend.as_ref().map(|_| ByteCount(0)),
        database_byte_limit: limits.backend.map(|limits| limits.database_bytes),
    }
}

pub(crate) fn cache_metadata(
    state: &State,
    metadata: &CachePutMetadata,
    content_type: &str,
) -> Result<()> {
    if !valid_content_type(content_type)
        || metadata.sources.len() > MAX_CACHE_SOURCES as usize
        || serde_json::to_vec(&metadata.metadata)?.len() as u64 > MAX_CACHE_METADATA_BYTES
    {
        return Err(Error::api(
            error_code::INVALID_REQUEST,
            "缓存内容类型或元数据无效",
        ));
    }
    parse_unique_json(&serde_json::to_vec(metadata)?)?;
    for source in &metadata.sources {
        state.content(source)?;
    }
    Ok(())
}
pub(crate) fn cache_put(
    state: &mut State,
    key: String,
    bytes: Vec<u8>,
    content_type: String,
    metadata: CachePutMetadata,
) -> Result<CacheEntry> {
    key_valid(&key)?;
    cache_metadata(state, &metadata, &content_type)?;
    if bytes.len() as u64 > MAX_CACHE_OBJECT_BYTES {
        return Err(Error::api(error_code::PAYLOAD_TOO_LARGE, "缓存对象过大"));
    }
    let revision = state.id("cache");
    let entry = CacheEntry {
        key: key.clone(),
        content_type,
        size: ByteCount(bytes.len() as u64),
        revision,
        metadata: metadata.metadata,
        updated_at: Timestamp(state.now),
    };
    validate_cache_entry_header(&entry)?;
    let quota = state.limits(state.config.caller).cache_byte_limit.0;
    if entry.size.0 > quota {
        return Err(Error::api(error_code::QUOTA_EXCEEDED, "缓存配额不足"));
    }
    state.cache.insert(
        key.clone(),
        CacheObject {
            entry: entry.clone(),
            bytes,
            sources: metadata.sources,
            accessed: state.sequence,
        },
    );
    if state
        .cache
        .values()
        .map(|object| object.entry.size.0)
        .sum::<u64>()
        > quota
    {
        let target = quota * 9 / 10;
        while state
            .cache
            .values()
            .map(|object| object.entry.size.0)
            .sum::<u64>()
            > target
        {
            let victim = state
                .cache
                .iter()
                .filter(|(other, _)| **other != key)
                .min_by_key(|(_, object)| object.accessed)
                .map(|(key, _)| key.clone());
            if let Some(victim) = victim {
                state.cache.remove(&victim);
            } else {
                break;
            }
        }
    }
    Ok(entry)
}
pub(crate) fn cache_hit(state: &mut State, key: &str) -> Result<CacheObject> {
    key_valid(key)?;
    let object = state
        .cache
        .get(key)
        .cloned()
        .ok_or_else(|| Error::api(error_code::NOT_FOUND, "缓存未命中"))?;
    if object
        .sources
        .iter()
        .any(|source| state.content(source).is_err())
    {
        state.cache.remove(key);
        return Err(Error::api(error_code::NOT_FOUND, "缓存源已失效"));
    }
    let accessed = state.sequence + 1;
    state.sequence = accessed;
    state.cache.get_mut(key).unwrap().accessed = accessed;
    Ok(object)
}
pub(crate) fn cache_lookup(
    state: &mut State,
    request: CacheLookupRequest,
    expiry: Option<i64>,
    creator: &str,
    backend_run_id: Option<&str>,
) -> Result<CacheLookupResponse> {
    let mut seen = BTreeSet::new();
    if request.keys.is_empty()
        || request.keys.len() > MAX_CACHE_LOOKUP_KEYS as usize
        || request
            .keys
            .iter()
            .any(|key| !valid_kv_key(key) || !seen.insert(key))
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "缓存查询键无效"));
    }
    let mut hits = Vec::new();
    for key in request.keys {
        if let Ok(object) = cache_hit(state, &key) {
            let expires =
                (state.now + CACHE_TICKET_SECONDS as i64 * 1000).min(expiry.unwrap_or(i64::MAX));
            let id = state.id("ticket");
            state.tickets.insert(
                id.clone(),
                Ticket {
                    expires,
                    lease: None,
                    kind: TicketKind::Cache(key, object.entry.revision.clone()),
                    generation: state.config.app.generation.clone(),
                    creator: creator.into(),
                    backend_run_id: backend_run_id.map(str::to_owned),
                },
            );
            hits.push(CacheHit {
                entry: object.entry,
                url: ticket_path("cache.ticket", &id),
                expires_at: Timestamp(expires),
            });
        }
    }
    Ok(CacheLookupResponse { hits })
}
fn ticket_path(name: &str, id: &str) -> String {
    ENDPOINTS
        .iter()
        .find(|endpoint| endpoint.name == name)
        .unwrap()
        .path
        .replace("{ticket}", id)
}
pub(crate) fn lease(state: &State, id: &str) -> Result<()> {
    if state
        .leases
        .get(id)
        .is_none_or(|lease| lease.expires_at.0 <= state.now)
    {
        return Err(Error::api(
            error_code::LEASE_EXPIRED,
            "读取租约已撤销或过期",
        ));
    }
    Ok(())
}
pub(crate) fn create_lease(
    state: &mut State,
    request: CreateReadLeaseRequest,
    creator: &str,
) -> Result<ReadLease> {
    if !state.config.files.read || matches!(state.config.scope, DirectoryScope::None) {
        return Err(Error::api(error_code::SCOPE_DENIED, "没有文件读取授权"));
    }
    if request.ttl_seconds == 0 || u64::from(request.ttl_seconds) > MAX_READ_LEASE_SECONDS {
        return Err(Error::api(error_code::INVALID_REQUEST, "租约 TTL 无效"));
    }
    state
        .leases
        .retain(|_, lease| lease.expires_at.0 > state.now);
    if state.leases.len() >= MAX_READ_LEASES as usize {
        return Err(Error::api(error_code::QUOTA_EXCEEDED, "读取租约已达上限"));
    }
    let id = state.id("lease");
    let lease = ReadLease {
        id: id.clone(),
        expires_at: Timestamp(state.now + i64::from(request.ttl_seconds) * 1000),
    };
    state.lease_creators.insert(id.clone(), creator.into());
    state.leases.insert(id, lease.clone());
    Ok(lease)
}
pub(crate) fn renew_lease(
    state: &mut State,
    id: String,
    request: CreateReadLeaseRequest,
) -> Result<ReadLease> {
    if !state.leases.contains_key(&id) {
        return Err(Error::api(error_code::NOT_FOUND, "租约不存在"));
    }
    lease(state, &id)?;
    if !state.config.files.read || matches!(state.config.scope, DirectoryScope::None) {
        return Err(Error::api(error_code::SCOPE_DENIED, "没有文件读取授权"));
    }
    if request.ttl_seconds == 0 || u64::from(request.ttl_seconds) > MAX_READ_LEASE_SECONDS {
        return Err(Error::api(error_code::INVALID_REQUEST, "租约 TTL 无效"));
    }
    let value = state.leases.get_mut(&id).unwrap();
    value.expires_at = Timestamp(state.now + i64::from(request.ttl_seconds) * 1000);
    Ok(value.clone())
}
pub(crate) fn media_url(
    state: &mut State,
    request: MediaUrlRequest,
    expiry: Option<i64>,
    creator: &str,
    backend_run_id: Option<&str>,
) -> Result<MediaUrl> {
    let node = state.content(&request.file)?;
    if request.representation == FileRepresentation::Thumbnail && node.thumbnail.is_none() {
        return Err(Error::api(error_code::NOT_FOUND, "原文件没有附带缩略图"));
    }
    if request
        .filename
        .as_ref()
        .is_some_and(|name| !valid_drive_name(name))
        || request
            .content_type
            .as_ref()
            .is_some_and(|mime| !valid_content_type(mime))
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "媒体显示头无效"));
    }
    let ttl = request
        .ttl_seconds
        .map(u64::from)
        .unwrap_or(DEFAULT_MEDIA_TICKET_SECONDS);
    if ttl == 0 || ttl > MAX_MEDIA_TICKET_SECONDS {
        return Err(Error::api(error_code::INVALID_REQUEST, "媒体票据 TTL 无效"));
    }
    state.tickets.retain(|_, ticket| ticket.expires > state.now);
    if state.tickets.len() >= MAX_MEDIA_TICKETS as usize {
        return Err(Error::api(error_code::QUOTA_EXCEEDED, "媒体票据已达上限"));
    }
    let mut expires = (state.now + ttl as i64 * 1000).min(expiry.unwrap_or(i64::MAX));
    if let Some(id) = &request.lease_id {
        lease(state, id)?;
        expires = expires.min(state.leases[id].expires_at.0);
    }
    let id = state.id("ticket");
    state.tickets.insert(
        id.clone(),
        Ticket {
            expires,
            lease: request.lease_id,
            kind: TicketKind::Media(request.file.clone(), request.representation),
            generation: state.config.app.generation.clone(),
            creator: creator.into(),
            backend_run_id: backend_run_id.map(str::to_owned),
        },
    );
    Ok(MediaUrl {
        url: ticket_path("media.ticket", &id),
        expires_at: Timestamp(expires),
        file: request.file,
        representation: request.representation,
    })
}
pub(crate) fn local_url(
    state: &mut State,
    request: LocalFileUrlRequest,
    creator: &str,
) -> Result<LocalFileUrl> {
    state.content(&request.file)?;
    let ttl = request
        .ttl_seconds
        .map(u64::from)
        .unwrap_or(DEFAULT_LOCAL_TICKET_SECONDS);
    let bytes = request
        .byte_budget
        .map(|bytes| bytes.0)
        .unwrap_or(DEFAULT_LOCAL_BYTE_BUDGET);
    let requests = request
        .request_budget
        .map(u64::from)
        .unwrap_or(DEFAULT_LOCAL_REQUEST_BUDGET);
    if ttl == 0
        || ttl > MAX_LOCAL_TICKET_SECONDS
        || bytes == 0
        || bytes > MAX_LOCAL_BYTE_BUDGET
        || requests == 0
        || requests > MAX_LOCAL_REQUEST_BUDGET
    {
        return Err(Error::api(error_code::INVALID_REQUEST, "本机读取预算无效"));
    }
    let mut expires = state.now + ttl as i64 * 1000;
    if let Some(id) = &request.lease_id {
        lease(state, id)?;
        expires = expires.min(state.leases[id].expires_at.0);
    }
    let id = state.id("local");
    state.tickets.insert(
        id.clone(),
        Ticket {
            expires,
            lease: request.lease_id,
            kind: TicketKind::Local(request.file, bytes, requests as u16),
            generation: state.config.app.generation.clone(),
            creator: creator.into(),
            backend_run_id: Some(state.run_id.clone()),
        },
    );
    Ok(LocalFileUrl {
        id: id.clone(),
        url: format!("http://127.0.0.1:1{}", ticket_path("local.ticket", &id)),
        expires_at: Timestamp(expires),
        byte_budget: ByteCount(bytes),
        request_budget: requests as u16,
    })
}

pub(crate) enum Source {
    File(ContentRef, FileRepresentation),
    Cache(String, String),
    Empty,
}
pub(crate) struct Plan {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub source: Source,
    pub offset: u64,
    pub length: u64,
    pub lease: Option<String>,
    pub ticket: Option<String>,
    pub local_reserved: u64,
}

pub(crate) struct ReadBinding {
    pub ticket: Option<String>,
    pub remaining: u64,
}
pub(crate) fn charge_local(state: &mut State, id: &str, bytes: u64) -> Result<()> {
    let ticket = state
        .tickets
        .get_mut(id)
        .ok_or_else(|| Error::api(error_code::TICKET_EXPIRED, "票据已撤销"))?;
    if let TicketKind::Local(_, budget, _) = &mut ticket.kind {
        *budget = budget.checked_sub(bytes).ok_or_else(|| {
            Error::api(error_code::QUOTA_EXCEEDED, "本机读取的共享字节预算已耗尽")
        })?;
    }
    Ok(())
}
pub(crate) fn live_ticket(state: &State, id: &str) -> Result<()> {
    let ticket = state
        .tickets
        .get(id)
        .ok_or_else(|| Error::api(error_code::TICKET_EXPIRED, "票据已撤销"))?;
    if ticket.expires <= state.now || ticket.generation != state.config.app.generation {
        return Err(Error::api(error_code::TICKET_EXPIRED, "票据已过期"));
    }
    if let Some(id) = &ticket.lease {
        lease(state, id)?;
    }
    Ok(())
}
fn etag_matches(value: &str, current: &str) -> bool {
    value.split(',').any(|value| {
        let value = value.trim().strip_prefix("W/").unwrap_or(value.trim());
        value == "*" || value == current
    })
}
pub(crate) fn plan(source: Source, size: u64, etag: String, options: &ReadOptions) -> Result<Plan> {
    let mut headers = HeaderMap::new();
    headers.insert("ETag", etag.parse().unwrap());
    headers.insert("Accept-Ranges", "bytes".parse().unwrap());
    headers.insert("Content-Type", "application/octet-stream".parse().unwrap());
    if options
        .if_none_match
        .as_ref()
        .is_some_and(|value| etag_matches(value, &etag))
    {
        return Ok(Plan {
            status: StatusCode::NOT_MODIFIED,
            headers,
            source: Source::Empty,
            offset: 0,
            length: 0,
            lease: None,
            ticket: None,
            local_reserved: 0,
        });
    }
    let requested = if options
        .if_range
        .as_ref()
        .is_some_and(|value| value != &etag)
    {
        None
    } else {
        options.range.as_deref()
    };
    let range = resolve_single_range(requested, size)?;
    headers.insert("Content-Length", range.length.to_string().parse().unwrap());
    if range.partial {
        headers.insert(
            "Content-Range",
            format!(
                "bytes {}-{}/{size}",
                range.start,
                range.start + range.length - 1
            )
            .parse()
            .unwrap(),
        );
    }
    Ok(Plan {
        status: if range.partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        headers,
        source: if options.head { Source::Empty } else { source },
        offset: range.start,
        length: if options.head { 0 } else { range.length },
        lease: None,
        ticket: None,
        local_reserved: 0,
    })
}
pub(crate) fn file_plan(
    state: &State,
    file: ContentRef,
    representation: FileRepresentation,
    options: ReadOptions,
) -> Result<Plan> {
    let node = state.content(&file)?;
    let (size, etag) = if representation == FileRepresentation::Original {
        (node.node.size.0, format!("\"v{}\"", file.content_version))
    } else {
        (
            node.thumbnail
                .as_ref()
                .ok_or_else(|| Error::api(error_code::NOT_FOUND, "没有附带缩略图"))?
                .len() as u64,
            format!("\"t{}\"", file.content_version),
        )
    };
    plan(Source::File(file, representation), size, etag, &options)
}
pub(crate) fn cache_plan(state: &mut State, key: String, mut options: ReadOptions) -> Result<Plan> {
    let object = cache_hit(state, &key)?;
    options.range = None;
    let mut plan = plan(
        Source::Cache(key, object.entry.revision.clone()),
        object.entry.size.0,
        format!("\"c{}\"", object.entry.revision),
        &options,
    )?;
    plan.headers
        .insert("Content-Type", object.entry.content_type.parse().unwrap());
    plan.headers.insert(
        CACHE_METADATA_HEADER,
        URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&object.entry)?)
            .parse()
            .unwrap(),
    );
    Ok(plan)
}
pub(crate) fn ticket_plan(state: &mut State, url: &str, options: ReadOptions) -> Result<Plan> {
    let uri: tgdrive_backend_sdk::http::Uri = url
        .parse()
        .map_err(|_| Error::api(error_code::NOT_FOUND, "票据不存在"))?;
    let id = uri.path().rsplit('/').next().unwrap_or_default();
    let ticket = state
        .tickets
        .get(id)
        .cloned()
        .ok_or_else(|| Error::api(error_code::TICKET_EXPIRED, "票据不存在或已撤销"))?;
    if ticket.expires <= state.now || ticket.generation != state.config.app.generation {
        return Err(Error::api(error_code::TICKET_EXPIRED, "票据已过期"));
    }
    if let Some(id) = &ticket.lease {
        lease(state, id)?;
    }
    let (name, origin) = match ticket.kind {
        TicketKind::Media(..) => ("media.ticket", ""),
        TicketKind::Cache(..) => ("cache.ticket", ""),
        TicketKind::Local(..) => ("local.ticket", "http://127.0.0.1:1"),
    };
    if url != format!("{origin}{}", ticket_path(name, id)) {
        return Err(Error::api(error_code::NOT_FOUND, "票据地址不匹配"));
    }
    let mut result = match ticket.kind {
        TicketKind::Media(file, representation) => file_plan(state, file, representation, options)?,
        TicketKind::Cache(key, revision) => {
            if state
                .cache
                .get(&key)
                .is_none_or(|object| object.entry.revision != revision)
            {
                return Err(Error::api(error_code::NOT_FOUND, "缓存未命中"));
            }
            cache_plan(state, key, options)?
        }
        TicketKind::Local(file, budget, requests) => {
            if requests == 0 || budget == 0 && !options.head {
                return Err(Error::api(error_code::QUOTA_EXCEEDED, "本机读取预算耗尽"));
            }
            let mut result = file_plan(
                state,
                file.clone(),
                FileRepresentation::Original,
                options.clone(),
            )?;
            let reserved = if options.head {
                0
            } else {
                result.length.min(budget)
            };
            if !options.head && reserved < result.length {
                let size = state
                    .content(match &result.source {
                        Source::File(file, _) => file,
                        _ => unreachable!(),
                    })?
                    .node
                    .size
                    .0;
                result.length = reserved;
                result.status = StatusCode::PARTIAL_CONTENT;
                result
                    .headers
                    .insert("Content-Length", reserved.to_string().parse().unwrap());
                result.headers.insert(
                    "Content-Range",
                    format!(
                        "bytes {}-{}/{size}",
                        result.offset,
                        result.offset + reserved - 1
                    )
                    .parse()
                    .unwrap(),
                );
            }
            state.tickets.get_mut(id).unwrap().kind = TicketKind::Local(file, budget, requests - 1);
            result.local_reserved = reserved;
            result
        }
    };
    result.lease = ticket.lease;
    result.ticket = Some(id.to_owned());
    Ok(result)
}
