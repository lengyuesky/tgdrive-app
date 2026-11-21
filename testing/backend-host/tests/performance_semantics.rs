use serde_json::json;
use tgdrive_backend_sdk::HostClient;
use tgdrive_contract::{
    Timestamp,
    data::{KvCondition, KvDeleteRequest, KvPutRequest},
    files::*,
    http::{MAX_KV_VALUE_BYTES, PAGE_CURSOR_SECONDS},
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

fn node(id: &str, parent: &str, name: &str, kind: NodeKind) -> SeedNode {
    SeedNode {
        id: id.into(),
        parent_id: parent.into(),
        name: name.into(),
        kind,
        bytes: Vec::new(),
        thumbnail: None,
    }
}
fn host() -> MemoryHost {
    MemoryHost::new(MemoryConfig {
        app: AppIdentity {
            id: "test".into(),
            name: "缓存语义测试".into(),
            version: "1.0.0".into(),
            generation: "g1".into(),
        },
        files: FilePermissions {
            read: true,
            write: true,
            ..Default::default()
        },
        scope: DirectoryScope::All {
            access: AccessLevel::ReadWrite,
        },
        nodes: vec![
            node("2", "1", "目录", NodeKind::Directory),
            node("3", "2", "alpha.txt", NodeKind::File),
            node("4", "2", "beta.txt", NodeKind::File),
            node("5", "2", "gamma.txt", NodeKind::File),
            node("6", "2", "omega.txt", NodeKind::File),
            node("10", "1", "其他", NodeKind::Directory),
        ],
        caller: RuntimeCaller::Backend,
        now: Timestamp(1),
        has_backend: true,
    })
    .unwrap()
}
fn query(cursor: Option<String>) -> FileQuery {
    FileQuery {
        roots: vec!["2".into()],
        recursive: true,
        filter: FileFilter {
            extensions: vec!["txt".into()],
            ..Default::default()
        },
        sort: NodeSort::Name,
        order: SortOrder::Asc,
        limit: 2,
        cursor,
    }
}

#[tokio::test]
async fn incremental_kv_usage_matches_actual_json_through_conflicts_and_deletes() {
    let host = host();
    let value = json!({"中文":"引号\"与反斜线\\", "nullable":null});
    let record = host
        .kv_put(
            "usage:key".into(),
            KvPutRequest {
                value: value.clone(),
                condition: KvCondition::Absent,
            },
        )
        .await
        .unwrap();
    let size = ("usage:key".len() + serde_json::to_vec(&value).unwrap().len()) as u64;
    assert_eq!(host.data_usage().await.unwrap().kv_bytes.0, size);
    assert!(
        host.kv_put(
            "usage:key".into(),
            KvPutRequest {
                value: json!("不覆盖"),
                condition: KvCondition::Absent
            }
        )
        .await
        .is_err()
    );
    assert_eq!(host.data_usage().await.unwrap().kv_bytes.0, size);
    let replaced = host
        .kv_put(
            "usage:key".into(),
            KvPutRequest {
                value: json!(null),
                condition: KvCondition::Revision {
                    revision: record.revision,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        host.data_usage().await.unwrap().kv_bytes.0,
        ("usage:key".len() + 4) as u64
    );
    assert!(
        host.kv_put(
            "too:large".into(),
            KvPutRequest {
                value: json!("x".repeat(MAX_KV_VALUE_BYTES as usize)),
                condition: KvCondition::Absent
            }
        )
        .await
        .is_err()
    );
    assert_eq!(
        host.data_usage().await.unwrap().kv_bytes.0,
        ("usage:key".len() + 4) as u64
    );
    host.kv_delete(
        "usage:key".into(),
        KvDeleteRequest {
            revision: replaced.revision,
        },
    )
    .await
    .unwrap();
    assert_eq!(host.data_usage().await.unwrap().kv_bytes.0, 0);
}

#[tokio::test]
async fn cached_pages_keep_current_metadata_and_old_last_keys_after_tree_changes() {
    let host = host();
    let first = host.query(query(None)).await.unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["3", "4"]
    );
    let cursor = first.next_cursor.clone().unwrap();
    host.add_node(node("7", "2", "aardvark.txt", NodeKind::File))
        .unwrap();
    let fresh = host.query(query(None)).await.unwrap();
    assert_eq!(
        fresh
            .items
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["7", "3"]
    );
    let next = host.query(query(Some(cursor.clone()))).await.unwrap();
    assert_eq!(
        next.items
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["5", "6"]
    );
    assert_eq!(next.scan_cursor, first.scan_cursor);
    host.change_node("5".into(), None, Some("aaaa.txt".into()), None, None)
        .unwrap();
    host.change_node("6".into(), None, None, None, Some(false))
        .unwrap();
    assert!(
        host.query(query(Some(cursor.clone())))
            .await
            .unwrap()
            .items
            .is_empty()
    );
    let fresh = host.query(query(None)).await.unwrap();
    assert_eq!(fresh.items[0].id, "5");
    host.advance(PAGE_CURSOR_SECONDS as i64 * 1000 + 1).unwrap();
    assert!(host.query(query(Some(cursor))).await.is_err());
}

#[tokio::test]
async fn direct_directory_matches_invalidate_when_image_moves_or_scope_revokes() {
    let host = host();
    host.add_node(node("8", "2", "image.png", NodeKind::File))
        .unwrap();
    let request = DirectoriesWithFilesQuery {
        roots: Vec::new(),
        file_filter: FileFilter {
            extensions: vec!["png".into()],
            ..Default::default()
        },
        directory_name_contains: None,
        sort: DirectorySort::Name,
        order: SortOrder::Asc,
        limit: 20,
        cursor: None,
    };
    assert_eq!(
        host.directories_with_files(request.clone())
            .await
            .unwrap()
            .items[0]
            .id,
        "2"
    );
    host.change_node("8".into(), Some("10".into()), None, None, None)
        .unwrap();
    assert_eq!(
        host.directories_with_files(request.clone())
            .await
            .unwrap()
            .items[0]
            .id,
        "10"
    );
    host.change_node("8".into(), None, Some("not-image.txt".into()), None, None)
        .unwrap();
    assert!(
        host.directories_with_files(request.clone())
            .await
            .unwrap()
            .items
            .is_empty()
    );
    host.set_scope(DirectoryScope::None).unwrap();
    assert!(host.directories_with_files(request).await.is_err());
}
