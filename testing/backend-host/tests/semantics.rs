use futures_util::StreamExt;
use tgdrive_backend_sdk::{HostClient, ReadOptions, byte_stream, collect_bytes};
use tgdrive_contract::{
    Timestamp,
    data::*,
    error_code,
    events::event_name,
    files::*,
    http::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, BackendKeepaliveRequest, RuntimeCaller},
    validation::resolve_single_range,
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

fn seed(id: &str, parent: &str, name: &str, kind: NodeKind, bytes: Vec<u8>) -> SeedNode {
    SeedNode {
        id: id.into(),
        parent_id: parent.into(),
        name: name.into(),
        kind,
        bytes,
        thumbnail: None,
    }
}
fn host() -> MemoryHost {
    MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "example".into(),
            name: "测试应用".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: true,
            ..Default::default()
        },
        scope: DirectoryScope::Selected {
            directories: vec![
                DirectoryGrant {
                    directory_id: "2".into(),
                    access: AccessLevel::ReadWrite,
                },
                DirectoryGrant {
                    directory_id: "3".into(),
                    access: AccessLevel::ReadOnly,
                },
            ],
        },
        nodes: vec![
            seed("2", "1", "inside", NodeKind::Directory, vec![]),
            seed("3", "2", "nested", NodeKind::Directory, vec![]),
            seed("4", "2", "file.bin", NodeKind::File, (0..10).collect()),
            seed("5", "3", "picture.jpg", NodeKind::File, vec![1, 2]),
            seed("10", "1", "outside", NodeKind::Directory, vec![]),
            seed("11", "10", "hidden.bin", NodeKind::File, vec![99]),
        ],
        caller: RuntimeCaller::Backend,
        now: Timestamp(1),
        has_backend: true,
    })
    .unwrap()
}
async fn file(host: &MemoryHost, id: &str) -> FileNode {
    host.stat(NodeReference::Id {
        id: id.into(),
        content_version: None,
    })
    .await
    .unwrap()
}
fn content(node: &FileNode) -> ContentRef {
    ContentRef {
        id: node.id.clone(),
        content_version: node.content_version.clone().unwrap(),
    }
}
fn query_request(limit: u16) -> FileQuery {
    FileQuery {
        roots: vec![],
        recursive: true,
        filter: FileFilter::default(),
        sort: NodeSort::Id,
        order: SortOrder::Asc,
        limit,
        cursor: None,
    }
}

#[tokio::test]
async fn cache_eviction_line_is_shared_and_database_usage_has_no_limit() {
    for has_backend in [false, true] {
        let host = MemoryHost::new(MemoryConfig {
            app: AppIdentity {
                id: "example".into(),
                name: "测试应用".into(),
                version: "1.0.0".into(),
                generation: "g1".into(),
            },
            files: FilePermissions::default(),
            scope: DirectoryScope::None,
            nodes: vec![],
            caller: RuntimeCaller::Page,
            now: Timestamp(1),
            has_backend,
        })
        .unwrap();
        host.cache_put(
            "shared".into(),
            byte_stream(vec![1, 2]),
            "application/octet-stream".into(),
            CachePutMetadata {
                metadata: serde_json::Value::Null,
                sources: vec![],
            },
        )
        .await
        .unwrap();
        let callers = if has_backend {
            &[RuntimeCaller::Page, RuntimeCaller::Backend][..]
        } else {
            &[RuntimeCaller::Page][..]
        };
        for &caller in callers {
            let client = host.fork(caller);
            let runtime = client.runtime_info().await.unwrap();
            assert_eq!(runtime.limits.cache_byte_limit.0, DEFAULT_CACHE_BYTES);
            let backend = has_backend.then(|| {
                serde_json::json!({
                    "memory_bytes": "0", "cpu_millis": 0,
                    "enforced": { "memory": false, "cpu": false },
                })
            });
            assert_eq!(
                serde_json::to_value(&runtime.limits.backend).unwrap(),
                serde_json::json!(backend)
            );
            assert_eq!(
                serde_json::to_value(client.data_usage().await.unwrap()).unwrap(),
                serde_json::json!({
                    "kv_entries": 0, "kv_bytes": "0",
                    "kv_entry_limit": DEFAULT_KV_ENTRIES,
                    "kv_byte_limit": DEFAULT_KV_BYTES.to_string(),
                    "cache_bytes": "2", "cache_byte_limit": DEFAULT_CACHE_BYTES.to_string(),
                    "database_bytes": has_backend.then_some("0"),
                }),
            );
        }
    }
}

#[tokio::test]
async fn closing_one_page_preserves_other_pages_and_backend_capabilities() {
    let host = host();
    let page = host.fork(RuntimeCaller::Page);
    let other = host.fork(RuntimeCaller::Page);
    let reference = content(&file(&host, "4").await);
    let request = |lease_id| MediaUrlRequest {
        file: reference.clone(),
        representation: FileRepresentation::Original,
        disposition: Disposition::Inline,
        filename: None,
        content_type: None,
        ttl_seconds: None,
        lease_id,
    };
    let page_lease = page
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    let page_url = page.media_url(request(Some(page_lease.id))).await.unwrap();
    let backend_lease = host
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    let backend_url = host
        .media_url(request(Some(backend_lease.id)))
        .await
        .unwrap();
    page.kv_put(
        "shared".into(),
        KvPutRequest {
            value: "保留".into(),
            condition: KvCondition::Absent,
        },
    )
    .await
    .unwrap();
    let mut events = page.events(None).await.unwrap();
    events.next().await.unwrap().unwrap();
    page.close_page_session().unwrap();
    assert_eq!(
        page.scope().await.err().unwrap().code(),
        error_code::SESSION_EXPIRED
    );
    assert_eq!(
        events.next().await.unwrap().err().unwrap().code(),
        error_code::SESSION_EXPIRED
    );
    assert_eq!(
        host.read_ticket(page_url.url, ReadOptions::default())
            .err()
            .unwrap()
            .code(),
        error_code::TICKET_EXPIRED
    );
    assert_eq!(
        host.read_ticket(backend_url.url, ReadOptions::default())
            .unwrap()
            .status,
        200
    );
    assert_eq!(
        other
            .kv_get("shared".into())
            .await
            .unwrap()
            .record
            .unwrap()
            .value,
        serde_json::json!("保留")
    );
    assert_eq!(
        host.close_page_session().err().unwrap().code(),
        error_code::CALLER_NOT_ALLOWED
    );
}

#[tokio::test]
async fn byte_limited_kv_pages_keep_the_next_cursor_even_when_short() {
    let host = host();
    for index in 0..24 {
        host.kv_put(
            format!("large-{index:02}"),
            KvPutRequest {
                value: serde_json::Value::String("a".repeat(MAX_KV_VALUE_BYTES as usize - 2)),
                condition: KvCondition::Absent,
            },
        )
        .await
        .unwrap();
    }
    let mut request = KvListRequest {
        prefix: "large-".into(),
        limit: MAX_KV_PAGE_LIMIT as u16,
        cursor: None,
    };
    let first = host.kv_list(request.clone()).await.unwrap();
    assert!(first.records.len() < usize::from(request.limit));
    assert!(first.next_cursor.is_some());
    tgdrive_contract::validation::validate_json_page(&first.records, MAX_JSON_PAGE_BYTES).unwrap();
    let mut count = first.records.len();
    request.cursor = first.next_cursor;
    while request.cursor.is_some() {
        let page = host.kv_list(request.clone()).await.unwrap();
        count += page.records.len();
        request.cursor = page.next_cursor;
    }
    assert_eq!(count, 24);
}

#[tokio::test]
async fn scope_roots_can_be_trashed_and_restored_with_the_same_identity() {
    let host = host();
    let before = host.scope().await.unwrap().revision;
    host.change_node("2".into(), None, None, None, Some(false))
        .unwrap();
    let trashed = host.scope().await.unwrap();
    assert!(trashed.roots.iter().all(|root| root.node.is_none()));
    assert_ne!(trashed.revision, before);
    host.change_node("2".into(), None, None, None, Some(true))
        .unwrap();
    let restored = host.scope().await.unwrap();
    assert!(restored.roots.iter().all(|root| root.node.is_some()));
    assert_ne!(restored.revision, trashed.revision);
    assert_eq!(file(&host, "4").await.path, "/inside/file.bin");
}

#[tokio::test]
async fn scopes_follow_identity_and_reject_parent_writes() {
    let host = host();
    let before = host.query(query_request(1)).await.unwrap();
    assert_eq!(
        host.stat(NodeReference::Id {
            id: "11".into(),
            content_version: None
        })
        .await
        .err()
        .unwrap()
        .code(),
        error_code::SCOPE_DENIED
    );
    let root = file(&host, "2").await;
    let revision = host.scope().await.unwrap().revision;
    let request = FileMutationRequest {
        scope_revision: revision,
        assertions: vec![],
        operations: vec![FileOperation::Rename {
            operation_id: "rename".into(),
            node: NodeCondition {
                id: root.id,
                revision: root.revision,
            },
            name: "new".into(),
        }],
    };
    assert_eq!(
        host.mutate("scope-parent-test-key".into(), request)
            .await
            .err()
            .unwrap()
            .code(),
        error_code::SCOPE_DENIED
    );
    host.change_node("2".into(), None, Some("renamed".into()), None, None)
        .unwrap();
    assert_eq!(file(&host, "4").await.path, "/renamed/file.bin");
    host.add_node(seed("20", "1", "inside", NodeKind::Directory, vec![]))
        .unwrap();
    host.add_node(seed("21", "20", "new.bin", NodeKind::File, vec![1]))
        .unwrap();
    assert_eq!(
        host.stat(NodeReference::Id {
            id: "21".into(),
            content_version: None
        })
        .await
        .err()
        .unwrap()
        .code(),
        error_code::SCOPE_DENIED
    );
    let mut next = query_request(1);
    next.cursor = before.next_cursor;
    assert_eq!(
        host.query(next).await.err().unwrap().code(),
        error_code::SCOPE_CHANGED
    );
}

#[tokio::test]
async fn pages_use_stable_scan_checkpoint_and_no_hidden_truncation() {
    let host = host();
    for id in 100..2201 {
        host.add_node(seed(
            &id.to_string(),
            "2",
            &format!("file-{id}.bin"),
            NodeKind::File,
            vec![1],
        ))
        .unwrap();
    }
    let mut query = query_request(MAX_PAGE_LIMIT as u16);
    let mut count = 0;
    let mut scan = None;
    loop {
        let page = host.query(query.clone()).await.unwrap();
        count += page.items.len();
        if let Some(scan) = &scan {
            assert_eq!(scan, &page.scan_cursor);
        } else {
            scan = Some(page.scan_cursor);
        }
        if page.next_cursor.is_none() {
            break;
        }
        query.cursor = page.next_cursor;
    }
    assert_eq!(count, 2103);
    let random = host
        .random(RandomFilesRequest {
            roots: vec![],
            filter: FileFilter::default(),
            limit: 64,
            exclude_ids: vec!["4".into()],
        })
        .await
        .unwrap();
    assert_eq!(random.items.len(), 64);
    assert!(
        random
            .items
            .iter()
            .any(|node| node.id.parse::<u64>().unwrap() > 300)
    );
    assert!(random.items.iter().all(|node| node.id != "4"));
    let directories = host
        .directories_with_files(DirectoriesWithFilesQuery {
            roots: vec![],
            file_filter: FileFilter {
                extensions: vec!["jpg".into()],
                ..Default::default()
            },
            directory_name_contains: None,
            sort: DirectorySort::Id,
            order: SortOrder::Asc,
            limit: 200,
            cursor: None,
        })
        .await
        .unwrap();
    assert_eq!(
        directories
            .items
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["3"]
    );
}

#[tokio::test]
async fn changes_advance_over_invisible_changes_and_freeze_high_water() {
    let host = host();
    let initial = host
        .changes(FileChangesRequest {
            cursor: None,
            limit: 1,
        })
        .await
        .unwrap();
    assert!(initial.reset_required);
    host.change_node("11".into(), None, Some("private.bin".into()), None, None)
        .unwrap();
    host.change_node("4".into(), None, Some("a.bin".into()), None, None)
        .unwrap();
    host.change_node("5".into(), None, Some("b.jpg".into()), None, None)
        .unwrap();
    let first = host
        .changes(FileChangesRequest {
            cursor: Some(initial.next_cursor),
            limit: 1,
        })
        .await
        .unwrap();
    assert!(first.has_more);
    assert_eq!(first.changes.len(), 1);
    host.add_node(seed("12", "2", "later.bin", NodeKind::File, vec![1]))
        .unwrap();
    let second = host
        .changes(FileChangesRequest {
            cursor: Some(first.next_cursor),
            limit: 1,
        })
        .await
        .unwrap();
    assert!(!second.has_more);
    assert_eq!(second.changes.len(), 1);
    let third = host
        .changes(FileChangesRequest {
            cursor: Some(second.next_cursor),
            limit: 1,
        })
        .await
        .unwrap();
    assert_eq!(third.changes.len(), 1);
    assert!(
        third
            .changes
            .iter()
            .all(|change| !matches!(change,FileChange::Upsert { node } if node.id=="11"))
    );
}

#[tokio::test]
async fn kv_has_real_cas_null_and_no_aba() {
    let host = host();
    assert!(host.kv_get("key".into()).await.unwrap().record.is_none());
    let record = host
        .kv_put(
            "key".into(),
            KvPutRequest {
                value: serde_json::Value::Null,
                condition: KvCondition::Absent,
            },
        )
        .await
        .unwrap();
    assert!(
        host.kv_get("key".into())
            .await
            .unwrap()
            .record
            .unwrap()
            .value
            .is_null()
    );
    let results = futures_util::future::join(
        host.kv_put(
            "key".into(),
            KvPutRequest {
                value: 1.into(),
                condition: KvCondition::Revision {
                    revision: record.revision.clone(),
                },
            },
        ),
        host.kv_put(
            "key".into(),
            KvPutRequest {
                value: 2.into(),
                condition: KvCondition::Revision {
                    revision: record.revision.clone(),
                },
            },
        ),
    )
    .await;
    assert_ne!(results.0.is_ok(), results.1.is_ok());
    let current = host.kv_get("key".into()).await.unwrap().record.unwrap();
    host.kv_delete(
        "key".into(),
        KvDeleteRequest {
            revision: current.revision,
        },
    )
    .await
    .unwrap();
    let recreated = host
        .kv_put(
            "key".into(),
            KvPutRequest {
                value: 3.into(),
                condition: KvCondition::Absent,
            },
        )
        .await
        .unwrap();
    assert_ne!(record.revision, recreated.revision);
    assert_eq!(
        host.kv_delete(
            "key".into(),
            KvDeleteRequest {
                revision: record.revision
            }
        )
        .await
        .err()
        .unwrap()
        .code(),
        error_code::STORAGE_CONFLICT
    );
}

#[tokio::test]
async fn all_range_forms_head_etag_and_inflight_revocation_use_contract() {
    let host = host();
    let reference = content(&file(&host, "4").await);
    for range in ["bytes=2-4", "bytes=2-", "bytes=-3", "bytes=0-100"] {
        let expected = resolve_single_range(Some(range), 10).unwrap();
        let response = host
            .bytes(
                reference.clone(),
                ReadOptions {
                    range: Some(range.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(
            collect_bytes(response.body, 10).await.unwrap().len() as u64,
            expected.length
        );
    }
    for range in [
        "bytes=0-1,3-4",
        "items=0-1",
        "bytes=5-2",
        "bytes=-0",
        "bytes=10-",
        "bytes=18446744073709551616-",
    ] {
        assert_eq!(
            host.bytes(
                reference.clone(),
                ReadOptions {
                    range: Some(range.into()),
                    ..Default::default()
                }
            )
            .await
            .err()
            .unwrap()
            .code(),
            error_code::RANGE_NOT_SATISFIABLE
        );
    }
    let response = host
        .bytes(
            reference.clone(),
            ReadOptions {
                range: Some("bytes=2-4".into()),
                head: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.status, 206);
    assert!(collect_bytes(response.body, 1).await.unwrap().is_empty());
    let response = host
        .bytes(
            reference.clone(),
            ReadOptions {
                if_none_match: Some(format!("W/\"v{}\"", reference.content_version)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.status, 304);
    let response = host
        .bytes(
            reference.clone(),
            ReadOptions {
                range: Some("bytes=2-4".into()),
                if_range: Some("\"wrong\"".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    host.add_node(seed(
        "30",
        "2",
        "large.bin",
        NodeKind::File,
        vec![1; 150_000],
    ))
    .unwrap();
    let mut body = host
        .bytes(content(&file(&host, "30").await), ReadOptions::default())
        .await
        .unwrap()
        .body;
    assert_eq!(body.next().await.unwrap().unwrap().len(), 64 * 1024);
    host.set_scope(DirectoryScope::None).unwrap();
    assert_eq!(
        body.next().await.unwrap().err().unwrap().code(),
        error_code::SCOPE_DENIED
    );
    assert_eq!(
        host.bytes(
            reference,
            ReadOptions {
                if_none_match: Some("*".into()),
                ..Default::default()
            }
        )
        .await
        .err()
        .unwrap()
        .code(),
        error_code::SCOPE_DENIED
    );
}

#[tokio::test]
async fn mutations_are_atomic_conditional_and_receipts_survive_revocation() {
    let host = host();
    let current = file(&host, "4").await;
    let scope = host.scope().await.unwrap().revision;
    let request = FileMutationRequest {
        scope_revision: scope.clone(),
        assertions: vec![],
        operations: vec![
            FileOperation::Mkdir {
                operation_id: "folder".into(),
                parent: DirectoryTarget::Existing { id: "3".into() },
                name: "created".into(),
            },
            FileOperation::Move {
                operation_id: "move".into(),
                node: NodeCondition {
                    id: current.id.clone(),
                    revision: current.revision.clone(),
                },
                parent: DirectoryTarget::Created {
                    operation_id: "folder".into(),
                },
                name: None,
            },
        ],
    };
    let receipt = host
        .mutate("atomic-operation-key".into(), request.clone())
        .await
        .unwrap();
    assert_eq!(receipt.results.len(), 2);
    assert_eq!(
        host.mutate("atomic-operation-key".into(), request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        file(&host, "4").await.content_version,
        current.content_version
    );
    let revision = host.scope().await.unwrap().revision;
    let current = file(&host, "4").await;
    let bad = FileMutationRequest {
        scope_revision: revision,
        assertions: vec![],
        operations: vec![
            FileOperation::Mkdir {
                operation_id: "folder".into(),
                parent: DirectoryTarget::Existing { id: "3".into() },
                name: "rollback".into(),
            },
            FileOperation::Move {
                operation_id: "bad".into(),
                node: NodeCondition {
                    id: "4".into(),
                    revision: current.revision,
                },
                parent: DirectoryTarget::Created {
                    operation_id: "missing".into(),
                },
                name: None,
            },
        ],
    };
    assert!(
        host.mutate("rollback-operation-key".into(), bad)
            .await
            .is_err()
    );
    assert!(
        host.stat(NodeReference::Path {
            path: "/inside/nested/rollback".into(),
            content_version: None
        })
        .await
        .is_err()
    );
    host.set_scope(DirectoryScope::None).unwrap();
    assert_eq!(
        host.mutation_receipt("atomic-operation-key".into())
            .await
            .unwrap(),
        receipt
    );
}

#[tokio::test]
async fn uploads_stay_invisible_and_revalidate_at_commit() {
    let host = host();
    let scope = host.scope().await.unwrap().revision;
    let upload = host
        .create_upload(
            "upload-create-test-key".into(),
            CreateUploadRequest {
                target: UploadTarget::Create {
                    parent_id: "2".into(),
                    name: "new.bin".into(),
                },
                size: 3.into(),
                sha256: None,
                scope_revision: scope.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        host.stat(NodeReference::Path {
            path: "/inside/new.bin".into(),
            content_version: None
        })
        .await
        .is_err()
    );
    assert_eq!(
        host.upload_body(upload.id.clone(), byte_stream(vec![1, 2, 3]), Some(3))
            .await
            .unwrap()
            .state,
        UploadState::Ready
    );
    assert_eq!(
        host.upload_body(upload.id.clone(), byte_stream(vec![1, 2, 3]), Some(3))
            .await
            .err()
            .unwrap()
            .code(),
        error_code::UPLOAD_STATE
    );
    let receipt = host
        .mutate(
            "upload-commit-test-key".into(),
            FileMutationRequest {
                scope_revision: scope,
                assertions: vec![],
                operations: vec![FileOperation::CommitUpload {
                    operation_id: "commit".into(),
                    upload_id: upload.id.clone(),
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt.results.len(), 1);
    assert_eq!(
        host.upload_status(upload.id).await.unwrap().state,
        UploadState::Committed
    );
    let current = file(&host, "4").await;
    let scope = host.scope().await.unwrap().revision;
    let upload = host
        .create_upload(
            "upload-replace-test-key".into(),
            CreateUploadRequest {
                target: UploadTarget::Replace {
                    node: NodeCondition {
                        id: "4".into(),
                        revision: current.revision,
                    },
                },
                size: 1.into(),
                sha256: None,
                scope_revision: scope.clone(),
            },
        )
        .await
        .unwrap();
    host.upload_body(upload.id.clone(), byte_stream(vec![7]), None)
        .await
        .unwrap();
    host.change_node("4".into(), None, None, Some(vec![8]), None)
        .unwrap();
    assert_eq!(
        host.mutate(
            "upload-conflict-test-key".into(),
            FileMutationRequest {
                scope_revision: scope,
                assertions: vec![],
                operations: vec![FileOperation::CommitUpload {
                    operation_id: "commit".into(),
                    upload_id: upload.id
                }]
            }
        )
        .await
        .err()
        .unwrap()
        .code(),
        error_code::NODE_CHANGED
    );
    assert_eq!(
        collect_bytes(
            host.bytes(content(&file(&host, "4").await), ReadOptions::default())
                .await
                .unwrap()
                .body,
            10
        )
        .await
        .unwrap()
        .as_ref(),
        &[8]
    );
}

#[tokio::test]
async fn leases_cache_sources_local_budgets_and_events() {
    let host = host();
    let reference = content(&file(&host, "4").await);
    let lease = host
        .create_read_lease(CreateReadLeaseRequest { ttl_seconds: 60 })
        .await
        .unwrap();
    let media = host
        .media_url(MediaUrlRequest {
            file: reference.clone(),
            representation: FileRepresentation::Original,
            disposition: Disposition::Inline,
            filename: None,
            content_type: None,
            ttl_seconds: None,
            lease_id: Some(lease.id.clone()),
        })
        .await
        .unwrap();
    host.revoke_read_lease(lease.id.clone()).await.unwrap();
    assert_eq!(
        host.read_ticket(media.url, ReadOptions::default())
            .err()
            .unwrap()
            .code(),
        error_code::LEASE_EXPIRED
    );
    assert!(
        host.renew_read_lease(lease.id, CreateReadLeaseRequest { ttl_seconds: 60 })
            .await
            .is_err()
    );
    host.cache_put(
        "derived".into(),
        byte_stream(vec![1, 2]),
        "application/octet-stream".into(),
        CachePutMetadata {
            metadata: serde_json::Value::Null,
            sources: vec![reference.clone()],
        },
    )
    .await
    .unwrap();
    let hit = host
        .cache_lookup(CacheLookupRequest {
            keys: vec!["derived".into()],
        })
        .await
        .unwrap();
    assert_eq!(hit.hits.len(), 1);
    let local = host
        .local_url(LocalFileUrlRequest {
            file: reference,
            ttl_seconds: None,
            byte_budget: Some(3.into()),
            request_budget: Some(2),
            lease_id: None,
        })
        .await
        .unwrap();
    let response = host
        .read_ticket(local.url.clone(), ReadOptions::default())
        .unwrap();
    assert_eq!(response.status, 206);
    assert_eq!(response.headers["Content-Range"], "bytes 0-2/10");
    assert_eq!(collect_bytes(response.body, 3).await.unwrap().len(), 3);
    assert_eq!(
        host.read_ticket(local.url, ReadOptions::default())
            .err()
            .unwrap()
            .code(),
        error_code::QUOTA_EXCEEDED
    );
    host.change_node("4".into(), None, None, Some(vec![9]), None)
        .unwrap();
    assert!(
        host.cache_lookup(CacheLookupRequest {
            keys: vec!["derived".into()]
        })
        .await
        .unwrap()
        .hits
        .is_empty()
    );
    let mut events = host.events(None).await.unwrap();
    assert_eq!(
        events.next().await.unwrap().unwrap().event,
        event_name::SYNC_REQUIRED
    );
    let second = host.events(None).await.unwrap();
    assert_eq!(
        host.events(None).await.err().unwrap().code(),
        error_code::QUOTA_EXCEEDED
    );
    drop(second);
    drop(events);
    let page = host.fork(RuntimeCaller::Page);
    assert_eq!(
        page.keepalive(BackendKeepaliveRequest { ttl_seconds: 1 })
            .await
            .err()
            .unwrap()
            .code(),
        error_code::CALLER_NOT_ALLOWED
    );
}
