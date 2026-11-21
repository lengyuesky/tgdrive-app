//! 媒体／缓存票据统一使用同源路径，本机输入仍保留 loopback 绝对地址。
use tgdrive_backend_sdk::{HostClient, ReadOptions, byte_stream};
use tgdrive_contract::{
    Timestamp,
    data::*,
    files::*,
    manifest::FilePermissions,
    runtime::{AppIdentity, RuntimeCaller},
};
use tgdrive_test_host::{MemoryConfig, MemoryHost, SeedNode};

#[tokio::test]
async fn media_and_cache_tickets_are_relative_for_backend_and_page_callers() {
    for caller in [RuntimeCaller::Backend, RuntimeCaller::Page] {
        let host = MemoryHost::new(MemoryConfig {
            app: AppIdentity {
                id: "example".into(),
                name: "示例".into(),
                version: "1.0.0".into(),
                generation: "g1".into(),
            },
            files: FilePermissions {
                read: true,
                write: false,
                ..Default::default()
            },
            scope: DirectoryScope::All {
                access: AccessLevel::ReadOnly,
            },
            nodes: vec![SeedNode {
                id: "2".into(),
                parent_id: "1".into(),
                name: "文件.bin".into(),
                kind: NodeKind::File,
                bytes: vec![1, 2, 3],
                thumbnail: None,
            }],
            caller,
            now: Timestamp(1),
            has_backend: true,
        })
        .unwrap();
        let node = host
            .stat(NodeReference::Id {
                id: "2".into(),
                content_version: None,
            })
            .await
            .unwrap();
        let file = ContentRef {
            id: node.id,
            content_version: node.content_version.unwrap(),
        };
        let media = host
            .media_url(MediaUrlRequest {
                file: file.clone(),
                representation: FileRepresentation::Original,
                disposition: Disposition::Inline,
                filename: None,
                content_type: None,
                ttl_seconds: None,
                lease_id: None,
            })
            .await
            .unwrap();
        assert!(
            media
                .url
                .starts_with(&format!("{}/", MediaUrl::TICKET_BASE))
        );
        assert!(tgdrive_contract::validation::valid_same_origin_path(
            &media.url
        ));
        assert_eq!(
            host.read_ticket(media.url.clone(), ReadOptions::default())
                .unwrap()
                .status,
            200
        );
        assert!(
            host.read_ticket(
                format!("https://test.invalid{}", media.url),
                ReadOptions::default()
            )
            .is_err()
        );
        host.cache_put(
            "image".into(),
            byte_stream(vec![1, 2, 3]),
            "image/jpeg".into(),
            CachePutMetadata {
                metadata: serde_json::Value::Null,
                sources: vec![file.clone()],
            },
        )
        .await
        .unwrap();
        let lookup = host
            .cache_lookup(CacheLookupRequest {
                keys: vec!["image".into()],
            })
            .await
            .unwrap();
        let hit = &lookup.hits[0];
        assert!(hit.url.starts_with(&format!("{}/", CacheHit::TICKET_BASE)));
        assert!(tgdrive_contract::validation::valid_same_origin_path(
            &hit.url
        ));
        assert_eq!(
            host.read_ticket(hit.url.clone(), ReadOptions::default())
                .unwrap()
                .status,
            200
        );
        if caller == RuntimeCaller::Backend {
            assert_eq!(
                host.ticket_bytes(media.url.clone(), ReadOptions::default())
                    .await
                    .unwrap()
                    .status,
                200
            );
            assert_eq!(
                host.fork(RuntimeCaller::Backend)
                    .ticket_bytes(media.url.clone(), ReadOptions::default())
                    .await
                    .unwrap()
                    .status,
                200
            );
            assert_eq!(
                host.ticket_bytes(hit.url.clone(), ReadOptions::default())
                    .await
                    .unwrap()
                    .status,
                200
            );
            let page = host.fork(RuntimeCaller::Page);
            assert!(
                page.ticket_bytes(media.url.clone(), ReadOptions::default())
                    .await
                    .is_err()
            );
            let page_ticket = page
                .media_url(MediaUrlRequest {
                    file: file.clone(),
                    representation: FileRepresentation::Original,
                    disposition: Disposition::Inline,
                    filename: None,
                    content_type: None,
                    ttl_seconds: None,
                    lease_id: None,
                })
                .await
                .unwrap();
            assert!(
                host.ticket_bytes(page_ticket.url, ReadOptions::default())
                    .await
                    .is_err()
            );
            let local = host
                .local_url(LocalFileUrlRequest {
                    file,
                    ttl_seconds: None,
                    byte_budget: None,
                    request_budget: None,
                    lease_id: None,
                })
                .await
                .unwrap();
            assert!(local.url.starts_with("http://127.0.0.1:"));
            assert_eq!(
                host.read_ticket(local.url, ReadOptions::default())
                    .unwrap()
                    .status,
                200
            );
        }
    }
}
